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
    type LocalApiConfig,
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

    it('accepts the token via query param (for EventSource)', async () => {
        const res = await fetch(`${baseUrl}/v1/status?token=${token}`);
        expect(res.status).toBe(200);
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
