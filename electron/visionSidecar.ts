/**
 * Vision sidecar — manages the OmniParser HTTP server (agent/omniparser_server.py).
 *
 * Mirrors the llmRouter lifecycle: discover interpreter + script, spawn once,
 * health-poll until the models are loaded (first load pulls YOLO + Florence-2
 * onto the GPU — generous timeout), keep resident for ~2s warm parses, tear
 * down with the app. ensureStarted() is single-flight and resolves false
 * instead of throwing so agent mode can degrade with an honest message.
 *
 * Discovery (override with SCRIBE_OMNIPARSER_PY / SCRIBE_OMNIPARSER_DIR):
 * the OmniParser repo's own venv python, run against the server script that
 * ships inside Scribe (agent/omniparser_server.py).
 */

import { spawn, ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface ScreenElement {
    id: number;
    type: string;
    content: string;
    interactive: boolean;
    /** Ratio [x1, y1, x2, y2] of the submitted screenshot. */
    bbox: [number, number, number, number];
}

export interface VisionStatus {
    available: boolean;   // interpreter + script + weights discoverable
    running: boolean;     // server healthy (models loaded)
    port: number | null;
    lastParseMs: number | null;
}

const PORT_BASE = 8093;
const LOAD_TIMEOUT_MS = 240_000;  // first load downloads nothing but compiles CUDA kernels
const PARSE_TIMEOUT_MS = 60_000;

let proc: ChildProcess | null = null;
let port: number | null = null;
let running = false;
let starting: Promise<boolean> | null = null;
let lastParseMs: number | null = null;

function omniDir(): string | null {
    const candidates = [
        process.env.SCRIBE_OMNIPARSER_DIR,
        'C:\\Users\\Hilal\\tools\\OmniParser',
        join(homedir(), 'tools', 'OmniParser'),
        join(homedir(), 'OmniParser'),
    ].filter(Boolean) as string[];
    return candidates.find(d => existsSync(join(d, 'weights', 'icon_detect', 'model.pt'))) || null;
}

function pythonBin(): string | null {
    const dir = omniDir();
    const candidates = [
        process.env.SCRIBE_OMNIPARSER_PY,
        dir ? join(dir, '.venv', 'Scripts', 'python.exe') : null,
        dir ? join(dir, '.venv', 'bin', 'python') : null,
    ].filter(Boolean) as string[];
    return candidates.find(existsSync) || null;
}

function serverScript(): string | null {
    const candidates = [
        join(__dirname, '..', 'agent', 'omniparser_server.py'),          // dev (dist-electron/..)
        join(process.resourcesPath ?? '', 'agent', 'omniparser_server.py'), // packaged (extraResources)
    ];
    return candidates.find(existsSync) || null;
}

export function getStatus(): VisionStatus {
    return {
        available: !!(omniDir() && pythonBin() && serverScript()),
        running,
        port,
        lastParseMs,
    };
}

async function healthOk(p: number): Promise<boolean> {
    try {
        const res = await fetch(`http://127.0.0.1:${p}/health`, { signal: AbortSignal.timeout(2000) });
        return res.ok;
    } catch {
        return false;
    }
}

async function portFree(p: number): Promise<boolean> {
    try {
        await fetch(`http://127.0.0.1:${p}/health`, { signal: AbortSignal.timeout(500) });
        return false;
    } catch {
        return true;
    }
}

/** Ensure the vision server is up (idempotent, single-flight, never throws). */
export function ensureStarted(): Promise<boolean> {
    // `proc` may legitimately be null when we adopted an external server.
    if (running && port) return Promise.resolve(true);
    if (starting) return starting;
    starting = (async () => {
        const py = pythonBin();
        const script = serverScript();
        const dir = omniDir();
        if (!py || !script || !dir) {
            console.warn(`[Vision] Unavailable (python: ${py ?? 'not found'}, script: ${script ?? 'not found'}, weights: ${dir ?? 'not found'})`);
            return false;
        }

        let p = PORT_BASE;
        for (let i = 0; i < 5; i++) {
            if (await healthOk(p)) {
                // A ready OmniParser server already exists (dev / previous run)
                // — adopt it rather than loading a duplicate onto the GPU.
                port = p;
                running = true;
                console.log(`[Vision] ✓ Adopted existing server on :${p}`);
                return true;
            }
            if (await portFree(p)) break;
            p++;
        }

        console.log(`[Vision] Starting OmniParser server on :${p}`);
        proc = spawn(py, [script], {
            env: {
                ...process.env,
                PYTHONUTF8: '1', // easyocr progress bar crashes cp1252 consoles
                SCRIBE_OMNIPARSER_DIR: dir,
                SCRIBE_OMNIPARSER_PORT: String(p),
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        proc.stdout!.setEncoding('utf-8');
        proc.stdout!.on('data', (d: string) => {
            const s = d.trim();
            if (s) console.log(`[Vision:py] ${s.substring(0, 200)}`);
        });
        proc.stderr!.setEncoding('utf-8');
        proc.stderr!.on('data', (d: string) => {
            const s = d.trim();
            if (s && /error|traceback/i.test(s)) console.warn(`[Vision:py] ${s.substring(0, 300)}`);
        });
        proc.on('exit', (code, signal) => {
            console.warn(`[Vision] OmniParser server exited (code=${code}, signal=${signal})`);
            running = false;
            proc = null;
            port = null;
        });

        const deadline = Date.now() + LOAD_TIMEOUT_MS;
        while (Date.now() < deadline) {
            if (!proc) return false; // crashed during load
            if (await healthOk(p)) {
                port = p;
                running = true;
                console.log(`[Vision] ✓ Ready on :${p}`);
                return true;
            }
            await new Promise(r => setTimeout(r, 1500));
        }
        console.warn('[Vision] Model load timed out — stopping');
        stop();
        return false;
    })().finally(() => { starting = null; });
    return starting;
}

export function stop(): void {
    running = false;
    if (proc) {
        try { proc.kill(); } catch { /* ignore */ }
        proc = null;
    }
    port = null;
}

/** Parse one screenshot (base64 PNG) into labeled screen elements. */
export async function parseScreen(pngBase64: string, signal?: AbortSignal): Promise<ScreenElement[]> {
    if (!running || !port) {
        const ok = await ensureStarted();
        if (!ok) throw new Error('Screen vision is not available (OmniParser sidecar failed to start)');
    }
    const timeout = AbortSignal.timeout(PARSE_TIMEOUT_MS);
    const res = await fetch(`http://127.0.0.1:${port}/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
        body: JSON.stringify({ image_b64: pngBase64 }),
    });
    if (!res.ok) throw new Error(`Vision parse HTTP ${res.status}`);
    const body: any = await res.json();
    lastParseMs = body.ms ?? null;
    return (body.elements ?? []) as ScreenElement[];
}

/** Test seam. */
export function __setForTest(state: { running: boolean; port: number | null }): void {
    running = state.running;
    port = state.port;
}
