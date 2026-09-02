/**
 * Parakeet TDT 0.6B-v3 Service — High-performance ASR via ONNX Runtime
 *
 * Uses the sherpa-onnx NeMo Parakeet TDT 0.6B-v3 INT8 model from:
 * https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8
 *
 * Architecture: Encoder → Decoder → Joiner (Token-and-Duration Transducer)
 * Model files:
 *   encoder.int8.onnx  (~652 MB) — FastConformer encoder
 *   decoder.int8.onnx  (~11.8 MB) — LSTM prediction network (stateful)
 *   joiner.int8.onnx   (~6.36 MB) — Combines encoder + decoder outputs
 *   tokens.txt         (~94 KB)  — Vocabulary (8193 tokens, blank=8192)
 *
 * Tensor names verified against actual model inspection 2026-03-23:
 *   Decoder inputs:  targets, target_length, states.1, onnx::Slice_3
 *   Decoder outputs: outputs, prednet_lengths, states, 162
 *   Joiner inputs:   encoder_outputs, decoder_outputs
 *   Joiner outputs:  outputs
 *
 * Decoder state handling based on sherpa-onnx/csrc/offline-transducer-nemo-model.cc:
 *   - states are [pred_rnn_layers, batch, pred_hidden] (from encoder metadata)
 *   - decoder_out[0]=output, decoder_out[1]=length, decoder_out[2:]=next_states
 *   - Encoder transposes features (B,T,C) → (B,C,T) internally
 */

import * as ort from 'onnxruntime-node';
import { existsSync, mkdirSync, createWriteStream, readFileSync } from 'fs';
import { join } from 'path';
import { app } from 'electron';
import https from 'https';
import { detectSpeechSegments, isVADReady } from './vadService';
import * as core from './parakeetCore';
import * as sidecar from './parakeetSidecar';
import { joinSegments } from './segmentJoin';
import { assessDecode, preferBetterDecode, shouldRefreshSessions, peakWindowRms, nextRebuildAllowedAt, QUIET_PEAK_RMS, quietestSplitPoint } from './decodeHealth';
import { isSessionInProgress as isStreamingSessionInProgress } from './streamingTranscriber';
import { diag } from './diagnostics';

// Self-hosted on GitHub releases (reliable CDN, full control)
// Original source: csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8 (INT8 quantized)
const MODEL_BASE_URL = 'https://github.com/laloquidity/clarity-scribe/releases/download/parakeet-models';
const MODEL_FILES = [
    { name: 'encoder.int8.onnx', size: 652_000_000, label: 'Encoder' },
    { name: 'decoder.int8.onnx', size: 11_800_000,  label: 'Decoder' },
    { name: 'joiner.int8.onnx',  size: 6_360_000,   label: 'Joiner' },
    { name: 'tokens.txt',        size: 94_000,       label: 'Vocabulary' },
];

const TOTAL_SIZE = MODEL_FILES.reduce((s, f) => s + f.size, 0);

// NeMo convention: blank token is the LAST token in vocabulary (from core)
const BLANK_ID = core.BLANK_ID;

let encoderSession: ort.InferenceSession | null = null;
let decoderSession: ort.InferenceSession | null = null;
let joinerSession: ort.InferenceSession | null = null;
let vocabulary: string[] = [];
let isInitialized = false;

// CoreML ANE sidecar (macOS/Apple Silicon) — the default Parakeet engine when
// available. useSidecar flips on once initialized; sidecarEnabled is the
// user-facing toggle (default on).
let useSidecar = false;
let sidecarEnabled = true;

/** Enable/disable the CoreML ANE sidecar engine (macOS). Call before initParakeet. */
export function setCoreMLEnabled(enabled: boolean): void {
    sidecarEnabled = enabled;
}

// --- Decoder-level custom vocabulary (shallow-fusion biasing) ---
// Terms come from the Personal Dictionary: both the "replacement" (what the
// user MEANT) and the "original" (the spelling the model is able to emit).
// Boosting the original matters when the replacement is not in the model's
// reachable output at all — a name it never writes can still be steered to a
// near spelling it does write, which the dictionary then rewrites. The trie is
// built lazily against the loaded vocabulary and rebuilt whenever the
// dictionary changes. Applies to the ONNX decode path (Windows/Linux and the
// macOS ONNX fallback); the CoreML sidecar's joint model performs the argmax
// on-device and never exposes logits, so biasing cannot apply there.
let boostTerms: string[] = [];
let biasContext: core.BiasContext | null = null;
let biasDirty = false;

export function setVocabularyBoostTerms(terms: string[]): void {
    boostTerms = (terms || []).filter(t => typeof t === 'string' && t.trim().length > 0);
    biasDirty = true;
}

function currentBias(): core.BiasContext | null {
    if (biasDirty && vocabulary.length > 0) {
        biasDirty = false;
        try {
            // SCRIBE_BIAS_BOOST overrides the tuned default for experiments.
            const override = parseFloat(process.env.SCRIBE_BIAS_BOOST || '');
            const boost = isNaN(override) ? core.DEFAULT_BIAS_BOOST : override;
            biasContext = core.buildBiasContext(boostTerms, vocabulary, boost);
            if (biasContext) {
                console.log(`[Parakeet] Vocabulary bias active: ${biasContext.termCount}/${boostTerms.length} terms tokenized (boost ${boost})`);
            } else if (boostTerms.length > 0) {
                console.log('[Parakeet] Vocabulary bias: no terms tokenizable');
            }
        } catch (e) {
            console.warn('[Parakeet] Vocabulary bias build failed (decoding unbiased):', e);
            biasContext = null;
        }
    }
    return biasContext;
}

/** Decode context passed to the shared core TDT decoder. */
function decodeCtx(): core.DecodeContext {
    return {
        decoderSession: decoderSession!,
        joinerSession: joinerSession!,
        vocabulary,
        blankId: BLANK_ID,
        predRnnLayers,
        predHidden,
        bias: currentBias(),
    };
}

// Decoder state dimensions (read from encoder metadata at init)
let predRnnLayers = 1;
let predHidden = 320;

function getModelDir(): string {
    const dir = join(app.getPath('home'), '.smart-whisper', 'models', 'parakeet-tdt-0.6b-v3');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * Download a single file with redirect support and progress
 */
function downloadFile(url: string, dest: string, onProgress?: (bytes: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
        const follow = (url: string, redirects = 0) => {
            if (redirects > 5) return reject(new Error('Too many redirects'));
            https.get(url, (res) => {
                if (res.statusCode === 301 || res.statusCode === 302) {
                    return follow(res.headers.location!, redirects + 1);
                }
                if (res.statusCode !== 200) {
                    return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
                }
                const file = createWriteStream(dest);
                let downloaded = 0;
                res.on('data', (chunk: Buffer) => {
                    downloaded += chunk.length;
                    onProgress?.(downloaded);
                });
                res.pipe(file);
                file.on('finish', () => { file.close(); resolve(); });
                file.on('error', reject);
            }).on('error', reject);
        };
        follow(url);
    });
}

/**
 * Check if a model file exists AND has the expected size (within 90%).
 * Catches truncated downloads that would cause "Protobuf parsing failed" errors.
 */
function isModelFileValid(filePath: string, expectedSize: number): boolean {
    try {
        const { statSync } = require('fs');
        const stats = statSync(filePath);
        return stats.size >= expectedSize * 0.9;
    } catch {
        return false;
    }
}

/**
 * Download all model files with progress and integrity validation
 */
export async function downloadParakeetModel(
    onProgress?: (percent: number, status: string) => void
): Promise<boolean> {
    const modelDir = getModelDir();
    let downloadedTotal = 0;

    for (const file of MODEL_FILES) {
        const filePath = join(modelDir, file.name);
        if (isModelFileValid(filePath, file.size)) {
            downloadedTotal += file.size;
            continue;
        }

        // Remove truncated/corrupt file before re-downloading
        try { require('fs').unlinkSync(filePath); } catch { /* didn't exist */ }

        const url = `${MODEL_BASE_URL}/${file.name}`;
        console.log(`[Parakeet] Downloading ${file.label} (${(file.size / 1e6).toFixed(0)}MB)...`);
        onProgress?.(Math.round((downloadedTotal / TOTAL_SIZE) * 100), `Downloading ${file.label}...`);

        try {
            const baseDownloaded = downloadedTotal;
            await downloadFile(url, filePath, (bytes) => {
                const total = baseDownloaded + bytes;
                onProgress?.(Math.round((total / TOTAL_SIZE) * 100), `Downloading ${file.label}...`);
            });

            // Validate download completed fully
            if (!isModelFileValid(filePath, file.size)) {
                console.error(`[Parakeet] ${file.name} downloaded but size check failed (truncated?). Removing.`);
                try { require('fs').unlinkSync(filePath); } catch { /* ignore */ }
                return false;
            }

            downloadedTotal += file.size;
        } catch (error) {
            console.error(`[Parakeet] Failed to download ${file.name}:`, error);
            try { require('fs').unlinkSync(filePath); } catch { /* ignore */ }
            return false;
        }
    }

    console.log('[Parakeet] All model files downloaded');
    return true;
}

/**
 * Determine the best ONNX execution providers for this platform
 *
 * macOS: CPU only. CoreML EP crashes (SIGTRAP / EXC_BREAKPOINT) with the
 *        INT8 FastConformer encoder at all practical dictation lengths (>~15s).
 *        M-series CPU is fast enough: 23s in 1,422ms (16.7x real-time).
 *
 * Windows: DirectML (all GPUs) → CPU fallback
 * Linux:   CUDA (NVIDIA) → CPU fallback
 */
function getExecutionProviders(): string[] {
    if (process.platform === 'win32') {
        return ['dml', 'cpu'];
    }
    if (process.platform === 'linux') {
        return ['cuda', 'cpu'];
    }
    // macOS — CPU only (CoreML crashes with SIGTRAP on this model)
    return ['cpu'];
}

/**
 * Add the win-gpu resource directory to the DLL search path so that
 * the CUDA/cuDNN runtime DLLs bundled with the app can be found
 * when onnxruntime_providers_cuda.dll is loaded.
 */
function setupGpuDllPath(): void {
    if (process.platform !== 'win32') return;
    try {
        const { join } = require('path');
        // In production: resources/win-gpu sits next to the asar archive
        // In dev: resources/win-gpu is in the project root
        const gpuDir = app.isPackaged
            ? join(process.resourcesPath, 'win-gpu')
            : join(__dirname, '..', 'resources', 'win-gpu');

        // Prepend to PATH so Windows can find the CUDA/cuDNN DLLs
        if (require('fs').existsSync(gpuDir)) {
            process.env.PATH = gpuDir + ';' + (process.env.PATH || '');
            console.log(`[Parakeet] Added GPU DLL path: ${gpuDir}`);
        } else {
            console.log(`[Parakeet] GPU DLL directory not found: ${gpuDir} (CUDA may still work if toolkit is installed)`);
        }
    } catch (e) {
        console.warn('[Parakeet] Could not set up GPU DLL path:', e);
    }
}

/**
 * Read model metadata to get decoder state dimensions
 */
function readEncoderMetadata(session: ort.InferenceSession): void {
    try {
        // Verified from runtime error: dim 0 Expected: 2 (2 LSTM layers)
        predRnnLayers = 2;
        predHidden = 640;
        console.log(`[Parakeet] Decoder state dims: layers=${predRnnLayers}, hidden=${predHidden}`);
    } catch {
        console.warn('[Parakeet] Could not read encoder metadata, using defaults');
    }
}

/**
 * Initialize all three ONNX sessions (encoder, decoder, joiner)
 */
export async function initParakeet(
    onProgress?: (percent: number, status: string) => void
): Promise<boolean> {
    if (isInitialized) return true;

    // Apple Silicon: try the CoreML ANE sidecar first (default, fastest engine).
    if (sidecarEnabled && sidecar.isSupportedPlatform()) {
        try {
            const ok = await sidecar.init(onProgress);
            if (ok) {
                useSidecar = true;
                isInitialized = true;
                console.log('[Parakeet] ✓ Using CoreML ANE sidecar (default engine on Apple Silicon)');
                // Time the shared reference here too. This branch returns before
                // the ONNX warmup below, so without this the sidecar reports no
                // measurement at all and anything gated on speed silently
                // assumes the worst — which is how live preview came to be off
                // on every Mac despite the ANE being the fastest path we have.
                await measureWarmDecode();
                return true;
            }
            console.warn('[Parakeet] CoreML sidecar unavailable — falling back to ONNX');
        } catch (e) {
            console.warn('[Parakeet] CoreML sidecar init failed — falling back to ONNX:', e);
        }
    }

    return initParakeetOnnx(onProgress);
}

/**
 * Initialize the ONNX engine (encoder/decoder/joiner). Cross-platform path
 * (GPU on Windows/Linux, CPU on macOS) and the macOS fallback when the CoreML
 * sidecar is unavailable.
 */
async function initParakeetOnnx(
    onProgress?: (percent: number, status: string) => void
): Promise<boolean> {
    if (encoderSession && decoderSession && joinerSession) return true;

    // Ensure CUDA/cuDNN DLLs are discoverable before loading ORT sessions
    setupGpuDllPath();

    const modelDir = getModelDir();

    // Download if needed — validate file sizes, not just existence
    const allValid = MODEL_FILES.every(f => isModelFileValid(join(modelDir, f.name), f.size));
    if (!allValid) {
        onProgress?.(0, 'Downloading Parakeet model...');
        const downloaded = await downloadParakeetModel(onProgress);
        if (!downloaded) return false;
    }

    try {
        const providers = getExecutionProviders();
        const gpuProvider = providers[0]; // dml on Windows, cuda on Linux, coreml on macOS
        console.log(`[Parakeet] Loading with providers: ${providers.join(' → ')} (GPU tier: ${gpuProvider.toUpperCase()})`);

        // Load all three sessions CONCURRENTLY. The encoder (largest model —
        // GPU on Win/Linux, CPU on macOS) dominates; the CPU decoder and
        // joiner (sequential loops — GPU kernel launch overhead hurts) are
        // small and used to wait behind it for nothing. Session options
        // (incl. the Windows DirectML stability settings) come from
        // core.encoderSessionOptions so production and tests share them.
        onProgress?.(85, 'Loading encoder...');
        console.log('[Parakeet] Loading encoder, decoder, joiner...');
        const [enc, dec, joi] = await Promise.all([
            ort.InferenceSession.create(join(modelDir, 'encoder.int8.onnx'), core.encoderSessionOptions(providers)),
            ort.InferenceSession.create(join(modelDir, 'decoder.int8.onnx'), core.smallModelSessionOptions()),
            ort.InferenceSession.create(join(modelDir, 'joiner.int8.onnx'), core.smallModelSessionOptions()),
        ]);
        encoderSession = enc;
        decoderSession = dec;
        joinerSession = joi;
        console.log(`[Parakeet] ✓ Encoder loaded on ${gpuProvider.toUpperCase()} (inputs: ${encoderSession.inputNames}, outputs: ${encoderSession.outputNames})`);

        // Read metadata to get decoder state dimensions
        readEncoderMetadata(encoderSession);
        console.log(`[Parakeet] ✓ Decoder loaded on CPU (inputs: ${decoderSession.inputNames}, outputs: ${decoderSession.outputNames})`);
        console.log(`[Parakeet] ✓ Joiner loaded on CPU (inputs: ${joinerSession.inputNames}, outputs: ${joinerSession.outputNames})`);

        // Load vocabulary
        onProgress?.(96, 'Loading vocabulary...');
        vocabulary = core.loadTokens(join(modelDir, 'tokens.txt'));
        console.log(`[Parakeet] ✓ Vocabulary loaded: ${vocabulary.length} tokens (blank=${BLANK_ID})`);

        isInitialized = true;
        sessionsBuiltAt = Date.now(); // starts the preventive-refresh clock

        // Warm up the graphs so the FIRST dictation doesn't pay cold-start cost
        // (kernel init, CPU memory-arena allocation). Non-fatal on failure.
        //
        // On DML this warmup also CLAIMS THE STICKY SHAPE: the provider keeps
        // its compiled plan for the first shape a session runs, so the warmup
        // must run the exact fixed shape every dictation will use — the old
        // 0.5s warmup pinned a shape no real dictation matched, which made the
        // ~400ms recompile a certainty on every single dictation.
        try {
            onProgress?.(98, 'Warming up...');
            const warmupStart = Date.now();
            padToFixedShape = gpuProvider === 'dml';
            // State the decision outright. Diagnosing this from its absence
            // cost a round of guesswork; an explicit line costs nothing.
            console.log(`[Parakeet] Fixed encoder shape: ${padToFixedShape ? 'ENABLED' : 'disabled'} (provider "${gpuProvider}", width ${core.FIXED_ENCODER_FRAMES} frames)`);
            await transcribeSinglePass(new Float32Array(REFERENCE_CLIP_SAMPLES)); // padded if flag set
            // Always time a warm run, not only when padding is on: the number
            // gates live preview on every engine, and a path that skips the
            // measurement is indistinguishable from a path that failed it.
            await measureWarmDecode(true); // the pass above already warmed it
            if (padToFixedShape) {
                // Verify the encoder actually landed on the GPU: a warm run at
                // the fixed shape is ~115ms there and ~1.3s on a silent CPU
                // fallback, where padding would be an 8x regression.
                const warmMs = warmDecodeMs ?? Number.POSITIVE_INFINITY;
                if (warmMs > FIXED_SHAPE_WARM_LIMIT_MS) {
                    padToFixedShape = false;
                    console.warn(`[Parakeet] Fixed-shape encode took ${warmMs}ms warm — encoder is not on the GPU; padding disabled`);
                } else {
                    console.log(`[Parakeet] ✓ Fixed encoder shape active (warm ${warmMs}ms)`);
                }
            }
            console.log(`[Parakeet] ✓ Warmup complete (${Date.now() - warmupStart}ms)`);
        } catch (e) {
            console.warn('[Parakeet] Warmup failed (non-fatal):', e);
        }

        onProgress?.(100, 'Parakeet ready');
        console.log('[Parakeet] ✓ Initialized successfully');
        return true;
    } catch (error) {
        console.error('[Parakeet] Initialization failed:', error);
        encoderSession = null;
        decoderSession = null;
        joinerSession = null;
        isInitialized = false;
        return false;
    }
}

/**
 * Single-pass encode + decode for one audio segment.
 * Handles mel spectrogram, encoder, and TDT decoder in one call.
 *
 * No artificial tail padding is applied. The VAD's speechPadMs provides
 * natural trailing audio context. The encoder length tensor uses the valid
 * frame count (excluding STFT edge-padding frames) to match the reference
 * onnx-asr pipeline exactly.
 */
/**
 * Rebuild the ONNX sessions in place.
 *
 * A long-lived DirectML session can degrade: after ~24h of uptime a user hit
 * an encoder running an order of magnitude slow AND producing output the
 * joiner scored as blank almost everywhere, silently dropping 3.8s of a 6.8s
 * utterance. Resetting the decoder LSTM didn't help — only restarting the app
 * did. This is that restart, scoped to the sessions and done in about a
 * second. Returns false if re-creation fails (we then keep what we have).
 */
/**
 * Pad every single-pass encode to the ONE fixed shape (FIXED_ENCODER_FRAMES)?
 *
 * True only where it wins: the DirectML provider compiles its plan for the
 * first shape a session runs and re-JITs every differing run (~350-450ms per
 * dictation, proven by inverted-warmup experiment). On CPU the same padding
 * is an outright REGRESSION — 165ms → 1,315ms measured for a 3s clip — so
 * this must never be on for a CPU encoder. Set during init: requested DML,
 * then verified by timing a warm fixed-shape run (GPU ~115ms, CPU ~1.3s), so
 * a machine where DML silently fell back to CPU turns it off. A wrong "off"
 * costs nothing versus today; a wrong "on" would be the 8x regression.
 */
let padToFixedShape = false;

/**
 * Warm decode cost of REFERENCE_CLIP, measured once during init on whichever
 * engine won. Null until measured; see getWarmDecodeMs / isLivePreviewAffordable.
 */
let warmDecodeMs: number | null = null;

/** 0.5s @ 16kHz. The shared yardstick every engine is timed against. */
const REFERENCE_CLIP_SAMPLES = 8000;

/**
 * Decode the reference clip once, warm, and record the cost. Called by both
 * init paths so every engine is measured on identical input.
 *
 * Non-fatal by design: a failure here must not stop initialization, it just
 * leaves the measurement null, which reads as "cannot vouch for the speed" and
 * declines the optional work that depends on it.
 */
async function measureWarmDecode(alreadyWarm = false): Promise<void> {
    try {
        const clip = new Float32Array(REFERENCE_CLIP_SAMPLES);
        // A cold run measures graph setup, not steady-state cost. Skip the extra
        // pass where the caller has already made one — on a CPU fallback that
        // redundant decode would add over a second to startup.
        if (!alreadyWarm) await transcribeParakeet(clip);
        const t0 = Date.now();
        await transcribeParakeet(clip);
        warmDecodeMs = Date.now() - t0;
        console.log(`[Parakeet] Warm decode of the 0.5s reference: ${warmDecodeMs}ms`);
    } catch (e) {
        warmDecodeMs = null;
        console.warn('[Parakeet] Warm decode measurement failed (non-fatal):', e);
    }
}
/** Warm run slower than this means the encoder is NOT on the GPU. */
const FIXED_SHAPE_WARM_LIMIT_MS = 700;

/** When the current inference sessions were created (for preventive refresh). */
let sessionsBuiltAt = 0;
/** Transcriptions currently reading the sessions — never rebuild above zero. */
let inFlightTranscriptions = 0;
/** Reactive-rebuild throttle: no rebuild before this time (see decodeHealth). */
let nextReactiveRebuildAt = 0;
/** A decode looked degraded mid-recording — rebuild once the session is idle. */
let deferredRebuildWanted = false;

/**
 * Free ONNX sessions and swallow errors. Before this existed, every rebuild
 * LEAKED the replaced sessions — the DirectML encoder alone holds ~650MB of
 * GPU memory, so a run with several rebuilds degraded the whole machine's
 * inference speed until app restart.
 */
async function releaseSessions(sessions: Array<ort.InferenceSession | null>): Promise<void> {
    for (const s of sessions) {
        try {
            await s?.release();
        } catch (e) {
            console.warn('[Parakeet] Releasing an old session failed (continuing):', e);
        }
    }
}

async function rebuildSessions(): Promise<boolean> {
    const created: ort.InferenceSession[] = [];
    try {
        const modelDir = getModelDir();
        const providers = getExecutionProviders();
        console.warn('[Parakeet] Rebuilding inference sessions (suspected degraded session)…');
        const t0 = Date.now();
        // Build all three BEFORE swapping any, so a failure partway through
        // can't leave a mismatched encoder/decoder/joiner trio in place.
        const newEncoder = await ort.InferenceSession.create(
            join(modelDir, 'encoder.int8.onnx'), core.encoderSessionOptions(providers));
        created.push(newEncoder);
        const newDecoder = await ort.InferenceSession.create(
            join(modelDir, 'decoder.int8.onnx'), core.smallModelSessionOptions());
        created.push(newDecoder);
        const newJoiner = await ort.InferenceSession.create(
            join(modelDir, 'joiner.int8.onnx'), core.smallModelSessionOptions());
        created.push(newJoiner);

        const retired = [encoderSession, decoderSession, joinerSession];
        encoderSession = newEncoder;
        decoderSession = newDecoder;
        joinerSession = newJoiner;
        sessionsBuiltAt = Date.now();
        console.log(`[Parakeet] ✓ Sessions rebuilt in ${Date.now() - t0}ms`);

        // Release the replaced sessions only when nothing can be mid-run on
        // them: 0 in-flight (idle rebuild) or 1 (the inline retry's own
        // caller, whose first pass has already completed).
        if (inFlightTranscriptions <= 1) {
            await releaseSessions(retired);
        } else {
            console.warn('[Parakeet] Old sessions NOT released — another transcription may still be reading them.');
        }
        return true;
    } catch (e) {
        console.error('[Parakeet] Session rebuild failed — keeping existing sessions:', e);
        await releaseSessions(created); // don't leak a half-built trio
        return false;
    }
}

/**
 * Rebuild the sessions if they've aged past the threshold and nothing is using
 * them. Called AFTER a transcription, never before — the user already has
 * their text, so the ~1s rebuild is invisible. Fire-and-forget by design; a
 * failure here is harmless because the old sessions stay in place.
 */
let refreshRecheckTimer: ReturnType<typeof setTimeout> | null = null;

function maybeRefreshSessions(): void {
    if (useSidecar || !isInitialized) return;
    // Between streamed segments the in-flight count drops to zero, but the
    // recording (or its stop-time drain) is still live — swapping (and now
    // releasing) sessions there would stall the very next decode in the
    // queue. Idle means idle. A deferred rebuild can't fire from a decode's
    // own `finally` either (the session object still exists at that point),
    // so check back shortly after everything drains — the delay also keeps
    // the rebuild's CPU/GPU burst clear of the paste.
    if (isStreamingSessionInProgress() || inFlightTranscriptions > 0) {
        if (deferredRebuildWanted && !refreshRecheckTimer) {
            refreshRecheckTimer = setTimeout(() => {
                refreshRecheckTimer = null;
                maybeRefreshSessions();
            }, 5000);
            refreshRecheckTimer.unref?.();
        }
        return;
    }

    // A decode during the last recording looked degraded and the rebuild was
    // deferred to now (see transcribeSinglePass). Fire-and-forget: the user
    // already has their text.
    if (deferredRebuildWanted) {
        deferredRebuildWanted = false;
        if (Date.now() < nextReactiveRebuildAt) return; // throttled — the 4h preventive refresh still covers us
        nextReactiveRebuildAt = nextRebuildAllowedAt(Date.now(), true);
        console.log('[Parakeet] Deferred rebuild: a decode looked degraded during the last recording — rebuilding while idle');
        diag.sessionRefreshed();
        void rebuildSessions().then((ok) => {
            if (ok) return runSinglePass(new Float32Array(8000)).then(() => undefined);
        }).catch(() => { /* next dictation warms it instead */ });
        return;
    }

    if (!shouldRefreshSessions({ builtAt: sessionsBuiltAt, now: Date.now(), inFlight: inFlightTranscriptions })) return;
    const ageHours = ((Date.now() - sessionsBuiltAt) / 3_600_000).toFixed(1);
    console.log(`[Parakeet] Preventive refresh: sessions are ${ageHours}h old, rebuilding while idle`);
    diag.sessionRefreshed();
    void rebuildSessions().then((ok) => {
        // A fresh session has no compiled plan, and DirectML pins its fast
        // path to the FIRST shape it runs — so claim the sticky slot with the
        // one fixed production shape now, while idle, instead of letting the
        // next dictation pay the ~400ms compile.
        if (ok) return runSinglePass(new Float32Array(8000)).then(() => undefined);
    }).catch(() => { /* next dictation warms it instead */ });
}

/**
 * One mel → encoder → decode pass, with a health check on the result.
 *
 * If the decode shows signs of having eaten the user's speech (see
 * decodeHealth), rebuild the sessions and try ONCE more, keeping whichever
 * attempt reached further into the audio. Dropped speech is invisible until
 * the user re-reads what was pasted, so a rare extra second beats a confident
 * fragment.
 */
async function transcribeSinglePass(audioData: Float32Array): Promise<{
    text: string;
    melTime: number;
    encTime: number;
    decTime: number;
    lastTokenFrame: number;
    totalFrames: number;
}> {
    const first = await runSinglePass(audioData);
    // audioPeakRms lets the verdict pass quiet audio: an all-blank decode of
    // a breath or a lead-in pause is the decoder being right, not degraded.
    const verdict = assessDecode({ ...first, audioPeakRms: peakWindowRms(audioData) });
    if (!verdict.degraded) return first;
    diag.decodeDegraded();

    // Mid-recording (or during the stop-time drain), a rebuild would stall
    // the serialized decode queue for seconds — previews, real segments, and
    // the paste all wait behind it. Flag the suspicion instead;
    // maybeRefreshSessions rebuilds once everything is idle.
    if (isStreamingSessionInProgress()) {
        console.warn(`[Parakeet] ⚠ Degraded decode mid-recording (${verdict.reason}) — deferring session rebuild to idle.`);
        deferredRebuildWanted = true;
        return first;
    }

    // A recent rebuild whose retry changed nothing proved the decode is a
    // deterministic function of the audio — more rebuilds cannot help and
    // each costs seconds (see decodeHealth's throttle).
    if (Date.now() < nextReactiveRebuildAt) {
        console.warn(`[Parakeet] ⚠ Degraded decode (${verdict.reason}) — rebuild throttled, keeping the result.`);
        return first;
    }

    console.warn(`[Parakeet] ⚠ Degraded transcription: ${verdict.reason}. Rebuilding sessions and retrying once.`);
    if (!(await rebuildSessions())) return first;

    const second = await runSinglePass(audioData);
    const better = preferBetterDecode(first, second);
    nextReactiveRebuildAt = nextRebuildAllowedAt(Date.now(), better === second);
    if (better === second) {
        diag.decodeRecovered();
        console.log(`[Parakeet] ✓ Retry recovered speech (reached frame ${second.lastTokenFrame} vs ${first.lastTokenFrame})`);
    } else {
        console.warn('[Parakeet] Retry did not improve the result — keeping the original and backing off further rebuilds.');
    }
    return better;
}

async function runSinglePass(audioData: Float32Array): Promise<{
    text: string;
    melTime: number;
    encTime: number;
    decTime: number;
    lastTokenFrame: number;
    totalFrames: number;
    collapseRecoveries: number;
    blankRatio: number;
}> {
    const melStart = Date.now();
    const { features, nFrames, validFrames } = core.computeMelSpectrogram(audioData, 16000);
    const melTime = Date.now() - melStart;

    // Pad the mel width to the ONE fixed encoder shape (DML only — see
    // padToFixedShape). DirectML compiles its plan for the first shape a
    // session runs and re-JITs every run whose shape differs, so a unique
    // length per dictation meant a recompile every time.
    //
    // MEASURED IN THE REAL APP, not a benchmark: encoder went from ~360-575ms
    // (varying, recompiling) to ~284-305ms (fixed shape). ~140ms saved per
    // dictation, and the spread collapsed from ~200ms to ~20ms, which is the
    // point — cost is now predictable rather than a coin toss.
    //
    // An isolated Node process shows 115-133ms for the same call. The gap is
    // this process: Electron composites the UI on the same GPU. Do not quote
    // the isolated figure as the app's performance — that mistake was made
    // once already.
    //
    // Transcript-identical: the fill is each bin's own silence floor, and
    // validFrames still tells the encoder how much is real. Longer inputs run
    // at natural shape (rare; amortized).
    const padded = padToFixedShape
        ? core.padMelToWidth(features, nFrames, 128)
        : { features, frames: nFrames };
    if (padToFixedShape && padded.frames !== nFrames) {
        console.log(`[Parakeet] Encoder shape: ${nFrames} → ${padded.frames} frames (fixed)`);
    }

    // audio_signal: [1, 128, frames] — full spectrogram including edge frames
    const audioTensor = new ort.Tensor('float32', padded.features, [1, 128, padded.frames]);
    // length: valid frame count only — encoder ignores padding-contaminated edge frames
    // Reference: onnx-asr numpy_preprocessor.py:174 (features_lens = waveforms_lens // hop_length)
    const lengthTensor = new ort.Tensor('int64', BigInt64Array.from([BigInt(validFrames)]), [1]);

    // Run encoder
    const encoderInputs: Record<string, ort.Tensor> = {};
    encoderInputs[encoderSession!.inputNames[0]] = audioTensor;
    encoderInputs[encoderSession!.inputNames[1]] = lengthTensor;

    const encStart = Date.now();
    const encoderResult = await encoderSession!.run(encoderInputs);
    const encTime = Date.now() - encStart;

    const encoderOut = encoderResult[encoderSession!.outputNames[0]] as ort.Tensor;
    const encoderOutLens = encoderResult[encoderSession!.outputNames[1]] as ort.Tensor;
    const encoderLen = Number(encoderOutLens.data[0]);

    // Transducer greedy decode
    const decStart = Date.now();
    const { text, lastTokenFrame, totalFrames, collapseRecoveries, blankRatio } =
        await core.transducerGreedyDecode(encoderOut, encoderLen, decodeCtx());
    const decTime = Date.now() - decStart;

    return { text, melTime, encTime, decTime, lastTokenFrame, totalFrames, collapseRecoveries, blankRatio };
}

/**
 * Transcribe audio using Parakeet TDT
 *
 * For audio ≤60s: single-pass encoding (proven fast, zero overhead)
 * For audio >60s: VAD-based segmentation → per-segment single-pass → concatenate
 *
 * The VAD approach is the standard production method used by onnx-asr
 * (https://github.com/istupakov/onnx-asr) and NeMo's buffered inference scripts.
 * Each segment is capped at 28s by vadService.ts, well within single-pass encoder limits.
 */
export async function transcribeParakeet(
    audioData: Float32Array,
    options: { language?: string; onProgress?: (progress: number) => void; preview?: boolean } = {}
): Promise<string> {
    if (!isInitialized) {
        throw new Error('Parakeet not initialized');
    }
    // Hold the sessions open for the duration — the preventive refresh must
    // never swap them out from under a decode in progress.
    inFlightTranscriptions++;
    try {
        return await runTranscription(audioData, options);
    } finally {
        inFlightTranscriptions--;
        maybeRefreshSessions(); // idle moment: the user already has their text
    }
}

// --- Hybrid: Apple Neural Engine encoder + biased ONNX decode (macOS) ---
//
// The sidecar's CoreML joint model takes its own argmax on-device, so a custom
// term can never be boosted inside it. When the user has dictionary terms we
// therefore take the encoder output back from the ANE and decode it here.
// The encoder is ~80% of the work and stays on the Neural Engine; only the
// decode (~19ms for 7s of audio) moves, so the speed cost is close to nothing.
//
// Only the two small models are needed for this (~18MB), never the 622MB ONNX
// encoder, so a CoreML-only install stays CoreML-only.
let hybridDecodeReady = false;
let hybridUnavailable = false;

async function ensureHybridDecode(): Promise<boolean> {
    if (hybridDecodeReady) return true;
    if (hybridUnavailable) return false;
    if (decoderSession && joinerSession && vocabulary.length > 0) {
        hybridDecodeReady = true;
        return true;
    }
    try {
        const modelDir = getModelDir();
        const needed = MODEL_FILES.filter(f => f.name !== 'encoder.int8.onnx');
        for (const f of needed) {
            const p = join(modelDir, f.name);
            if (isModelFileValid(p, f.size)) continue;
            console.log(`[Parakeet] Hybrid bias: fetching ${f.label} (${(f.size / 1e6).toFixed(0)}MB)...`);
            try { require('fs').unlinkSync(p); } catch { /* absent */ }
            await downloadFile(`${MODEL_BASE_URL}/${f.name}`, p);
            if (!isModelFileValid(p, f.size)) throw new Error(`${f.name} failed validation`);
        }
        decoderSession ||= await ort.InferenceSession.create(
            join(modelDir, 'decoder.int8.onnx'), core.smallModelSessionOptions());
        joinerSession ||= await ort.InferenceSession.create(
            join(modelDir, 'joiner.int8.onnx'), core.smallModelSessionOptions());
        if (vocabulary.length === 0) vocabulary = core.loadTokens(join(modelDir, 'tokens.txt'));
        biasDirty = true; // trie must be rebuilt against the vocabulary just loaded
        hybridDecodeReady = true;
        console.log('[Parakeet] Hybrid bias decode ready (ANE encoder + ONNX decode)');
        return true;
    } catch (e) {
        console.warn('[Parakeet] Hybrid bias decode unavailable — sidecar stays unbiased:', e);
        hybridUnavailable = true;
        return false;
    }
}

/**
 * Returns the biased transcript, or null when the hybrid path does not apply
 * and the caller should use the sidecar's own end-to-end transcribe.
 *
 * Windows above ~15s is left to the sidecar: it chunks and merges long audio
 * internally, and reproducing that here would risk the long-audio path for a
 * case streaming already avoids (live segments are only a few seconds).
 */
async function tryHybridDecode(audioData: Float32Array): Promise<string | null> {
    if (audioData.length === 0 || audioData.length > sidecar.MAX_ENCODE_SAMPLES) return null;
    if (boostTerms.length === 0) return null;           // nothing to bias — keep the fast path
    if (!(await ensureHybridDecode())) return null;
    const bias = currentBias();
    if (!bias) return null;

    const enc = await sidecar.encode(audioData);
    const tensor = new ort.Tensor('float32', enc.data, [1, enc.hidden, enc.frames]);
    const out = await core.transducerGreedyDecode(tensor, enc.frames, { ...decodeCtx(), bias });
    return out.text;
}

/**
 * Last-resort decode for audio the collapse refuses to release: cut at the
 * quietest moment and decode the halves, recursing on a half that still
 * comes back empty. The deterministic DirectML collapse is a property of the
 * WINDOW, not the speech — in the logged failure (2026-08-31) a 3.8s segment
 * decoded to "" through both the single pass and an identical VAD window,
 * while a 1.3s preview of the same audio read "In table form." perfectly.
 * Smaller windows are the recovery that provably works.
 */
async function transcribeForcedSplit(audio: Float32Array, depth: number): Promise<string> {
    if (depth <= 0 || audio.length < 2 * 16000) return ''; // halves below ~1s decode poorly
    const cut = quietestSplitPoint(audio);
    const texts: string[] = [];
    for (const half of [audio.subarray(0, cut), audio.subarray(cut)]) {
        let text = (await transcribeSinglePass(half)).text.trim();
        if (!text && peakWindowRms(half) >= QUIET_PEAK_RMS) {
            text = await transcribeForcedSplit(half, depth - 1);
        }
        if (text) texts.push(text);
    }
    // The cut lands mid-utterance by construction — let the seam repair
    // lowercase a spuriously capitalized continuation.
    return joinSegments(texts.map(text => ({ text, forcedSplit: true })));
}

async function runTranscription(
    audioData: Float32Array,
    options: { language?: string; onProgress?: (progress: number) => void; preview?: boolean } = {}
): Promise<string> {

    const durationSeconds = audioData.length / 16000;

    // CoreML ANE sidecar path (default on Apple Silicon). It handles its own 15s
    // chunking internally. On any failure, drop to the ONNX path for the rest of
    // the session (lazy-loading the ONNX sessions if they were never loaded).
    if (useSidecar) {
        try {
            const sStart = Date.now();
            const hybrid = await tryHybridDecode(audioData);
            if (hybrid !== null) {
                const ms = Date.now() - sStart;
                console.log(`[Parakeet] \u2713 CoreML ANE + biased decode: ${ms}ms (${(durationSeconds / (ms / 1000)).toFixed(1)}x real-time): "${hybrid.substring(0, 80)}"`);
                return hybrid;
            }
            console.log(`[Parakeet] Transcribing ${durationSeconds.toFixed(1)}s via CoreML ANE sidecar...`);
            const text = await sidecar.transcribe(audioData);
            const ms = Date.now() - sStart;
            console.log(`[Parakeet] \u2713 CoreML sidecar: ${ms}ms (${(durationSeconds / (ms / 1000)).toFixed(1)}x real-time): "${text.substring(0, 80)}"`);
            return text;
        } catch (e) {
            console.warn('[Parakeet] CoreML sidecar failed \u2014 falling back to ONNX for this session:', e);
            useSidecar = false;
            await initParakeetOnnx();
        }
    }

    if (!encoderSession || !decoderSession || !joinerSession) {
        throw new Error('Parakeet not initialized (ONNX sessions unavailable)');
    }

    const startTime = Date.now();
    console.log(`[Parakeet] Transcribing ${durationSeconds.toFixed(1)}s...`);

    try {
        // Try-fast-fallback architecture:
        // 1. Try single-pass first (fastest: ~40-48x RT, ~1s for 35s audio)
        // 2. After completion, check coverage: lastTokenFrame / totalFrames
        // 3. If coverage < 85%, DirectML encoder tail corruption detected → retry
        //    with batched encoding (reliable: small VAD segments = zero collapses)
        // macOS: hard 60s limit due to CoreML SIGTRAP crash (not soft truncation)
        // Windows: try single-pass up to 120s, fallback if truncated
        const singlePassLimit = process.platform === 'darwin' ? 60 : 120;
        const COVERAGE_THRESHOLD = 0.85; // 85% — below this, consider truncated
        // Set when we fell through because a decode of voiced audio came back
        // empty — if the VAD retry ALSO comes back empty, escalate to the
        // forced-split decode instead of returning nothing.
        let emptyVoicedFallthrough = false;

        if (durationSeconds <= singlePassLimit) {
            const { text, melTime, encTime, decTime, lastTokenFrame, totalFrames } = await transcribeSinglePass(audioData);

            const totalTime = Date.now() - startTime;
            const rtf = durationSeconds / (totalTime / 1000);
            console.log(`[Parakeet] ⏱ Mel: ${melTime}ms | Encoder: ${encTime}ms | Decoder: ${decTime}ms | Total: ${totalTime}ms (${rtf.toFixed(1)}x real-time)`);

            // Check for DirectML encoder tail truncation
            const coverage = totalFrames > 0 ? lastTokenFrame / totalFrames : 1;
            const truncated = process.platform !== 'darwin' && coverage < COVERAGE_THRESHOLD && durationSeconds > 10;
            // An EMPTY decode of audio that clearly holds speech is the same
            // collapse wearing a shorter length — and it is deterministic:
            // a session rebuild reproduces it bit-for-bit, but decoding the
            // audio through different windows does not (both proven in logs,
            // 2026-08-31, where "at eight thirty AM" decoded to "" single-pass
            // while a shorter preview of the same audio heard "At eight").
            // So retry through the VAD-segmented path below. Previews are
            // exempt: they redecode moments later anyway, and the retry's
            // ~0.5s would stall the live queue for display-only text.
            const ateSpeech = !options.preview && text.trim() === '' && durationSeconds >= 1
                && peakWindowRms(audioData) >= QUIET_PEAK_RMS;
            if (truncated) {
                console.log(`[Parakeet] ⚠ Truncation detected: last token at ${(coverage * 100).toFixed(0)}% coverage (frame ${lastTokenFrame}/${totalFrames}). Retrying with batched encoding...`);
                // Fall through to batched encoding below
            } else if (ateSpeech) {
                console.log(`[Parakeet] ⚠ Empty decode of voiced audio (${durationSeconds.toFixed(1)}s, peak RMS ${peakWindowRms(audioData).toFixed(4)}). Retrying with VAD segmentation...`);
                emptyVoicedFallthrough = true;
                // Fall through to batched encoding below
            } else {
                console.log(`[Parakeet] Result: "${text.substring(0, 80)}"`);
                return text;
            }
        }

        // Long audio: VAD-based segmentation with BATCHED encoding
        // Reference: onnx-asr vad.py:114-124 (pad_list + recognize_batch pattern)
        // Instead of running the encoder once per segment (paying ~300ms DirectML
        // overhead each time), we batch up to 8 segments into a single encoder call.
        // This gives near-single-pass speed with segmented reliability.
        console.log(`[Parakeet] Long audio (${durationSeconds.toFixed(1)}s) — using VAD segmentation + batched encoding`);

        let audioSegments: Float32Array[];

        if (isVADReady()) {
            const segments = await detectSpeechSegments(audioData, 16000);
            audioSegments = segments.map(seg => audioData.slice(seg.startSample, seg.endSample));
            console.log(`[Parakeet] VAD: ${audioSegments.length} segments (${audioSegments.map(s => (s.length / 16000).toFixed(1) + 's').join(', ')})`);

            // We came here to escape a window that collapsed. If VAD hands
            // back essentially that same window (one all-speech segment), the
            // batched decode would reproduce the collapse bit-for-bit — ~0.5s
            // for nothing, measured. Go straight to forced sub-windows.
            if (emptyVoicedFallthrough && audioSegments.length === 1 && audioSegments[0].length >= 0.9 * audioData.length) {
                console.log('[Parakeet] VAD returned the same window — skipping to forced sub-window decode');
                const forced = await transcribeForcedSplit(audioData, 3);
                if (forced) console.log(`[Parakeet] ✓ Forced split recovered: "${forced.substring(0, 80)}"`);
                else console.log('[Parakeet] Forced split found no speech either.');
                return forced;
            }
        } else {
            // Fallback: fixed 30s chunks (no VAD available)
            console.warn('[Parakeet] VAD not ready, using fixed 30s chunks');
            audioSegments = [];
            const chunkSamples = 30 * 16000;
            for (let offset = 0; offset < audioData.length; offset += chunkSamples) {
                audioSegments.push(audioData.slice(offset, Math.min(offset + chunkSamples, audioData.length)));
            }
        }

        // Batched encode + decode
        // Reference: onnx-asr vad.py:114 — while batch := tuple(islice(segment, batch_size))
        const BATCH_SIZE = 8; // onnx-asr default: batch_size=8
        const texts: string[] = [];
        let totalMel = 0, totalEnc = 0, totalDec = 0;

        for (let batchStart = 0; batchStart < audioSegments.length; batchStart += BATCH_SIZE) {
            const batch = audioSegments.slice(batchStart, batchStart + BATCH_SIZE);
            const N = batch.length;

            // 1. Compute mel spectrograms for all segments in this batch
            const melStart = Date.now();
            const melResults = batch.map(seg => core.computeMelSpectrogram(seg, 16000));
            totalMel += Date.now() - melStart;

            // 2. Pad to max frame count and stack into batch tensor [N, 128, maxFrames]
            // Reference: onnx-asr utils.pad_list — pads variable-length arrays to equal length
            const maxFrames = Math.max(...melResults.map(m => m.nFrames));
            const batchedFeatures = new Float32Array(N * 128 * maxFrames); // zero-initialized
            const validFramesList: bigint[] = [];

            for (let i = 0; i < N; i++) {
                const { features, nFrames, validFrames } = melResults[i];
                validFramesList.push(BigInt(validFrames));
                // Copy [128, nFrames] into batch position [i, 128, maxFrames]
                // Layout is row-major: batch[i][mel][frame]
                for (let mel = 0; mel < 128; mel++) {
                    const srcOffset = mel * nFrames;
                    const dstOffset = i * 128 * maxFrames + mel * maxFrames;
                    batchedFeatures.set(
                        features.subarray(srcOffset, srcOffset + nFrames),
                        dstOffset
                    );
                    // Remaining positions already 0 (Float32Array default = zero-pad)
                }
            }

            // 3. Run encoder ONCE for the entire batch
            const audioTensor = new ort.Tensor('float32', batchedFeatures, [N, 128, maxFrames]);
            const lengthTensor = new ort.Tensor('int64', BigInt64Array.from(validFramesList), [N]);

            const encoderInputs: Record<string, ort.Tensor> = {};
            encoderInputs[encoderSession!.inputNames[0]] = audioTensor;
            encoderInputs[encoderSession!.inputNames[1]] = lengthTensor;

            const batchLabel = `batch ${Math.floor(batchStart / BATCH_SIZE) + 1}/${Math.ceil(audioSegments.length / BATCH_SIZE)}`;
            console.log(`[Parakeet] Encoding ${batchLabel}: ${N} segments (${batch.map(s => (s.length / 16000).toFixed(1) + 's').join(', ')})`);

            const encStart = Date.now();
            const encoderResult = await encoderSession!.run(encoderInputs);
            const encTime = Date.now() - encStart;
            totalEnc += encTime;
            console.log(`[Parakeet] Encoder ${batchLabel}: ${encTime}ms`);

            const encoderOut = encoderResult[encoderSession!.outputNames[0]] as ort.Tensor;
            const encoderOutLens = encoderResult[encoderSession!.outputNames[1]] as ort.Tensor;

            // Encoder output shape: [N, D, T_max_out]
            const D = encoderOut.dims[1] as number; // 1024
            const T_out = encoderOut.dims[2] as number;
            const encoderData = encoderOut.data as Float32Array;

            // 4. Decode all batch elements CONCURRENTLY. Each decode is an
            // independent greedy loop over its own encoder slice (own state,
            // own reusable buffers), and ONNX Runtime sessions are safe for
            // concurrent run() calls — so N segments decode in parallel on the
            // CPU instead of serially, cutting long-audio decode wall-time.
            // Results are collected by index so text order is preserved.
            const decStart = Date.now();
            const segTexts = await Promise.all(
                Array.from({ length: N }, (_, i) => {
                    const segLen = Number(encoderOutLens.data[i]);

                    // Extract this segment's encoder output: [1, D, T_out] slice
                    // from batch layout [N, D, T] (element i at offset i*D*T_out)
                    const segData = new Float32Array(D * T_out);
                    const batchOffset = i * D * T_out;
                    segData.set(encoderData.subarray(batchOffset, batchOffset + D * T_out));

                    const segEncoderOut = new ort.Tensor('float32', segData, [1, D, T_out]);
                    return core.transducerGreedyDecode(segEncoderOut, segLen, decodeCtx())
                        .then(r => r.text.trim());
                })
            );
            for (const t of segTexts) {
                if (t) texts.push(t);
            }
            totalDec += Date.now() - decStart;
        }

        // VAD splits on pauses, which can fall mid-sentence — the model then
        // capitalizes each segment's first word as if it began an utterance.
        // Repair those seams instead of joining blindly (see segmentJoin).
        const fullText = joinSegments(texts);
        const totalTime = Date.now() - startTime;
        const rtf = durationSeconds / (totalTime / 1000);
        console.log(`[Parakeet] ⏱ Mel: ${totalMel}ms | Encoder: ${totalEnc}ms | Decoder: ${totalDec}ms | Total: ${totalTime}ms (${rtf.toFixed(1)}x real-time)`);
        console.log(`[Parakeet] Result (${audioSegments.length} segments): "${fullText.substring(0, 80)}"`);

        // VAD can hand back essentially the same window it was asked to save
        // (one all-speech segment) — the deterministic collapse then repeats
        // and the retry changes nothing. Decode through FORCED smaller
        // windows before giving speech up as lost.
        if (!fullText.trim() && emptyVoicedFallthrough) {
            console.log('[Parakeet] ⚠ VAD retry still empty — forcing sub-window decode');
            const forced = await transcribeForcedSplit(audioData, 3);
            if (forced) {
                console.log(`[Parakeet] ✓ Forced split recovered: "${forced.substring(0, 80)}"`);
                return forced;
            }
            console.log('[Parakeet] Forced split found no speech either.');
        }
        return fullText;
    } catch (error) {
        console.error('[Parakeet] Transcription failed:', error);
        throw error;
    }
}

export function isParakeetAvailable(): boolean {
    return isInitialized;
}

/**
 * Warm cost of one decode of the 0.5s reference clip, measured during init on
 * whichever engine actually ended up active. Null until init has timed it.
 *
 * Every path times the SAME input, so the number is comparable across engines
 * and can gate work by what it costs rather than by which platform it is on.
 */
export function getWarmDecodeMs(): number | null {
    return isInitialized ? warmDecodeMs : null;
}

/**
 * Is a mid-segment preview decode cheap enough to run while the user is still
 * speaking? Previews re-decode the whole open segment and share the serialized
 * decode queue, so on a slow engine they would starve the real segment decodes
 * and delay the finalize at stop.
 *
 * Gated on the measured warm decode, never on process.platform. Measured on the
 * 0.5s reference: CoreML ANE sidecar 33ms, DirectML at the fixed shape ~115ms,
 * ONNX CPU fallback ~1300ms. The limit sits in the wide gap between the engines
 * that can afford it and the one that cannot, so new hardware is classified by
 * what it actually does rather than by a list someone has to remember to update.
 */
export const LIVE_PREVIEW_WARM_LIMIT_MS = 300;

export function isLivePreviewAffordable(): boolean {
    const warm = getWarmDecodeMs();
    return warm !== null && warm <= LIVE_PREVIEW_WARM_LIMIT_MS;
}

export function isLanguageSupported(language: string): boolean {
    const SUPPORTED = [
        'en', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'pl', 'uk', 'cs',
        'ro', 'hu', 'sv', 'bg', 'da', 'fi', 'el', 'hr', 'lt', 'sk',
        'sl', 'et', 'lv', 'no', 'ca'
    ];
    if (language === 'auto') return true;
    return SUPPORTED.includes(language);
}

export function getParakeetInfo(): { available: boolean; model: string; languages: number; engine: string } {
    return {
        available: isInitialized,
        model: useSidecar ? 'Parakeet TDT 0.6B-v3 (CoreML/ANE)' : 'Parakeet TDT 0.6B-v3 (INT8)',
        languages: 25,
        engine: useSidecar ? 'coreml-ane' : 'onnx',
    };
}

export function cleanupParakeet(): void {
    if (useSidecar) sidecar.cleanup();
    useSidecar = false;
    encoderSession = null;
    decoderSession = null;
    joinerSession = null;
    vocabulary = [];
    isInitialized = false;
}
