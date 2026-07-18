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
}

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
        sendJson(res, 401, { error: 'unauthorized' });
        return;
    }

    // GET /v1/events — the SSE subscription. Long-lived; never returns JSON.
    if (path === '/v1/events' && method === 'GET') {
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

/**
 * Authorize a request. Accepts the token two ways:
 *   - `Authorization: Bearer <token>` header (preferred for scripts/agents), or
 *   - `?token=<token>` query param (needed for EventSource, which can't set
 *     custom headers).
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
    if (!provided) {
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
function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(text),
    });
    res.end(text);
}
