/**
 * LLM Router — local command routing via llama.cpp's llama-server.
 *
 * Manages a resident llama-server child process running a small instruction
 * model (Gemma 4 E2B by default) and routes spoken-command transcripts to
 * structured tool calls through its OpenAI-compatible chat API. Fully local:
 * no text leaves the machine.
 *
 * Lifecycle mirrors the CoreML sidecar pattern (spawn, health-poll, keep warm,
 * teardown): the server stays resident so llama.cpp's prompt cache makes every
 * route after the first fast (the system prompt + tool schema prefix is
 * identical across calls; only the utterance changes).
 *
 * Discovery: binary and model are found automatically (see BINARY_CANDIDATES /
 * findModel) and can be overridden with SCRIBE_LLAMA_SERVER / SCRIBE_ROUTER_MODEL.
 */

import { spawn, ChildProcess } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface RouteResult {
    tool: string;
    args: Record<string, unknown>;
    ms: number;
}

export interface RouterStatus {
    available: boolean;   // binary + model discovered
    running: boolean;     // server process alive and healthy
    binaryPath: string | null;
    modelPath: string | null;
    port: number | null;
    lastRouteMs: number | null;
}

const PORT_BASE = 8091;       // probed upward if taken (8080 is occupied on some setups)
const HEALTH_TIMEOUT_MS = 120_000; // first load compiles CUDA graphs; be generous
const ROUTE_TIMEOUT_MS = 20_000;

let proc: ChildProcess | null = null;
let port: number | null = null;
let running = false;
let starting: Promise<boolean> | null = null;
let lastRouteMs: number | null = null;

function binaryCandidates(): string[] {
    const c: string[] = [];
    if (process.env.SCRIBE_LLAMA_SERVER) c.push(process.env.SCRIBE_LLAMA_SERVER);
    if (process.platform === 'win32') {
        c.push('C:\\llama-server\\llama-server.exe');
        c.push(join(homedir(), 'llama.cpp', 'llama-server.exe'));
    } else {
        c.push('/opt/homebrew/bin/llama-server', '/usr/local/bin/llama-server');
        c.push(join(homedir(), 'llama.cpp', 'build', 'bin', 'llama-server'));
    }
    return c;
}

function findBinary(): string | null {
    return binaryCandidates().find(existsSync) || null;
}

/** Prefer a Gemma edge model; fall back to any small (<8GB) instruct GGUF. */
function findModel(): string | null {
    if (process.env.SCRIBE_ROUTER_MODEL && existsSync(process.env.SCRIBE_ROUTER_MODEL)) {
        return process.env.SCRIBE_ROUTER_MODEL;
    }
    const dirs = process.platform === 'win32'
        ? ['C:\\llama-server\\models', join(homedir(), 'models')]
        : [join(homedir(), 'models'), join(homedir(), '.cache', 'llama.cpp')];
    for (const dir of dirs) {
        try {
            const files = readdirSync(dir).filter(f => f.toLowerCase().endsWith('.gguf') && !f.toLowerCase().includes('mmproj'));
            const gemma = files.filter(f => /gemma-4-e\db/i.test(f)).sort();
            if (gemma.length > 0) return join(dir, gemma[gemma.length - 1]); // highest quant wins
        } catch { /* dir missing */ }
    }
    return null;
}

export function getStatus(): RouterStatus {
    return {
        available: !!(findBinary() && findModel()),
        running,
        binaryPath: findBinary(),
        modelPath: findModel(),
        port,
        lastRouteMs,
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
        return false; // something answered — taken
    } catch {
        return true;
    }
}

/**
 * Ensure the router server is up. Idempotent and single-flight; resolves false
 * (never throws) when unavailable so callers can degrade gracefully.
 */
export function ensureStarted(): Promise<boolean> {
    if (running && proc) return Promise.resolve(true);
    if (starting) return starting;
    starting = (async () => {
        const bin = findBinary();
        const model = findModel();
        if (!bin || !model) {
            console.warn(`[Router] Unavailable (binary: ${bin ?? 'not found'}, model: ${model ?? 'not found'})`);
            return false;
        }

        let p = PORT_BASE;
        for (let i = 0; i < 5 && !(await portFree(p)); i++) p++;

        console.log(`[Router] Starting llama-server on :${p} with ${model}`);
        proc = spawn(bin, ['-m', model, '-ngl', '99', '--port', String(p), '--jinja', '--log-disable'], {
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        proc.stderr!.setEncoding('utf-8');
        proc.stderr!.on('data', (d: string) => {
            const s = d.trim();
            if (s && /error|failed/i.test(s)) console.warn(`[Router:llama] ${s.substring(0, 200)}`);
        });
        proc.on('exit', (code, signal) => {
            console.warn(`[Router] llama-server exited (code=${code}, signal=${signal})`);
            running = false;
            proc = null;
            port = null;
        });

        const deadline = Date.now() + HEALTH_TIMEOUT_MS;
        while (Date.now() < deadline) {
            if (!proc) return false; // crashed during load
            if (await healthOk(p)) {
                port = p;
                running = true;
                console.log(`[Router] ✓ Ready on :${p}`);
                return true;
            }
            await new Promise(r => setTimeout(r, 1000));
        }
        console.warn('[Router] Health check timed out — stopping');
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

const SYSTEM_PROMPT = `You route the user's SPOKEN input to exactly one tool call.
Rules:
- If it is an instruction to do something on this computer, call the matching tool.
- If it requires acting INSIDE an application (searching, playing, clicking) or chains several steps ("open X and do Y"), call "computer_use" with the goal verbatim.
- If it is ordinary prose the user wants typed (dictation), call "dictation" with the text verbatim.
- If it is an instruction but NO tool matches it, or required details are missing, call "clarify" and say what you need or cannot do. NEVER shoehorn an unsupported request into the closest tool.
Always call exactly one tool. Keep arguments faithful to the user's words.`;

/**
 * Generic forced-tool-call chat against the resident llama-server. Shared by
 * command routing (route) and the agent loop's per-step decisions. Throws on
 * transport/parse errors so callers can surface honest error states.
 */
export async function chatToolCall(
    messages: Array<{ role: string; content: string }>,
    tools: unknown[],
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<RouteResult> {
    if (!running || !port) {
        const ok = await ensureStarted();
        if (!ok) throw new Error('Command router is not available (llama-server or model not found)');
    }
    const t0 = Date.now();
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? ROUTE_TIMEOUT_MS);
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Caller's signal (Esc during an agent step) aborts mid-generation.
        signal: opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout,
        body: JSON.stringify({
            model: 'router',
            messages,
            tools,
            tool_choice: 'required',
            temperature: 0.1,
            cache_prompt: true, // llama.cpp: reuse the shared system+tools prefix KV
        }),
    });
    if (!res.ok) throw new Error(`Router HTTP ${res.status}`);
    const body: any = await res.json();
    const call = body.choices?.[0]?.message?.tool_calls?.[0];
    if (!call?.function?.name) {
        const said = body.choices?.[0]?.message?.content;
        throw new Error(`Router returned no tool call${said ? ` (said: "${String(said).substring(0, 80)}")` : ''}`);
    }
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* tolerate empty/bad args */ }
    return { tool: call.function.name, args, ms: Date.now() - t0 };
}

/**
 * Route one utterance to a tool call. `tools` is an OpenAI-format tool array
 * (see commandTools.toOpenAiTools). Throws on transport/parse errors so the
 * orchestrator can surface an honest error stage.
 */
export async function route(utterance: string, tools: unknown[]): Promise<RouteResult> {
    const r = await chatToolCall(
        [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: utterance },
        ],
        tools,
    );
    lastRouteMs = r.ms;
    return r;
}

/** Test seam: inject a fake transport state (unit tests never spawn a server). */
export function __setForTest(state: { running: boolean; port: number | null }): void {
    running = state.running;
    port = state.port;
}
