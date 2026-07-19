/**
 * Clarity Scribe Local-API client — the core the MCP bridge is built on.
 *
 * Plain Node (no Electron): talks to the app's loopback Local API
 * (electron/localApi.ts) over HTTP + SSE. Kept separate from the MCP entry
 * point so this logic is unit-testable against a real in-process API server.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import http from 'http';

/**
 * Locate the running app's Local API credentials by reading Clarity Scribe's
 * electron-store config file (per-OS location). Env vars override for
 * non-standard setups: SCRIBE_API_TOKEN, SCRIBE_API_PORT.
 */
export function discoverConfig() {
    const envToken = process.env.SCRIBE_API_TOKEN;
    const envPort = process.env.SCRIBE_API_PORT ? parseInt(process.env.SCRIBE_API_PORT, 10) : null;
    if (envToken && envPort) return { token: envToken, port: envPort };

    const candidates = [];
    if (process.platform === 'win32' && process.env.APPDATA) {
        candidates.push(join(process.env.APPDATA, 'clarity-scribe', 'config.json'));
    } else if (process.platform === 'darwin') {
        candidates.push(join(homedir(), 'Library', 'Application Support', 'clarity-scribe', 'config.json'));
    } else {
        candidates.push(join(homedir(), '.config', 'clarity-scribe', 'config.json'));
    }

    for (const p of candidates) {
        try {
            const cfg = JSON.parse(readFileSync(p, 'utf-8'));
            const token = envToken || cfg.localApiToken;
            const port = envPort || cfg.settings?.localApiPort || 5111;
            if (token) return { token, port };
        } catch { /* try next */ }
    }
    return { token: envToken || null, port: envPort || 5111 };
}

export class ScribeApi {
    constructor({ port, token }) {
        this.base = `http://127.0.0.1:${port}`;
        this.token = token;
    }

    async #req(method, path) {
        const res = await fetch(this.base + path, {
            method,
            headers: { Authorization: `Bearer ${this.token}` },
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            const msg = body?.error || `HTTP ${res.status}`;
            const err = new Error(msg);
            err.status = res.status;
            throw err;
        }
        return body;
    }

    startRecording() { return this.#req('POST', '/v1/record/start'); }
    stopRecording() { return this.#req('POST', '/v1/record/stop'); }
    status() { return this.#req('GET', '/v1/status'); }
    history(limit = 10) { return this.#req('GET', `/v1/history?limit=${limit}`); }

    /**
     * Wait for the next `result` event on the SSE stream. Resolves with the
     * final transcript text; rejects on timeout or connection failure.
     * Uses node:http (not fetch) so the socket can be destroyed on timeout.
     */
    awaitResult(timeoutMs = 120_000) {
        return new Promise((resolve, reject) => {
            const req = http.get(
                `${this.base}/v1/events?token=${encodeURIComponent(this.token)}`,
                (res) => {
                    if (res.statusCode !== 200) {
                        cleanup();
                        return reject(new Error(`SSE HTTP ${res.statusCode}`));
                    }
                    let buf = '';
                    res.setEncoding('utf-8');
                    res.on('data', (chunk) => {
                        buf += chunk;
                        let nl;
                        while ((nl = buf.indexOf('\n')) >= 0) {
                            const line = buf.slice(0, nl).trim();
                            buf = buf.slice(nl + 1);
                            if (!line.startsWith('data:')) continue;
                            try {
                                const evt = JSON.parse(line.slice(5).trim());
                                if (evt.type === 'result') {
                                    cleanup();
                                    resolve(evt.text ?? '');
                                }
                            } catch { /* ignore malformed lines */ }
                        }
                    });
                    res.on('end', () => { cleanup(); reject(new Error('SSE stream closed before a result arrived')); });
                }
            );
            const timer = setTimeout(() => {
                cleanup();
                reject(new Error(`No transcription result within ${Math.round(timeoutMs / 1000)}s`));
            }, timeoutMs);
            const cleanup = () => { clearTimeout(timer); req.destroy(); };
            req.on('error', (e) => { cleanup(); reject(e); });
        });
    }

    /**
     * Composite "dictate" for agents: ensure recording is running, then wait
     * for the user to finish (hotkey stop, silence auto-stop, or the caller's
     * own stop) and return the final transcript. If already recording, just
     * awaits the in-flight result.
     */
    async dictate(timeoutMs = 120_000) {
        // Subscribe BEFORE starting so a fast result can't slip past us.
        const resultPromise = this.awaitResult(timeoutMs);
        resultPromise.catch(() => {}); // avoid unhandled rejection if start throws first
        try {
            await this.startRecording();
        } catch (e) {
            if (e.status !== 409) { // 409 = already recording — that's fine
                throw e;
            }
        }
        return resultPromise;
    }
}
