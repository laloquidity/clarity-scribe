/**
 * Local API / Event Stream — the programmable seam for Clarity Scribe.
 *
 * This is the first brick of turning the dictation app into a voice layer that
 * external tools (scripts, agents, automations) can drive and observe. It runs
 * a tiny loopback-only HTTP server exposing:
 *   - a one-way Server-Sent Events stream of live transcription + state, and
 *   - a handful of JSON command/query endpoints (start/stop/status/history).
 *
 * WHY SSE instead of WebSockets: the only push direction we need is server→
 * client (partials, results, state). Commands travel the other way as plain
 * HTTP POSTs. SSE rides on stock Node `http` with zero dependencies, survives
 * proxies, and auto-reconnects in browsers — a WebSocket library would add a
 * dependency and duplex machinery we don't use.
 *
 * WHY dependency injection: every Electron-specific capability (token storage,
 * recording control, status, history) is passed in as a plain function via
 * `LocalApiConfig`. That keeps this module import-free of `electron`/
 * `electron-store` so it can be unit-tested against a real socket with plain
 * fakes — no Electron runtime required.
 *
 * Security posture: binds 127.0.0.1 only (never reachable off-box) and requires
 * a bearer token on EVERY request, including the SSE stream. The token is
 * generated once on first start and persisted by the host via the injected
 * `setToken` callback.
 */

import * as http from 'http';
import * as crypto from 'crypto';
import { parseBoundary, parseMultipart, fieldValue, findPart } from './multipart';

export interface LocalApiConfig {
    /** TCP port to bind on 127.0.0.1. Defaults to 5111. Pass 0 for an
     *  ephemeral OS-assigned port (used by tests). */
    port?: number;
    /** Returns the persisted API token, or null if none has been issued yet. */
    getToken: () => string | null;
    /** Persists a freshly generated token (called once, on first start). */
    setToken: (t: string) => void;
    /** Begins recording. Returns false if already recording → HTTP 409. */
    startRecording: () => boolean;
    /** Stops recording. Returns false if not recording → HTTP 409. */
    stopRecording: () => boolean;
    /** Snapshot for GET /v1/status. */
    getStatus: () => { recording: boolean; engine: string; version: string };
    /** Recent history entries, newest-first, capped at `limit`. */
    getHistory: (limit: number) => any[];
    /** Optional: run a TEXT command through the command-mode pipeline (as if it
     *  had been spoken). Stages stream over SSE; the promise resolves with the
     *  terminal stage. Absent → POST /v1/command returns 501. */
    runCommand?: (text: string) => Promise<any>;
    /** Optional: transcribe an uploaded audio file. Absent → POST
     *  /v1/audio/transcriptions returns 501. Reject with an Error carrying a
     *  numeric `status` property to choose the HTTP code (see `httpError`);
     *  anything else becomes a 500. */
    transcribeFile?: (req: FileTranscriptionRequest) => Promise<FileTranscriptionResult>;
    /** Largest upload accepted by /v1/audio/transcriptions, in bytes.
     *  Defaults to 25 MB — the same ceiling OpenAI's endpoint uses, which is
     *  what client apps built against this contract already expect. */
    maxUploadBytes?: number;
}

/** An audio file handed to the host for transcription. */
export interface FileTranscriptionRequest {
    /** Raw bytes of the uploaded file. */
    bytes: Buffer;
    /** Client-supplied filename, used for format detection and error text. */
    filename?: string;
    /** ISO-639-1 language code the caller asked for, if any. */
    language?: string;
    /** The `model` form field verbatim. Scribe records it but does not switch
     *  engines on it — see the docs for why. */
    model?: string;
}

/** What the host gives back. Only `text` is required by the wire contract. */
export interface FileTranscriptionResult {
    text: string;
    /** Audio length in seconds, surfaced only in `verbose_json`. */
    durationSec?: number;
    /** Language actually used, surfaced only in `verbose_json`. */
    language?: string;
}

/**
 * Build an Error that maps to a specific HTTP status on the way out.
 *
 * The host (main.ts) uses this so "a dictation is already running" becomes a
 * 409 the caller can retry, rather than an opaque 500 that reads like a bug.
 */
export function httpError(status: number, message: string): Error & { status: number } {
    return Object.assign(new Error(message), { status });
}

/**
 * The OpenAI-compatible transcription route.
 *
 * Kept as a named constant because three things key off it: the route table,
 * the error-body shape (this path answers in OpenAI's `{error:{message}}`
 * envelope, every other path keeps Scribe's original flat `{error:"..."}` so
 * existing clients are untouched), and the upload size guard.
 */
const TRANSCRIPTIONS_PATH = '/v1/audio/transcriptions';

/** The SSE route — the one place a query-string token is accepted. */
const EVENTS_PATH = '/v1/events';

/** Default upload ceiling: 25 MB, matching the contract clients already target. */
const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** How often we push an SSE heartbeat comment. Idle proxies and some OS socket
 *  layers drop connections with no traffic; a lightweight comment line keeps
 *  the pipe warm without being parsed as an event by clients. */
const HEARTBEAT_MS = 15_000;

/** Default loopback port. Chosen high/uncommon to avoid clashing with dev
 *  servers; overridable via config for embedding or tests. */
const DEFAULT_PORT = 5111;

// --- Module singleton state ---------------------------------------------------
// The API is a process-wide singleton (one dictation app → one control surface),
// so state lives at module scope rather than in a class instance. This also lets
// `emitEvent` be a free function the rest of main.ts can call without threading a
// handle through every call site.
let server: http.Server | null = null;
let config: LocalApiConfig | null = null;
let activeToken: string | null = null;
let heartbeat: NodeJS.Timeout | null = null;

/** Live SSE connections. We hold the raw responses so `emitEvent` can fan a
 *  single event out to every subscriber. */
const sseClients = new Set<http.ServerResponse>();

/**
 * Start the local API server.
 *
 * Idempotent-ish: if already running, resolves with the existing port/token
 * rather than binding twice. On first start with no persisted token, generates
 * a cryptographically-random one and hands it to `setToken` for persistence.
 *
 * Resolves only after the socket is actually listening, and reports the REAL
 * bound port — important when `port: 0` is used, so callers (and tests) learn
 * the OS-assigned port.
 */
export function startLocalApi(cfg: LocalApiConfig): Promise<{ port: number; token: string }> {
    return new Promise((resolve, reject) => {
        if (server) {
            // Already up — don't double-bind; report the live instance.
            const addr = server.address();
            const port = typeof addr === 'object' && addr ? addr.port : (cfg.port ?? DEFAULT_PORT);
            resolve({ port, token: activeToken ?? '' });
            return;
        }

        config = cfg;

        // Issue-once token: reuse the persisted one across restarts so existing
        // clients keep working; only mint (and persist) a new one if absent.
        let token = cfg.getToken();
        if (!token) {
            token = crypto.randomBytes(32).toString('hex');
            cfg.setToken(token);
        }
        activeToken = token;

        const srv = http.createServer(handleRequest);

        // Surface bind failures (e.g. port in use) to the caller instead of
        // leaving the promise hanging.
        srv.on('error', (err) => {
            server = null;
            config = null;
            activeToken = null;
            reject(err);
        });

        const port = cfg.port ?? DEFAULT_PORT;
        // Loopback only: 127.0.0.1 guarantees the control surface is never
        // reachable from other machines on the network.
        srv.listen(port, '127.0.0.1', () => {
            server = srv;
            const addr = srv.address();
            const boundPort = typeof addr === 'object' && addr ? addr.port : port;

            // Single shared heartbeat timer for all clients — cheaper than one
            // per connection and unref'd so it never keeps the process alive.
            heartbeat = setInterval(sendHeartbeat, HEARTBEAT_MS);
            heartbeat.unref?.();

            resolve({ port: boundPort, token: token! });
        });
    });
}

/**
 * Stop the server, close all SSE streams, and reset module state so a later
 * `startLocalApi` starts clean.
 */
export function stopLocalApi(): Promise<void> {
    return new Promise((resolve) => {
        if (heartbeat) {
            clearInterval(heartbeat);
            heartbeat = null;
        }

        // End every SSE response so `server.close` isn't held open by live
        // connections (close waits for in-flight requests to finish).
        for (const client of sseClients) {
            try { client.end(); } catch { /* already gone */ }
        }
        sseClients.clear();

        const srv = server;
        server = null;
        config = null;
        activeToken = null;

        if (!srv) {
            resolve();
            return;
        }
        srv.close(() => resolve());
    });
}

/** Whether the server is currently listening. */
export function isRunning(): boolean {
    return server !== null;
}

/**
 * Broadcast an event to every connected SSE client.
 *
 * Stamps a `ts` (epoch ms) if the caller didn't supply one, so downstream
 * consumers always get an ordering/latency reference. No-ops when nothing is
 * listening, so call sites can fire unconditionally without guarding.
 */
export function emitEvent(evt: { type: string; [k: string]: any }): void {
    if (sseClients.size === 0) return;
    const payload = { ...evt, ts: evt.ts ?? Date.now() };
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of sseClients) {
        // A dead socket can throw mid-write; drop it rather than crash the
        // broadcast for healthy peers.
        try {
            client.write(frame);
        } catch {
            sseClients.delete(client);
        }
    }
}

// --- Request routing ----------------------------------------------------------

/**
 * Central request handler. Enforces auth first (fail closed), then routes.
 * Every response is JSON except the SSE stream, which upgrades to
 * text/event-stream and stays open.
 */
function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const cfg = config;
    if (!cfg) {
        // Shutting down mid-request — nothing to serve.
        sendJson(res, 503, { error: 'server_unavailable' });
        return;
    }

    // Parse once; `req.url` is always a path+query (never absolute) for plain
    // HTTP servers, so a fixed base is fine.
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const path = url.pathname;
    const method = req.method || 'GET';

    // Auth gate — applies to EVERY route including the event stream. Fail
    // closed: no token, wrong token, or malformed header → 401.
    if (!isAuthorized(req, url, cfg)) {
        // The OpenAI-compatible route answers in that ecosystem's error
        // envelope even for auth, because its clients read `error.message` and
        // show it to a human. Every other route keeps the original flat shape.
        if (path === TRANSCRIPTIONS_PATH) {
            sendOpenAiError(res, 401, 'Invalid API key. Copy the token from Clarity Scribe → Settings → Local API and send it in the header "Authorization: Bearer <token>".', 'invalid_request_error');
        } else {
            sendJson(res, 401, { error: 'unauthorized' });
        }
        return;
    }

    // POST /v1/audio/transcriptions — OpenAI-compatible file transcription.
    if (path === TRANSCRIPTIONS_PATH && method === 'POST') {
        handleTranscriptionUpload(req, res, cfg);
        return;
    }

    // Same path, wrong verb: say so explicitly. A caller that lands here with a
    // GET has usually pasted the URL into a browser to check the setup.
    if (path === TRANSCRIPTIONS_PATH) {
        sendOpenAiError(res, 405, `${method} is not supported on ${TRANSCRIPTIONS_PATH}. Send a POST with a multipart/form-data body.`, 'invalid_request_error');
        return;
    }

    // GET /v1/events — the SSE subscription. Long-lived; never returns JSON.
    if (path === EVENTS_PATH && method === 'GET') {
        openSseStream(req, res, cfg);
        return;
    }

    // POST /v1/record/start — 409 if the injected callback reports already-on.
    if (path === '/v1/record/start' && method === 'POST') {
        const ok = cfg.startRecording();
        sendJson(res, ok ? 200 : 409, ok ? { ok: true } : { ok: false, error: 'already_recording' });
        return;
    }

    // POST /v1/record/stop — 409 if not currently recording.
    if (path === '/v1/record/stop' && method === 'POST') {
        const ok = cfg.stopRecording();
        sendJson(res, ok ? 200 : 409, ok ? { ok: true } : { ok: false, error: 'not_recording' });
        return;
    }

    // POST /v1/command {text} — run a text command through the command-mode
    // pipeline (routing → confirmation gate → execution). Stages stream over
    // SSE; the response carries the terminal stage. Lets agents trigger the
    // same actions a spoken command would, without audio.
    if (path === '/v1/command' && method === 'POST') {
        if (!cfg.runCommand) {
            sendJson(res, 501, { ok: false, error: 'command_mode_unavailable' });
            return;
        }
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            let text = '';
            try { text = String(JSON.parse(body || '{}').text || ''); } catch { /* fall through */ }
            if (!text.trim()) {
                sendJson(res, 400, { ok: false, error: 'missing_text' });
                return;
            }
            cfg.runCommand!(text).then(
                (end) => sendJson(res, 200, { ok: true, result: end }),
                (e) => sendJson(res, 500, { ok: false, error: String(e?.message || e) })
            );
        });
        return;
    }

    // GET /v1/status — cheap synchronous snapshot.
    if (path === '/v1/status' && method === 'GET') {
        sendJson(res, 200, cfg.getStatus());
        return;
    }

    // GET /v1/history?limit=N — recent entries. Clamp the limit so a hostile or
    // fat-fingered caller can't ask for a pathological slice.
    if (path === '/v1/history' && method === 'GET') {
        const raw = parseInt(url.searchParams.get('limit') || '20', 10);
        const limit = Number.isFinite(raw) ? Math.max(1, Math.min(raw, 200)) : 20;
        sendJson(res, 200, { entries: cfg.getHistory(limit) });
        return;
    }

    // Everything else — JSON 404 (never an HTML error page).
    sendJson(res, 404, { error: 'not_found', path });
}

// --- POST /v1/audio/transcriptions -------------------------------------------

/**
 * Transcribe an uploaded audio file.
 *
 * WHY this shape: it is the OpenAI audio-transcription contract, which the
 * whole transcription ecosystem has copied. An app that already speaks it needs
 * no new code to use Scribe — the owner pastes a base URL and a token into a
 * settings screen and the existing client works. Deviating "because ours is
 * nicer" would cost every integrator a code change, which is the entire thing
 * this endpoint exists to avoid.
 *
 * The work itself is delegated to the injected `transcribeFile`; everything
 * here is wire protocol — read the body under a cap, pull the parts out, pick a
 * response shape, and turn failures into messages a human can act on.
 */
function handleTranscriptionUpload(req: http.IncomingMessage, res: http.ServerResponse, cfg: LocalApiConfig): void {
    if (!cfg.transcribeFile) {
        sendOpenAiError(res, 501, 'This build of Clarity Scribe cannot transcribe uploaded files.', 'invalid_request_error');
        return;
    }

    const boundary = parseBoundary(req.headers['content-type']);
    if (!boundary) {
        sendOpenAiError(res, 400, 'Expected a multipart/form-data body with a boundary. Send the audio as a file upload, not as raw bytes or JSON.', 'invalid_request_error');
        return;
    }

    const maxBytes = cfg.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
    const maxMb = Math.round(maxBytes / (1024 * 1024));

    // Refuse an oversized upload from the header alone, before a byte of it
    // crosses the wire. Content-Length can lie or be absent (chunked encoding),
    // so readBody enforces the same ceiling again while reading.
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
        rejectOversized(req, res, `The upload is ${(declared / (1024 * 1024)).toFixed(1)} MB, over the ${maxMb} MB limit. Re-encode the recording at a lower bitrate (mono, 32-64 kbps is plenty for speech) or split it.`);
        return;
    }

    readBody(req, maxBytes, (err, body) => {
        if (err === 'too_large') {
            rejectOversized(req, res, `The upload is over the ${maxMb} MB limit. Re-encode the recording at a lower bitrate (mono, 32-64 kbps is plenty for speech) or split it.`);
            return;
        }
        if (err || !body) {
            sendOpenAiError(res, 400, 'The upload ended before it was complete.', 'invalid_request_error');
            return;
        }

        let parts;
        try {
            parts = parseMultipart(body, boundary);
        } catch (e: any) {
            sendOpenAiError(res, 400, String(e?.message || 'Could not read the multipart body.'), 'invalid_request_error');
            return;
        }

        const filePart = findPart(parts, 'file');
        if (!filePart || filePart.data.length === 0) {
            sendOpenAiError(res, 400, 'No audio was uploaded: the request has no "file" part (or it is empty).', 'invalid_request_error');
            return;
        }

        // `response_format` decides the envelope, not the work. Default to
        // `json` so a caller that omits it still gets the documented shape.
        const responseFormat = (fieldValue(parts, 'response_format') || 'json').toLowerCase();
        if (!['json', 'text', 'verbose_json'].includes(responseFormat)) {
            sendOpenAiError(res, 400, `response_format "${responseFormat}" is not supported. Use "json", "text" or "verbose_json". Scribe does not produce timestamped subtitle formats.`, 'invalid_request_error');
            return;
        }

        cfg.transcribeFile!({
            bytes: filePart.data,
            filename: filePart.filename,
            language: fieldValue(parts, 'language') || undefined,
            model: fieldValue(parts, 'model') || undefined,
        }).then(
            (result) => {
                const text = result?.text ?? '';
                if (responseFormat === 'text') {
                    sendText(res, 200, text);
                    return;
                }
                if (responseFormat === 'verbose_json') {
                    sendJson(res, 200, {
                        task: 'transcribe',
                        language: result.language ?? null,
                        duration: result.durationSec ?? null,
                        text,
                    });
                    return;
                }
                sendJson(res, 200, { text });
            },
            (e: any) => {
                // A status the host attached (busy, not ready, bad audio) is a
                // deliberate answer; anything else is an unexpected failure.
                const status = typeof e?.status === 'number' ? e.status : 500;
                const message = String(e?.message || 'Transcription failed.');
                const type = status === 429 || status === 409 ? 'rate_limit_error'
                    : status >= 500 ? 'server_error'
                        : 'invalid_request_error';
                sendOpenAiError(res, status, message, type);
            }
        );
    });
}

/**
 * Refuse an over-sized upload with a 413 the client can actually read.
 *
 * WHY drain instead of destroy: killing the socket the moment we decide to
 * refuse discards the response along with it, and the caller sees a connection
 * reset rather than the message explaining the limit — the one thing they most
 * need. So we answer, ask for the connection to close, and then let the rest of
 * the upload arrive and be thrown away (`resume` with no `data` listener
 * discards it, so nothing accumulates in memory) while the client finishes
 * sending and reads its reply.
 */
function rejectOversized(req: http.IncomingMessage, res: http.ServerResponse, message: string): void {
    sendJson(
        res,
        413,
        { error: { message, type: 'invalid_request_error', param: null, code: null } },
        { Connection: 'close' }
    );
    req.resume();
}

/**
 * Buffer a request body, refusing anything past `maxBytes`.
 *
 * The cap is enforced on the running total rather than on Content-Length alone,
 * so a client that under-declares its length (or uses chunked encoding) cannot
 * push the process into swap. Chunks are collected and concatenated once, which
 * keeps a 25 MB upload to a single copy.
 */
function readBody(
    req: http.IncomingMessage,
    maxBytes: number,
    done: (err: 'too_large' | 'aborted' | null, body: Buffer | null) => void
): void {
    const chunks: Buffer[] = [];
    let total = 0;
    let finished = false;

    const finish = (err: 'too_large' | 'aborted' | null, body: Buffer | null) => {
        if (finished) return; // a socket can emit both 'aborted' and 'error'
        finished = true;
        done(err, body);
    };

    req.on('data', (chunk: Buffer) => {
        if (finished) return;
        total += chunk.length;
        if (total > maxBytes) {
            finish('too_large', null);
            return;
        }
        chunks.push(chunk);
    });
    req.on('end', () => finish(null, Buffer.concat(chunks, total)));
    req.on('aborted', () => finish('aborted', null));
    req.on('error', () => finish('aborted', null));
}

/**
 * Write an error in OpenAI's envelope: `{"error":{"message":…}}`.
 *
 * Clients built against that contract surface `error.message` to the user
 * verbatim, so the message must be a complete, actionable sentence — never a
 * bare code. Status text is duplicated into `code` for clients that switch on
 * it.
 */
function sendOpenAiError(res: http.ServerResponse, status: number, message: string, type: string): void {
    sendJson(res, status, { error: { message, type, param: null, code: null } });
}

/** Plain-text response, used only by `response_format=text`. */
function sendText(res: http.ServerResponse, status: number, text: string): void {
    const body = Buffer.from(text, 'utf8');
    res.writeHead(status, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': body.length,
    });
    res.end(body);
}

/**
 * Authorize a request. Accepts the token two ways:
 *   - `Authorization: Bearer <token>` header — every route, and the only form
 *     most routes accept; or
 *   - `?token=<token>` query param — ONLY on the event stream, because
 *     EventSource cannot set custom headers.
 *
 * WHY the query form is confined to one route: a token in a URL ends up in
 * places a header never does — shell history, proxy and server logs, a
 * browser's history, a pasted link. The event stream has no alternative; no
 * other route needs to accept that risk.
 *
 * Uses a constant-time compare to avoid leaking the token via timing.
 */
function isAuthorized(req: http.IncomingMessage, url: URL, cfg: LocalApiConfig): boolean {
    const expected = cfg.getToken();
    if (!expected) return false; // No token issued → nothing is authorized.

    let provided: string | null = null;
    const auth = req.headers['authorization'];
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
        provided = auth.slice('Bearer '.length).trim();
    }
    if (!provided && url.pathname === EVENTS_PATH) {
        provided = url.searchParams.get('token');
    }
    if (!provided) return false;

    return timingSafeEqual(provided, expected);
}

/** Length-safe constant-time string comparison. `crypto.timingSafeEqual`
 *  throws on length mismatch, so we guard that first (a mismatched length is
 *  already a definitive "no", and leaking length is not sensitive here). */
function timingSafeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
}

/**
 * Upgrade a request to a Server-Sent Events stream and register it for
 * broadcasts. Immediately sends a `hello` event so the client can confirm the
 * pipe and learn the app version.
 */
function openSseStream(req: http.IncomingMessage, res: http.ServerResponse, cfg: LocalApiConfig): void {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        // Disable proxy buffering (nginx honors this) so events flush live.
        'X-Accel-Buffering': 'no',
    });

    // Prime the stream: a comment line flushes headers on some stacks, and a
    // `hello` gives the client an immediate, actionable first event.
    res.write(': connected\n\n');
    const version = safeVersion(cfg);
    res.write(`data: ${JSON.stringify({ type: 'hello', version, ts: Date.now() })}\n\n`);

    sseClients.add(res);

    // Reclaim the slot when the client disconnects (browser tab close, script
    // exit, network drop) so we don't write into dead sockets forever.
    req.on('close', () => {
        sseClients.delete(res);
    });
}

/** Best-effort app version for the `hello` event — never let a throwing status
 *  callback tear down a new subscription. */
function safeVersion(cfg: LocalApiConfig): string {
    try {
        return cfg.getStatus().version;
    } catch {
        return 'unknown';
    }
}

/** Push a heartbeat comment to keep idle connections alive. Comments (lines
 *  starting with `:`) are ignored by SSE parsers, so they never surface as
 *  events. */
function sendHeartbeat(): void {
    for (const client of sseClients) {
        try {
            client.write(': ping\n\n');
        } catch {
            sseClients.delete(client);
        }
    }
}

/** Write a JSON response with the given status. Central so every non-stream
 *  route stays consistent (content-type, serialization). */
function sendJson(res: http.ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
    const text = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(text),
        ...extraHeaders,
    });
    res.end(text);
}
