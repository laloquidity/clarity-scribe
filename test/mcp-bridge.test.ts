/**
 * MCP bridge core (mcp/scribeApi.mjs) — tested against a REAL in-process
 * Local API server (electron/localApi.ts), so the full HTTP+SSE contract the
 * bridge depends on is exercised, not mocked.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startLocalApi, stopLocalApi, emitEvent } from '../electron/localApi';
// @ts-expect-error — plain ESM module without types
import { ScribeApi, discoverConfig } from '../mcp/scribeApi.mjs';

let port = 0;
let token = '';
let recording = false;

beforeAll(async () => {
    let stored: string | null = null;
    const started = await startLocalApi({
        port: 0,
        getToken: () => stored,
        setToken: (t: string) => { stored = t; },
        startRecording: () => { if (recording) return false; recording = true; return true; },
        stopRecording: () => { if (!recording) return false; recording = false; return true; },
        getStatus: () => ({ recording, engine: 'parakeet', version: 'test' }),
        getHistory: (limit: number) => [{ id: '1', text: 'hello world', timestamp: 1_700_000_000_000, app: 'test' }].slice(0, limit),
    });
    port = started.port;
    token = started.token;
});

afterAll(async () => {
    await stopLocalApi();
});

describe('ScribeApi', () => {
    it('status round-trips', async () => {
        const api = new ScribeApi({ port, token });
        const s = await api.status();
        expect(s).toMatchObject({ recording: false, engine: 'parakeet' });
    });

    it('start/stop recording, with 409 surfaced as status on double-start', async () => {
        const api = new ScribeApi({ port, token });
        await api.startRecording();
        expect(recording).toBe(true);
        await expect(api.startRecording()).rejects.toMatchObject({ status: 409 });
        await api.stopRecording();
        expect(recording).toBe(false);
    });

    it('history honors limit', async () => {
        const api = new ScribeApi({ port, token });
        const { entries } = await api.history(1);
        expect(entries).toHaveLength(1);
        expect(entries[0].text).toBe('hello world');
    });

    it('rejects with a wrong token', async () => {
        const api = new ScribeApi({ port, token: 'nope' });
        await expect(api.status()).rejects.toMatchObject({ status: 401 });
    });

    it('awaitResult resolves on the next result event', async () => {
        const api = new ScribeApi({ port, token });
        const p = api.awaitResult(5000);
        await new Promise(r => setTimeout(r, 150)); // let the SSE connection open
        emitEvent({ type: 'partial', text: 'ignored' });
        emitEvent({ type: 'result', text: 'the final transcript' });
        await expect(p).resolves.toBe('the final transcript');
    });

    it('awaitResult times out cleanly', async () => {
        const api = new ScribeApi({ port, token });
        await expect(api.awaitResult(300)).rejects.toThrow(/No transcription result/);
    });

    it('dictate = start + await result (and tolerates already-recording)', async () => {
        const api = new ScribeApi({ port, token });
        const p = api.dictate(5000);
        await new Promise(r => setTimeout(r, 150));
        expect(recording).toBe(true); // dictate started the recording
        // Simulate the user stopping + transcription completing:
        recording = false;
        emitEvent({ type: 'result', text: 'dictated text' });
        await expect(p).resolves.toBe('dictated text');
    });
});

describe('discoverConfig', () => {
    it('env vars take priority', () => {
        process.env.SCRIBE_API_TOKEN = 'envtok';
        process.env.SCRIBE_API_PORT = '9999';
        try {
            expect(discoverConfig()).toEqual({ token: 'envtok', port: 9999 });
        } finally {
            delete process.env.SCRIBE_API_TOKEN;
            delete process.env.SCRIBE_API_PORT;
        }
    });
});
