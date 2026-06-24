/**
 * Parakeet CoreML sidecar manager (macOS / Apple Silicon)
 *
 * Spawns and supervises the native Swift `parakeet-sidecar` binary, which runs
 * Parakeet TDT 0.6B v3 on the Apple Neural Engine via CoreML. The sidecar is a
 * long-lived process kept warm across the session; we talk to it over a simple
 * newline-delimited JSON protocol on stdin/stdout (see native/parakeet-sidecar).
 *
 *   encoder on ANE ≈ 30ms vs ≈1400ms/23s on the ONNX-Runtime-CPU path.
 *
 * This is the DEFAULT Parakeet engine on Apple Silicon; parakeetService falls
 * back to the ONNX-CPU path (and ultimately Whisper) if the sidecar is
 * unavailable or errors at runtime. Other platforms never use this module.
 */

import { spawn, ChildProcess, execFile } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, statSync, createWriteStream } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import https from 'https';

const IS_SUPPORTED_PLATFORM = process.platform === 'darwin' && process.arch === 'arm64';

// CoreML model bundle (4 .mlmodelc + vocab), mirrored on GitHub releases as a
// single tarball. Source of truth: HF FluidInference/parakeet-tdt-0.6b-v3-coreml
// (Apache-2.0). See scripts/upload-coreml-models.sh.
const COREML_MODELS_URL =
    'https://github.com/laloquidity/clarity-scribe/releases/download/parakeet-coreml-models/parakeet-tdt-0.6b-v3-coreml.tar.gz';
const COREML_TARBALL_SIZE = 470_000_000; // approximate, for progress

// Files that must exist for the sidecar to load (relative to the models dir).
const REQUIRED_MODEL_FILES = [
    'Preprocessor.mlmodelc/model.mil',
    'Encoder.mlmodelc/weights/weight.bin',
    'Decoder.mlmodelc/weights/weight.bin',
    'JointDecision.mlmodelc/weights/weight.bin',
    'parakeet_vocab.json',
];

interface Pending {
    resolve: (text: string) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
}

let proc: ChildProcess | null = null;
let ready = false;
let stdoutBuf = '';
let reqCounter = 0;
const pending = new Map<string, Pending>();
let readyWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;

const REQUEST_TIMEOUT_MS = 120_000; // generous: long audio chunks on first warm
const READY_TIMEOUT_MS = 90_000;    // first model load compiles for the ANE (~15s) + margin

export function isSupportedPlatform(): boolean {
    return IS_SUPPORTED_PLATFORM;
}

/**
 * Locate the sidecar binary: packaged (Resources) or dev (.build/release|debug).
 */
function getBinaryPath(): string | null {
    let candidates: string[] = [];
    try {
        const { app } = require('electron');
        if (app.isPackaged) {
            candidates = [join(process.resourcesPath, 'parakeet-sidecar')];
        } else {
            const base = join(app.getAppPath(), 'native', 'parakeet-sidecar', '.build');
            candidates = [join(base, 'release', 'parakeet-sidecar'), join(base, 'debug', 'parakeet-sidecar')];
        }
    } catch {
        // Outside Electron (tests) — look relative to cwd.
        const base = join(process.cwd(), 'native', 'parakeet-sidecar', '.build');
        candidates = [join(base, 'release', 'parakeet-sidecar'), join(base, 'debug', 'parakeet-sidecar')];
    }
    return candidates.find(existsSync) || null;
}

export function getModelsDir(): string {
    // Explicit override (tests / power users) wins.
    if (process.env.SCRIBE_PARAKEET_COREML_DIR) {
        return process.env.SCRIBE_PARAKEET_COREML_DIR;
    }
    let home = process.env.HOME || tmpdir();
    try {
        const { app } = require('electron');
        home = app.getPath('home');
    } catch { /* tests */ }
    const dir = join(home, '.smart-whisper', 'models', 'parakeet-tdt-0.6b-v3-coreml');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
}

export function modelsReady(): boolean {
    const dir = getModelsDir();
    return REQUIRED_MODEL_FILES.every(f => {
        try { return statSync(join(dir, f)).size > 0; } catch { return false; }
    });
}

function downloadFile(url: string, dest: string, onProgress?: (bytes: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
        const follow = (u: string, redirects = 0) => {
            if (redirects > 5) return reject(new Error('Too many redirects'));
            https.get(u, (res) => {
                if (res.statusCode === 301 || res.statusCode === 302) {
                    res.resume();
                    return follow(res.headers.location!, redirects + 1);
                }
                if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
                const file = createWriteStream(dest);
                let downloaded = 0;
                res.on('data', (c: Buffer) => { downloaded += c.length; onProgress?.(downloaded); });
                res.pipe(file);
                file.on('finish', () => { file.close(); resolve(); });
                file.on('error', reject);
            }).on('error', reject);
        };
        follow(url);
    });
}

function extractTarball(tarball: string, destDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
        // macOS ships bsdtar; -z handles gzip. Strip nothing — tarball root is the model dir contents.
        execFile('tar', ['-xzf', tarball, '-C', destDir], (err) => (err ? reject(err) : resolve()));
    });
}

/**
 * Download + extract the CoreML model bundle if not already present.
 */
export async function ensureModels(onProgress?: (percent: number, status: string) => void): Promise<boolean> {
    if (modelsReady()) return true;
    const dir = getModelsDir();
    const tarball = join(dir, '_coreml-models.tar.gz');
    try {
        console.log('[ParakeetCoreML] Downloading CoreML models (~470MB)...');
        onProgress?.(0, 'Downloading CoreML models...');
        await downloadFile(COREML_MODELS_URL, tarball, (bytes) => {
            onProgress?.(Math.min(95, Math.round((bytes / COREML_TARBALL_SIZE) * 95)), 'Downloading CoreML models...');
        });
        onProgress?.(97, 'Extracting CoreML models...');
        await extractTarball(tarball, dir);
        try { unlinkSync(tarball); } catch { /* ignore */ }
        if (!modelsReady()) {
            console.error('[ParakeetCoreML] Model bundle extracted but required files missing');
            return false;
        }
        console.log('[ParakeetCoreML] CoreML models ready');
        return true;
    } catch (e) {
        console.error('[ParakeetCoreML] Model download/extract failed:', e);
        try { unlinkSync(tarball); } catch { /* ignore */ }
        return false;
    }
}

function handleStdoutLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: any;
    try { msg = JSON.parse(trimmed); } catch { return; } // ignore non-JSON noise
    if (msg.ready === true && readyWaiter) {
        readyWaiter.resolve();
        readyWaiter = null;
        return;
    }
    if (typeof msg.id === 'string' && pending.has(msg.id)) {
        const p = pending.get(msg.id)!;
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(String(msg.error)));
        else p.resolve(typeof msg.text === 'string' ? msg.text : '');
    }
}

function teardown(reason: string): void {
    ready = false;
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error(`sidecar exited: ${reason}`)); }
    pending.clear();
    if (readyWaiter) { readyWaiter.reject(new Error(`sidecar exited: ${reason}`)); readyWaiter = null; }
    proc = null;
}

function spawnProcess(): boolean {
    const bin = getBinaryPath();
    if (!bin) {
        console.warn('[ParakeetCoreML] Sidecar binary not found');
        return false;
    }
    const env = { ...process.env, SCRIBE_PARAKEET_MODELS: getModelsDir() };
    proc = spawn(bin, [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    stdoutBuf = '';
    proc.stdout!.setEncoding('utf-8');
    proc.stdout!.on('data', (chunk: string) => {
        stdoutBuf += chunk;
        let nl: number;
        while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
            const line = stdoutBuf.slice(0, nl);
            stdoutBuf = stdoutBuf.slice(nl + 1);
            handleStdoutLine(line);
        }
    });
    proc.stderr!.setEncoding('utf-8');
    proc.stderr!.on('data', (d: string) => {
        const s = d.trim();
        if (s) console.log(`[ParakeetCoreML:sidecar] ${s}`);
    });
    proc.on('exit', (code, signal) => {
        console.warn(`[ParakeetCoreML] Sidecar exited (code=${code}, signal=${signal})`);
        teardown(`code=${code} signal=${signal}`);
    });
    proc.on('error', (err) => {
        console.error('[ParakeetCoreML] Sidecar process error:', err);
        teardown(String(err));
    });
    return true;
}

function send(obj: any): boolean {
    if (!proc || !proc.stdin || !proc.stdin.writable) return false;
    return proc.stdin.write(JSON.stringify(obj) + '\n');
}

/**
 * Initialize the sidecar: ensure models, spawn the process, and warm it up
 * (the {"cmd":"ready"} handshake also covers the one-time ANE model compile).
 * Returns false (not throws) when unavailable, so the caller can fall back.
 */
export async function init(onProgress?: (percent: number, status: string) => void): Promise<boolean> {
    if (!IS_SUPPORTED_PLATFORM) return false;
    if (ready) return true;
    if (!getBinaryPath()) return false;

    if (!(await ensureModels(onProgress))) return false;

    onProgress?.(98, 'Starting CoreML engine...');
    if (!spawnProcess()) return false;

    try {
        await new Promise<void>((resolve, reject) => {
            readyWaiter = { resolve, reject };
            const t = setTimeout(() => {
                if (readyWaiter) { readyWaiter = null; reject(new Error('ready handshake timed out')); }
            }, READY_TIMEOUT_MS);
            // Clear the timeout once resolved/rejected by wrapping.
            const origResolve = resolve;
            readyWaiter.resolve = () => { clearTimeout(t); origResolve(); };
            if (!send({ cmd: 'ready' })) { clearTimeout(t); reject(new Error('failed to write to sidecar')); }
        });
        ready = true;
        onProgress?.(100, 'CoreML engine ready');
        console.log('[ParakeetCoreML] Sidecar ready (ANE)');
        return true;
    } catch (e) {
        console.warn('[ParakeetCoreML] Sidecar warmup failed:', e);
        cleanup();
        return false;
    }
}

export function isReady(): boolean {
    return ready && proc !== null;
}

/**
 * Transcribe 16kHz mono float32 audio via the sidecar. Writes the samples to a
 * temp raw f32le file (the sidecar's audio contract) and awaits the response.
 */
export async function transcribe(audio: Float32Array): Promise<string> {
    if (!isReady()) throw new Error('CoreML sidecar not ready');
    const id = `r${++reqCounter}`;
    const audioPath = join(tmpdir(), `scribe-parakeet-${process.pid}-${id}.f32`);
    writeFileSync(audioPath, Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength));

    try {
        return await new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error('sidecar request timed out'));
            }, REQUEST_TIMEOUT_MS);
            pending.set(id, { resolve, reject, timer });
            if (!send({ id, audioPath })) {
                clearTimeout(timer);
                pending.delete(id);
                reject(new Error('failed to write request to sidecar'));
            }
        });
    } finally {
        try { unlinkSync(audioPath); } catch { /* ignore */ }
    }
}

export function cleanup(): void {
    ready = false;
    if (proc) {
        try { proc.stdin?.end(); } catch { /* ignore */ }
        try { proc.kill(); } catch { /* ignore */ }
    }
    teardown('cleanup');
}
