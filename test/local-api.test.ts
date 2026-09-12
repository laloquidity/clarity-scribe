/**
 * Local API integration tests.
 *
 * These exercise the REAL http server over a real loopback socket (never a
 * mocked one) on an ephemeral port (`port: 0`), so they cover the exact wire
 * behavior a script or agent will hit: auth, JSON routes, the 409 conflict
 * paths, history clamping, the SSE stream, and clean shutdown.
 *
 * Electron is never imported — every host capability is a plain fake passed via
 * config, which is the whole point of the module's dependency-injection design.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import {
    startLocalApi,
    stopLocalApi,
    emitEvent,
    isRunning,
    httpError,
    type LocalApiConfig,
    type FileTranscriptionRequest,
} from '../electron/localApi';

// --- Test harness -------------------------------------------------------------

/** Mutable fake host state the API drives via injected callbacks. Each test
 *  gets a fresh one so start/stop and history are isolated. */
interface Fake {
    token: string | null;
    recording: boolean;
    history: any[];
    cfg: LocalApiConfig;
}

function makeFake(overrides: Partial<LocalApiConfig> = {}): Fake {
    const state: Fake = {
        token: null,
        recording: false,
        history: [],
        cfg: null as any,
    };

    state.cfg = {
        port: 0, // ephemeral — the OS picks a free port, we read it back
        getToken: () => state.token,
        setToken: (t: string) => { state.token = t; },
        startRecording: () => {
            if (state.recording) return false; // already on → 409
            state.recording = true;
            return true;
        },
        stopRecording: () => {
            if (!state.recording) return false; // not on → 409
            state.recording = false;
            return true;
        },
        getStatus: () => ({
            recording: state.recording,
            engine: 'parakeet',
            version: '9.9.9-test',
        }),
        getHistory: (limit: number) => state.history.slice(0, limit),
        ...overrides,
    };

    return state;
}

let baseUrl = '';
let token = '';
let fake: Fake;

async function boot(f: Fake): Promise<void> {
    fake = f;
    const { port, token: t } = await startLocalApi(f.cfg);
    baseUrl = `http://127.0.0.1:${port}`;
    token = t;
}

beforeEach(() => {
    // Fresh fake per test; the actual server is booted inside each test after
    // any per-test config tweaks.
});

afterEach(async () => {
    await stopLocalApi();
    baseUrl = '';
    token = '';
});

/** Small fetch helper that attaches the bearer token by default. */
function api(path: string, init: RequestInit = {}, withToken = true): Promise<Response> {
    const headers = new Headers(init.headers);
    if (withToken) headers.set('Authorization', `Bearer ${token}`);
    return fetch(`${baseUrl}${path}`, { ...init, headers });
}

// --- Startup / token ----------------------------------------------------------

describe('startup and token issuance', () => {
    it('generates and persists a token on first start', async () => {
        const f = makeFake();
        expect(f.token).toBeNull();
        await boot(f);
        expect(isRunning()).toBe(true);
        expect(token).toHaveLength(64); // 32 random bytes as hex
        expect(f.token).toBe(token);    // persisted via setToken
    });

    it('reuses an already-persisted token instead of minting a new one', async () => {
        const f = makeFake();
        f.token = 'preexisting-token-value';
        await boot(f);
        expect(token).toBe('preexisting-token-value');
    });
});

// --- Auth ---------------------------------------------------------------------

describe('authentication', () => {
    beforeEach(async () => { await boot(makeFake()); });

    it('rejects requests with no token (401)', async () => {
        const res = await api('/v1/status', {}, false);
        expect(res.status).toBe(401);
        const body = await res.json();
        expect(body.error).toBe('unauthorized');
    });

    it('rejects requests with a wrong token (401)', async () => {
        const res = await fetch(`${baseUrl}/v1/status`, {
            headers: { Authorization: 'Bearer not-the-real-token' },
        });
        expect(res.status).toBe(401);
    });

    it('accepts a query-string token on the event stream (EventSource cannot send headers)', async () => {
        const ctrl = new AbortController();
        const res = await fetch(`${baseUrl}/v1/events?token=${token}`, { signal: ctrl.signal });
        expect(res.status).toBe(200);
        ctrl.abort();
    });

    it('rejects a query-string token on every other route', async () => {
        // A token in a URL leaks into shell history, logs and pasted links; only
        // the event stream has no alternative, so only it accepts one.
        const status = await fetch(`${baseUrl}/v1/status?token=${token}`);
        expect(status.status).toBe(401);

        const history = await fetch(`${baseUrl}/v1/history?token=${token}`);
        expect(history.status).toBe(401);

        const start = await fetch(`${baseUrl}/v1/record/start?token=${token}`, { method: 'POST' });
        expect(start.status).toBe(401);
        expect(fake.recording).toBe(false);
    });

    it('accepts the token via Authorization header', async () => {
        const res = await api('/v1/status');
        expect(res.status).toBe(200);
    });
});

// --- Status -------------------------------------------------------------------

describe('GET /v1/status', () => {
    it('returns the injected status snapshot', async () => {
        await boot(makeFake());
        const res = await api('/v1/status');
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ recording: false, engine: 'parakeet', version: '9.9.9-test' });
    });

    it('reflects recording state after start', async () => {
        await boot(makeFake());
        await api('/v1/record/start', { method: 'POST' });
        const body = await (await api('/v1/status')).json();
        expect(body.recording).toBe(true);
    });
});

// --- Record start/stop + 409 conflict paths ----------------------------------

describe('POST /v1/record/start and /stop', () => {
    beforeEach(async () => { await boot(makeFake()); });

    it('starts recording via the injected callback (200)', async () => {
        const res = await api('/v1/record/start', { method: 'POST' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
        expect(fake.recording).toBe(true);
    });

    it('returns 409 when starting while already recording', async () => {
        await api('/v1/record/start', { method: 'POST' });
        const res = await api('/v1/record/start', { method: 'POST' });
        expect(res.status).toBe(409);
        expect((await res.json()).error).toBe('already_recording');
    });

    it('stops recording via the injected callback (200)', async () => {
        await api('/v1/record/start', { method: 'POST' });
        const res = await api('/v1/record/stop', { method: 'POST' });
        expect(res.status).toBe(200);
        expect(fake.recording).toBe(false);
    });

    it('returns 409 when stopping while not recording', async () => {
        const res = await api('/v1/record/stop', { method: 'POST' });
        expect(res.status).toBe(409);
        expect((await res.json()).error).toBe('not_recording');
    });
});

// --- History ------------------------------------------------------------------

describe('GET /v1/history', () => {
    it('honors the limit and returns entries newest-first', async () => {
        const f = makeFake();
        f.history = [
            { id: '1', text: 'one' },
            { id: '2', text: 'two' },
            { id: '3', text: 'three' },
        ];
        await boot(f);

        const res = await api('/v1/history?limit=2');
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.entries).toHaveLength(2);
        expect(body.entries[0].id).toBe('1');
    });

    it('defaults to 20 when no limit is given', async () => {
        const f = makeFake();
        f.history = Array.from({ length: 50 }, (_, i) => ({ id: String(i) }));
        await boot(f);
        const body = await (await api('/v1/history')).json();
        expect(body.entries).toHaveLength(20);
    });
});

// --- SSE stream ---------------------------------------------------------------

describe('GET /v1/events (SSE)', () => {
    /**
     * Read an SSE stream over raw http and collect parsed `data:` JSON events
     * until `wantCount` have arrived or the timeout fires. Raw http (not fetch)
     * keeps the streaming read simple and synchronous to reason about.
     */
    function collectEvents(pathWithToken: string, wantCount: number, timeoutMs = 3000): Promise<{ req: http.ClientRequest; events: any[] }> {
        return new Promise((resolve, reject) => {
            const events: any[] = [];
            const req = http.get(`${baseUrl}${pathWithToken}`, (res) => {
                if (res.statusCode !== 200) {
                    reject(new Error(`unexpected status ${res.statusCode}`));
                    return;
                }
                let buffer = '';
                res.setEncoding('utf8');
                res.on('data', (chunk: string) => {
                    buffer += chunk;
                    // SSE frames are separated by a blank line; parse complete
                    // frames and keep any partial tail for the next chunk.
                    let idx: number;
                    while ((idx = buffer.indexOf('\n\n')) !== -1) {
                        const frame = buffer.slice(0, idx);
                        buffer = buffer.slice(idx + 2);
                        for (const line of frame.split('\n')) {
                            if (line.startsWith('data:')) {
                                events.push(JSON.parse(line.slice('data:'.length).trim()));
                            }
                        }
                    }
                    if (events.length >= wantCount) {
                        resolve({ req, events });
                    }
                });
            });
            req.on('error', reject);
            setTimeout(() => reject(new Error(`timed out with ${events.length} events`)), timeoutMs);
        });
    }

    it('sends a hello event on connect and receives emitted events', async () => {
        await boot(makeFake());

        // Subscribe, then emit once the stream is live. We want: hello, partial,
        // result, state = 4 events.
        const collector = collectEvents(`/v1/events?token=${token}`, 4);

        // Give the connection a beat to register before broadcasting, otherwise
        // emitEvent would no-op with zero clients.
        await new Promise((r) => setTimeout(r, 150));
        emitEvent({ type: 'partial', text: 'hel' });
        emitEvent({ type: 'result', text: 'hello world' });
        emitEvent({ type: 'state', state: 'IDLE' });

        const { req, events } = await collector;
        req.destroy(); // close the client so shutdown is instant

        expect(events[0].type).toBe('hello');
        expect(events[0].version).toBe('9.9.9-test');
        expect(events[0].ts).toBeTypeOf('number');

        const partial = events.find((e) => e.type === 'partial');
        expect(partial.text).toBe('hel');
        expect(partial.ts).toBeTypeOf('number'); // ts stamped by emitEvent

        expect(events.find((e) => e.type === 'result').text).toBe('hello world');
        expect(events.find((e) => e.type === 'state').state).toBe('IDLE');
    });

    it('rejects an unauthenticated SSE subscription (401)', async () => {
        await boot(makeFake());
        const res = await fetch(`${baseUrl}/v1/events`);
        expect(res.status).toBe(401);
        // Drain so the socket closes cleanly.
        await res.text();
    });
});

// --- Unknown routes -----------------------------------------------------------

describe('unknown routes', () => {
    it('returns a JSON 404', async () => {
        await boot(makeFake());
        const res = await api('/v1/nope');
        expect(res.status).toBe(404);
        expect(res.headers.get('content-type')).toContain('application/json');
        const body = await res.json();
        expect(body.error).toBe('not_found');
    });
});

// --- Shutdown -----------------------------------------------------------------

describe('stopLocalApi', () => {
    it('closes the server so the port stops accepting connections', async () => {
        await boot(makeFake());
        const url = baseUrl;
        const tok = token;
        expect(isRunning()).toBe(true);

        await stopLocalApi();
        expect(isRunning()).toBe(false);

        // A follow-up request must fail to connect now that the socket is closed.
        await expect(
            fetch(`${url}/v1/status`, { headers: { Authorization: `Bearer ${tok}` } })
        ).rejects.toThrow();
    });
});

// --- POST /v1/audio/transcriptions -------------------------------------------

/**
 * The OpenAI-compatible file-transcription endpoint.
 *
 * The point of this route is that an app already written against that contract
 * works against Scribe with no code changes — so these tests assert the WIRE
 * SHAPE as strictly as the behavior: the exact success body, and the exact
 * `{error:{message}}` envelope on every failure, because a client that shows
 * `error.message` to a human gets a status code instead when we get it wrong.
 *
 * The transcription itself is a fake here. What actually decodes and
 * transcribes is covered in file-transcription.test.ts.
 */

const UPLOAD_BOUNDARY = '----ScribeApiTest3x9Qz';

/** Build a multipart body the way an OpenAI-compatible client would. */
function uploadBody(fields: {
    file?: { bytes: Buffer; filename: string; contentType?: string };
    model?: string;
    response_format?: string;
    language?: string;
}): Buffer {
    const chunks: Buffer[] = [];
    const push = (name: string, value: string) => {
        chunks.push(Buffer.from(
            `--${UPLOAD_BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
            'latin1'
        ));
    };

    if (fields.file) {
        chunks.push(Buffer.from(
            `--${UPLOAD_BOUNDARY}\r\n` +
            `Content-Disposition: form-data; name="file"; filename="${fields.file.filename}"\r\n` +
            `Content-Type: ${fields.file.contentType ?? 'application/octet-stream'}\r\n\r\n`,
            'latin1'
        ));
        chunks.push(fields.file.bytes);
        chunks.push(Buffer.from('\r\n', 'latin1'));
    }
    if (fields.model !== undefined) push('model', fields.model);
    if (fields.response_format !== undefined) push('response_format', fields.response_format);
    if (fields.language !== undefined) push('language', fields.language);

    chunks.push(Buffer.from(`--${UPLOAD_BOUNDARY}--\r\n`, 'latin1'));
    return Buffer.concat(chunks);
}

/** POST an upload to the endpoint. */
function postUpload(body: Buffer, withToken = true, contentType?: string): Promise<Response> {
    return api('/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Content-Type': contentType ?? `multipart/form-data; boundary=${UPLOAD_BOUNDARY}` },
        body: body as unknown as BodyInit,
    }, withToken);
}

/** Bytes that pass as a small audio file. */
const AUDIO = (() => {
    const buf = Buffer.alloc(2048, 0x33);
    buf.write('RIFF', 0, 'latin1');
    buf.write('WAVE', 8, 'latin1');
    return buf;
})();

describe('POST /v1/audio/transcriptions', () => {
    let seen: FileTranscriptionRequest[];

    /** Boot with a fake transcriber that records what it was handed. */
    async function bootWithTranscriber(
        impl?: LocalApiConfig['transcribeFile'],
        extra: Partial<LocalApiConfig> = {}
    ) {
        seen = [];
        await boot(makeFake({
            transcribeFile: async (req) => {
                seen.push(req);
                if (impl) return impl(req);
                return { text: 'so what does the onboarding process look like today', durationSec: 12.5, language: 'en' };
            },
            ...extra,
        }));
    }

    it('returns exactly {text} for the documented request', async () => {
        await bootWithTranscriber();
        const res = await postUpload(uploadBody({
            file: { bytes: AUDIO, filename: 'scoping-call.m4a', contentType: 'audio/mp4' },
            model: 'scribe',
            response_format: 'json',
        }));

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('application/json');
        expect(await res.json()).toEqual({ text: 'so what does the onboarding process look like today' });
    });

    it('hands the host the file bytes, filename, language and model verbatim', async () => {
        await bootWithTranscriber();
        await postUpload(uploadBody({
            file: { bytes: AUDIO, filename: 'scoping-call.m4a' },
            model: 'whisper-1',
            response_format: 'json',
            language: 'de',
        }));

        expect(seen).toHaveLength(1);
        expect(seen[0].filename).toBe('scoping-call.m4a');
        expect(seen[0].language).toBe('de');
        expect(seen[0].model).toBe('whisper-1');
        expect(Buffer.compare(seen[0].bytes, AUDIO)).toBe(0);
    });

    it('works with no response_format, defaulting to json', async () => {
        await bootWithTranscriber();
        const res = await postUpload(uploadBody({ file: { bytes: AUDIO, filename: 'a.wav' }, model: 'scribe' }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ text: expect.any(String) });
    });

    it('omits language when the caller does not send one', async () => {
        await bootWithTranscriber();
        await postUpload(uploadBody({ file: { bytes: AUDIO, filename: 'a.wav' }, model: 'scribe' }));
        expect(seen[0].language).toBeUndefined();
    });

    it('carries a multi-megabyte upload through intact', async () => {
        // The real thing is a 15 MB call recording; this proves the body is
        // buffered and sliced without truncation or copying corruption.
        const big = Buffer.alloc(6 * 1024 * 1024, 0x7f);
        big.write('RIFF', 0, 'latin1');
        big.write('WAVE', 8, 'latin1');
        big[big.length - 1] = 0xa5; // a sentinel at the very end

        await bootWithTranscriber();
        const res = await postUpload(uploadBody({ file: { bytes: big, filename: 'long-call.wav' }, model: 'scribe' }));

        expect(res.status).toBe(200);
        expect(seen[0].bytes.length).toBe(big.length);
        expect(seen[0].bytes[seen[0].bytes.length - 1]).toBe(0xa5);
    });

    it('returns plain text for response_format=text', async () => {
        await bootWithTranscriber();
        const res = await postUpload(uploadBody({
            file: { bytes: AUDIO, filename: 'a.wav' }, model: 'scribe', response_format: 'text',
        }));
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/plain');
        expect(await res.text()).toBe('so what does the onboarding process look like today');
    });

    it('adds duration and language for response_format=verbose_json', async () => {
        await bootWithTranscriber();
        const res = await postUpload(uploadBody({
            file: { bytes: AUDIO, filename: 'a.wav' }, model: 'scribe', response_format: 'verbose_json',
        }));
        expect(await res.json()).toMatchObject({
            task: 'transcribe', duration: 12.5, language: 'en', text: expect.any(String),
        });
    });

    it('returns an empty string, not an error, when the recording is silent', async () => {
        await bootWithTranscriber(async () => ({ text: '' }));
        const res = await postUpload(uploadBody({ file: { bytes: AUDIO, filename: 'a.wav' }, model: 'scribe' }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ text: '' });
    });
});

describe('POST /v1/audio/transcriptions — failures the caller can read', () => {
    /** Every failure must arrive in the envelope the client shows verbatim. */
    async function expectOpenAiError(res: Response, status: number, match: RegExp) {
        expect(res.status).toBe(status);
        expect(res.headers.get('content-type')).toContain('application/json');
        const body = await res.json();
        expect(typeof body.error).toBe('object');
        expect(typeof body.error.message).toBe('string');
        expect(body.error.message).toMatch(match);
        // Never a bare code: this string is shown to a human.
        expect(body.error.message.length).toBeGreaterThan(20);
        return body;
    }

    it('401 in the OpenAI envelope when the key is wrong', async () => {
        await boot(makeFake({ transcribeFile: async () => ({ text: 'x' }) }));
        const res = await postUpload(uploadBody({ file: { bytes: AUDIO, filename: 'a.wav' } }), false);
        await expectOpenAiError(res, 401, /API key|token/i);
    });

    it('keeps the original flat error shape on the pre-existing routes', async () => {
        // The OpenAI envelope is scoped to the new route; existing clients and
        // the MCP bridge must see exactly what they saw before.
        await boot(makeFake());
        const res = await api('/v1/status', {}, false);
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'unauthorized' });
    });

    it('400 when the request is not multipart at all', async () => {
        await boot(makeFake({ transcribeFile: async () => ({ text: 'x' }) }));
        const res = await api('/v1/audio/transcriptions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file: 'oops' }),
        });
        await expectOpenAiError(res, 400, /multipart\/form-data/i);
    });

    it('400 when the multipart body carries no file part', async () => {
        await boot(makeFake({ transcribeFile: async () => ({ text: 'x' }) }));
        const res = await postUpload(uploadBody({ model: 'scribe', response_format: 'json' }));
        await expectOpenAiError(res, 400, /no audio was uploaded|"file" part/i);
    });

    it('400 when the file part is present but empty', async () => {
        await boot(makeFake({ transcribeFile: async () => ({ text: 'x' }) }));
        const res = await postUpload(uploadBody({ file: { bytes: Buffer.alloc(0), filename: 'a.wav' } }));
        await expectOpenAiError(res, 400, /no audio was uploaded|empty/i);
    });

    it('400 naming the formats we support when response_format is unsupported', async () => {
        await boot(makeFake({ transcribeFile: async () => ({ text: 'x' }) }));
        const res = await postUpload(uploadBody({
            file: { bytes: AUDIO, filename: 'a.wav' }, response_format: 'srt',
        }));
        const body = await expectOpenAiError(res, 400, /srt/);
        expect(body.error.message).toMatch(/json/);
    });

    it('413 with the limit when the upload is too large', async () => {
        await boot(makeFake({
            transcribeFile: async () => ({ text: 'x' }),
            maxUploadBytes: 64 * 1024,
        }));
        const big = Buffer.alloc(200 * 1024, 0x11);
        big.write('RIFF', 0, 'latin1');
        const res = await postUpload(uploadBody({ file: { bytes: big, filename: 'huge.wav' } }));
        await expectOpenAiError(res, 413, /limit|bitrate/i);
    });

    it('409 and calls the engine exactly once when the host says it is busy', async () => {
        let called = 0;
        await boot(makeFake({
            transcribeFile: async () => {
                called++;
                throw httpError(409, 'Clarity Scribe is recording a dictation right now. Try again when it finishes.');
            },
        }));
        const res = await postUpload(uploadBody({ file: { bytes: AUDIO, filename: 'a.wav' } }));
        const body = await expectOpenAiError(res, 409, /recording a dictation/i);
        expect(body.error.type).toBe('rate_limit_error');
        expect(called).toBe(1);
    });

    it('503 while the engines are still loading', async () => {
        await boot(makeFake({
            transcribeFile: async () => {
                throw httpError(503, 'The transcription engines are still loading. Wait a few seconds and try again.');
            },
        }));
        const res = await postUpload(uploadBody({ file: { bytes: AUDIO, filename: 'a.wav' } }));
        await expectOpenAiError(res, 503, /still loading/i);
    });

    it('500 with the message when the host fails unexpectedly', async () => {
        await boot(makeFake({
            transcribeFile: async () => { throw new Error('the decoder exploded in an unforeseen way'); },
        }));
        const res = await postUpload(uploadBody({ file: { bytes: AUDIO, filename: 'a.wav' } }));
        const body = await expectOpenAiError(res, 500, /decoder exploded/);
        expect(body.error.type).toBe('server_error');
    });

    it('501 when this build cannot transcribe files at all', async () => {
        await boot(makeFake()); // no transcribeFile injected
        const res = await postUpload(uploadBody({ file: { bytes: AUDIO, filename: 'a.wav' } }));
        await expectOpenAiError(res, 501, /cannot transcribe uploaded files/i);
    });

    it('405 with guidance when the route is opened in a browser', async () => {
        await boot(makeFake({ transcribeFile: async () => ({ text: 'x' }) }));
        const res = await api('/v1/audio/transcriptions');
        await expectOpenAiError(res, 405, /POST|multipart/i);
    });

    it('400 when the body is truncated mid-upload', async () => {
        await boot(makeFake({ transcribeFile: async () => ({ text: 'x' }) }));
        const full = uploadBody({ file: { bytes: AUDIO, filename: 'a.wav' } });
        const res = await postUpload(full.subarray(0, full.length - 30));
        await expectOpenAiError(res, 400, /truncated|closing boundary|multipart/i);
    });
});
