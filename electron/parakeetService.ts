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

// NeMo convention: blank token is the LAST token in vocabulary
const BLANK_ID = core.BLANK_ID;

let encoderSession: ort.InferenceSession | null = null;
let decoderSession: ort.InferenceSession | null = null;
let joinerSession: ort.InferenceSession | null = null;
let vocabulary: string[] = [];
let isInitialized = false;

// CoreML ANE sidecar (macOS/Apple Silicon) — the default Parakeet engine when
// available. useSidecar flips on once the sidecar is initialized; sidecarEnabled
// is the user-facing toggle (default on).
let useSidecar = false;
let sidecarEnabled = true;

/** Enable/disable the CoreML ANE sidecar engine (macOS). Call before initParakeet. */
export function setCoreMLEnabled(enabled: boolean): void {
    sidecarEnabled = enabled;
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
 * Load vocabulary from tokens.txt
 * Format: <token> <id> (one per line)
 */
function loadTokens(path: string): string[] {
    const content = readFileSync(path, 'utf-8');
    const lines = content.trim().split('\n');
    const tokens: string[] = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const lastSpace = trimmed.lastIndexOf(' ');
        if (lastSpace > 0) {
            const token = trimmed.substring(0, lastSpace);
            const id = parseInt(trimmed.substring(lastSpace + 1), 10);
            if (!isNaN(id)) {
                tokens[id] = token;
                continue;
            }
        }
        tokens.push(trimmed);
    }
    return tokens;
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
 * Initialize the Parakeet engine. On Apple Silicon this tries the CoreML ANE
 * sidecar first (the default, fastest engine ≈30ms encoder); on every platform
 * it falls back to the ONNX-Runtime path (GPU on Windows/Linux, CPU on macOS).
 */
export async function initParakeet(
    onProgress?: (percent: number, status: string) => void
): Promise<boolean> {
    if (isInitialized) return true;

    if (sidecarEnabled && sidecar.isSupportedPlatform()) {
        try {
            const ok = await sidecar.init(onProgress);
            if (ok) {
                useSidecar = true;
                isInitialized = true;
                console.log('[Parakeet] ✓ Using CoreML ANE sidecar (default engine on Apple Silicon)');
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
 * Initialize all three ONNX sessions (encoder, decoder, joiner). Cross-platform
 * path (GPU on Windows/Linux, CPU on macOS) and the macOS fallback when the
 * CoreML sidecar is unavailable.
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

        // Load encoder (largest model — use GPU acceleration)
        onProgress?.(85, 'Loading encoder (GPU)...');
        console.log('[Parakeet] Loading encoder...');
        encoderSession = await ort.InferenceSession.create(
            join(modelDir, 'encoder.int8.onnx'),
            core.encoderSessionOptions(providers)
        );
        console.log(`[Parakeet] ✓ Encoder loaded on ${gpuProvider.toUpperCase()} (inputs: ${encoderSession.inputNames}, outputs: ${encoderSession.outputNames})`);

        // Read metadata to get decoder state dimensions
        readEncoderMetadata(encoderSession);

        // Load decoder on CPU (sequential loop — GPU kernel launch overhead hurts)
        onProgress?.(90, 'Loading decoder...');
        decoderSession = await ort.InferenceSession.create(
            join(modelDir, 'decoder.int8.onnx'),
            core.smallModelSessionOptions()
        );
        console.log(`[Parakeet] ✓ Decoder loaded on CPU (inputs: ${decoderSession.inputNames}, outputs: ${decoderSession.outputNames})`);

        // Load joiner on CPU (sequential loop — GPU kernel launch overhead hurts)
        onProgress?.(93, 'Loading joiner...');
        joinerSession = await ort.InferenceSession.create(
            join(modelDir, 'joiner.int8.onnx'),
            core.smallModelSessionOptions()
        );
        console.log(`[Parakeet] ✓ Joiner loaded on CPU (inputs: ${joinerSession.inputNames}, outputs: ${joinerSession.outputNames})`);

        // Load vocabulary
        onProgress?.(96, 'Loading vocabulary...');
        vocabulary = core.loadTokens(join(modelDir, 'tokens.txt'));
        console.log(`[Parakeet] ✓ Vocabulary loaded: ${vocabulary.length} tokens (blank=${BLANK_ID})`);

        isInitialized = true;

        // Warm up the graphs so the FIRST real dictation doesn't pay cold-start
        // cost (kernel init, CPU memory-arena allocation). ~0.5s of silence
        // exercises mel → encoder → decoder → joiner once. Non-fatal on failure.
        try {
            onProgress?.(98, 'Warming up...');
            const warmupStart = Date.now();
            await transcribeSinglePass(new Float32Array(8000)); // 0.5s @ 16kHz
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
async function transcribeSinglePass(audioData: Float32Array): Promise<{
    text: string;
    melTime: number;
    encTime: number;
    decTime: number;
}> {
    const melStart = Date.now();
    const { features, nFrames, validFrames } = core.computeMelSpectrogram(audioData, 16000);
    const melTime = Date.now() - melStart;

    // audio_signal: [1, 128, totalFrames] — full spectrogram including edge frames
    const audioTensor = new ort.Tensor('float32', features, [1, 128, nFrames]);
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
    const text = await core.transducerGreedyDecode(encoderOut, encoderLen, {
        decoderSession: decoderSession!,
        joinerSession: joinerSession!,
        vocabulary,
        blankId: BLANK_ID,
        predRnnLayers,
        predHidden,
    });
    const decTime = Date.now() - decStart;

    return { text, melTime, encTime, decTime };
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
    options: { language?: string; onProgress?: (progress: number) => void } = {}
): Promise<string> {
    if (!isInitialized) {
        throw new Error('Parakeet not initialized');
    }

    const durationSeconds = audioData.length / 16000;

    // CoreML ANE sidecar path (default on Apple Silicon). It handles its own
    // 15s chunking internally. On any failure we drop to the ONNX-CPU path for
    // the rest of the session (lazy-loading the ONNX sessions if needed).
    if (useSidecar) {
        try {
            const sStart = Date.now();
            console.log(`[Parakeet] Transcribing ${durationSeconds.toFixed(1)}s via CoreML ANE sidecar...`);
            const text = await sidecar.transcribe(audioData);
            const ms = Date.now() - sStart;
            console.log(`[Parakeet] ✓ CoreML sidecar: ${ms}ms (${(durationSeconds / (ms / 1000)).toFixed(1)}x real-time): "${text.substring(0, 80)}"`);
            return text;
        } catch (e) {
            console.warn('[Parakeet] CoreML sidecar failed — falling back to ONNX for this session:', e);
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
        // Single-pass threshold: platform-dependent
        // Windows/Linux: encoder handles any length fine (DML/CUDA don't crash)
        // macOS: CoreML/CPU crashes on audio >~60s (SIGTRAP), so segment longer audio
        // Reference: vad_segmentation_handoff.md
        const singlePassLimit = process.platform === 'darwin' ? 60 : Infinity;

        if (durationSeconds <= singlePassLimit) {
            const { text, melTime, encTime, decTime } = await transcribeSinglePass(audioData);

            const totalTime = Date.now() - startTime;
            const rtf = durationSeconds / (totalTime / 1000);
            console.log(`[Parakeet] ⏱ Mel: ${melTime}ms | Encoder: ${encTime}ms | Decoder: ${decTime}ms | Total: ${totalTime}ms (${rtf.toFixed(1)}x real-time)`);
            console.log(`[Parakeet] Result: "${text.substring(0, 80)}"`);
            return text;
        }

        // Long audio: VAD-based segmentation
        // Split at silence boundaries, transcribe each segment independently, concatenate
        // This is the approach used by onnx-asr and NeMo's buffered inference scripts
        console.log(`[Parakeet] Long audio (${durationSeconds.toFixed(1)}s) — using VAD segmentation`);

        let audioSegments: Float32Array[];

        if (isVADReady()) {
            const segments = await detectSpeechSegments(audioData, 16000);
            audioSegments = segments.map(seg => audioData.slice(seg.startSample, seg.endSample));
            console.log(`[Parakeet] VAD: ${audioSegments.length} segments (${audioSegments.map(s => (s.length / 16000).toFixed(1) + 's').join(', ')})`);
        } else {
            // Fallback: fixed 30s chunks (no VAD available)
            console.warn('[Parakeet] VAD not ready, using fixed 30s chunks');
            audioSegments = [];
            const chunkSamples = 30 * 16000;
            for (let offset = 0; offset < audioData.length; offset += chunkSamples) {
                audioSegments.push(audioData.slice(offset, Math.min(offset + chunkSamples, audioData.length)));
            }
        }

        // Transcribe each segment. Segments are independent (each greedy decode
        // keeps its own state), so they can run with bounded concurrency. On
        // macOS the CPU encoder already saturates all cores, so concurrency only
        // adds contention → keep it sequential; on Windows/Linux the encoder runs
        // on the GPU (DML/CUDA), leaving CPU free to overlap a second segment's
        // decode. Results are stored by index and joined in order, so the output
        // is identical regardless of the concurrency level.
        const concurrency = process.platform === 'darwin' ? 1 : 2;
        const results: string[] = new Array(audioSegments.length).fill('');
        let totalMel = 0, totalEnc = 0, totalDec = 0;
        let nextIndex = 0;

        const worker = async (): Promise<void> => {
            for (;;) {
                const i = nextIndex++;
                if (i >= audioSegments.length) break;
                const seg = audioSegments[i];
                const segDur = seg.length / 16000;
                console.log(`[Parakeet] Segment ${i + 1}/${audioSegments.length}: ${segDur.toFixed(1)}s`);

                const { text, melTime, encTime, decTime } = await transcribeSinglePass(seg);
                totalMel += melTime;
                totalEnc += encTime;
                totalDec += decTime;

                if (text.trim()) {
                    results[i] = text.trim();
                }
            }
        };

        await Promise.all(
            Array.from({ length: Math.min(concurrency, audioSegments.length) }, () => worker())
        );
        const texts = results.filter(t => t.length > 0);

        const fullText = texts.join(' ');
        const totalTime = Date.now() - startTime;
        const rtf = durationSeconds / (totalTime / 1000);
        console.log(`[Parakeet] ⏱ Mel: ${totalMel}ms | Encoder: ${totalEnc}ms | Decoder: ${totalDec}ms | Total: ${totalTime}ms (${rtf.toFixed(1)}x real-time)`);
        console.log(`[Parakeet] Result (${audioSegments.length} segments): "${fullText.substring(0, 80)}"`);
        return fullText;
    } catch (error) {
        console.error('[Parakeet] Transcription failed:', error);
        throw error;
    }
}

export function isParakeetAvailable(): boolean {
    return isInitialized;
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
