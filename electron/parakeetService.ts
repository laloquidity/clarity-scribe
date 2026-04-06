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
const BLANK_ID = 8192;

let encoderSession: ort.InferenceSession | null = null;
let decoderSession: ort.InferenceSession | null = null;
let joinerSession: ort.InferenceSession | null = null;
let vocabulary: string[] = [];
let isInitialized = false;

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
 * Initialize all three ONNX sessions (encoder, decoder, joiner)
 */
export async function initParakeet(
    onProgress?: (percent: number, status: string) => void
): Promise<boolean> {
    if (isInitialized) return true;

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
            {
                executionProviders: providers,
                logSeverityLevel: 3,
                graphOptimizationLevel: 'all',
            }
        );
        console.log(`[Parakeet] ✓ Encoder loaded on ${gpuProvider.toUpperCase()} (inputs: ${encoderSession.inputNames}, outputs: ${encoderSession.outputNames})`);

        // Read metadata to get decoder state dimensions
        readEncoderMetadata(encoderSession);

        // Load decoder on CPU (sequential loop — GPU kernel launch overhead hurts)
        onProgress?.(90, 'Loading decoder...');
        decoderSession = await ort.InferenceSession.create(
            join(modelDir, 'decoder.int8.onnx'),
            {
                executionProviders: ['cpu'],
                logSeverityLevel: 3,
            }
        );
        console.log(`[Parakeet] ✓ Decoder loaded on CPU (inputs: ${decoderSession.inputNames}, outputs: ${decoderSession.outputNames})`);

        // Load joiner on CPU (sequential loop — GPU kernel launch overhead hurts)
        onProgress?.(93, 'Loading joiner...');
        joinerSession = await ort.InferenceSession.create(
            join(modelDir, 'joiner.int8.onnx'),
            {
                executionProviders: ['cpu'],
                logSeverityLevel: 3,
            }
        );
        console.log(`[Parakeet] ✓ Joiner loaded on CPU (inputs: ${joinerSession.inputNames}, outputs: ${joinerSession.outputNames})`);

        // Load vocabulary
        onProgress?.(96, 'Loading vocabulary...');
        vocabulary = loadTokens(join(modelDir, 'tokens.txt'));
        console.log(`[Parakeet] ✓ Vocabulary loaded: ${vocabulary.length} tokens (blank=${BLANK_ID})`);

        isInitialized = true;
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
 * Create initial decoder LSTM states (all zeros)
 * Shape: [pred_rnn_layers, batch_size, pred_hidden] — two state tensors (h, c)
 */
function getDecoderInitStates(): ort.Tensor[] {
    const size = predRnnLayers * 1 * predHidden;
    const s0 = new ort.Tensor('float32', new Float32Array(size), [predRnnLayers, 1, predHidden]);
    const s1 = new ort.Tensor('float32', new Float32Array(size), [predRnnLayers, 1, predHidden]);
    return [s0, s1];
}

/**
 * Run decoder: targets + target_length + states → output + next_states
 *
 * Verified tensor names (from model inspection):
 *   inputs:  targets, target_length, states.1, onnx::Slice_3
 *   outputs: outputs, prednet_lengths, states, 162
 */
async function runDecoder(
    targets: ort.Tensor,
    targetLength: ort.Tensor,
    states: ort.Tensor[]
): Promise<{ output: ort.Tensor; nextStates: ort.Tensor[] }> {
    const result = await decoderSession!.run({
        'targets': targets,
        'target_length': targetLength,
        'states.1': states[0],
        'onnx::Slice_3': states[1],
    });

    // outputs: [0]=decoder_output, [1]=prednet_lengths, [2:]=next_states
    const outputNames = decoderSession!.outputNames;
    const decoderOutput = result[outputNames[0]] as ort.Tensor;
    const nextStates: ort.Tensor[] = [];
    for (let i = 2; i < outputNames.length; i++) {
        nextStates.push(result[outputNames[i]] as ort.Tensor);
    }

    return { output: decoderOutput, nextStates };
}

/**
 * Run joiner: encoder_out + decoder_out → logits
 *
 * Verified tensor names (from model inspection):
 *   inputs:  encoder_outputs, decoder_outputs
 *   outputs: outputs
 */
async function runJoiner(
    encoderOut: ort.Tensor,
    decoderOut: ort.Tensor
): Promise<ort.Tensor> {
    const result = await joinerSession!.run({
        'encoder_outputs': encoderOut,
        'decoder_outputs': decoderOut,
    });
    return result[joinerSession!.outputNames[0]] as ort.Tensor;
}

/**
 * Transducer greedy search decoding (TDT variant)
 *
 * Standard RNN-T / TDT algorithm from sherpa-onnx:
 * 1. Initialize decoder with blank token + zero states
 * 2. For each encoder timestep t:
 *    a. Run decoder(prev_token, states) → prediction + new_states
 *    b. Run joiner(encoder[t], prediction) → logits
 *    c. For TDT: logits has vocab_size + num_durations values
 *    d. Pick argmax from vocab portion
 *    e. If not blank → emit token, advance decoder state
 *    f. If blank → pick duration from duration portion, skip frames
 */
async function transducerGreedyDecode(
    encoderOut: ort.Tensor,
    encoderOutLen: number,
): Promise<string> {
    if (!decoderSession || !joinerSession) {
        throw new Error('Decoder/Joiner not initialized');
    }

    const vocabSize = vocabulary.length; // 8193 (including blank at 8192)
    // Encoder output is [B, D, T] = [1, 1024, T] (verified by automated test)
    const D = encoderOut.dims[1] as number; // 1024 (feature dim)
    const T = encoderOut.dims[2] as number; // time frames
    const encoderData = encoderOut.data as Float32Array;
    const tokens: number[] = [];

    // Initialize decoder state
    let decoderStates = getDecoderInitStates();
    let prevToken = BLANK_ID;

    // TDT greedy decode — matching sherpa-onnx reference implementation exactly
    // See: offline-transducer-greedy-search-nemo-decoder.cc DecodeOneTDT()
    const maxTokensPerFrame = 10; // Matches onnx-asr reference: nemo.py max_tokens_per_step
    let tokensThisFrame = 0;
    let skip = 1; // frames to advance

    for (let t = 0; t < encoderOutLen; t += skip) {
        // Extract encoder output at timestep t: shape [1, D, 1]
        // Data layout [B, D, T]: data[d * T + t] for feature d at timestep t
        const encSlice = new Float32Array(D);
        for (let d = 0; d < D; d++) {
            encSlice[d] = encoderData[d * T + t];
        }
        const encTensor = new ort.Tensor('float32', encSlice, [1, D, 1]);

        // Create decoder input: previous token (NeMo expects int32)
        const targets = new ort.Tensor('int32', Int32Array.from([prevToken]), [1, 1]);
        const targetLen = new ort.Tensor('int32', Int32Array.from([1]), [1]);

        // Run decoder
        const { output: decoderOut, nextStates } = await runDecoder(targets, targetLen, decoderStates);

        // Run joiner
        const logits = await runJoiner(encTensor, decoderOut);
        const logitsData = logits.data as Float32Array;

        // TDT: joiner output = [vocab_size + num_durations]
        const numDurations = logitsData.length - vocabSize;

        // Argmax over vocab portion (token logits)
        let y = 0;
        let maxVal = logitsData[0];
        for (let i = 1; i < vocabSize; i++) {
            if (logitsData[i] > maxVal) {
                maxVal = logitsData[i];
                y = i;
            }
        }

        // Argmax over duration portion (duration logits)
        skip = 0;
        if (numDurations > 0) {
            let durMax = logitsData[vocabSize];
            for (let i = 1; i < numDurations; i++) {
                if (logitsData[vocabSize + i] > durMax) {
                    durMax = logitsData[vocabSize + i];
                    skip = i;
                }
            }
            // Duration prediction used directly — matches onnx-asr reference (no cap)
            // A/B tested: no quality difference vs maxSkip=3, but cap causes truncation on long audio
        }

        if (y !== BLANK_ID) {
            // Non-blank token: emit and update decoder state
            tokens.push(y);
            prevToken = y;
            decoderStates = nextStates;
            tokensThisFrame += 1;
        }

        // Frame advancement logic — aligned with onnx-asr reference (elif pattern)
        // Reference: https://github.com/istupakov/onnx-asr/blob/main/src/onnx_asr/asr.py#L227
        if (skip > 0) {
            // Model predicted a skip: advance by skip frames
            tokensThisFrame = 0;
        } else if (y === BLANK_ID || tokensThisFrame >= maxTokensPerFrame) {
            // Blank with no skip, or max tokens reached: advance by 1 frame
            tokensThisFrame = 0;
            skip = 1;
        }
        // When y != BLANK_ID and skip == 0: stay on same frame (emit more tokens)
    }

    console.log(`[Parakeet] Decode: ${tokens.length} tokens from ${encoderOutLen} frames`);
    return tokensToText(tokens);
}

/**
 * Convert token IDs to readable text
 * NeMo uses SentencePiece-style tokens: ▁ = word boundary (space)
 * Special tokens (< >) are filtered out
 * Post-processing: clean up leading/trailing dots from silence
 */
function tokensToText(tokenIds: number[]): string {
    const parts: string[] = [];
    for (const id of tokenIds) {
        if (id >= 0 && id < vocabulary.length) {
            const token = vocabulary[id];
            // Skip special tokens
            if (token.startsWith('<') && token.endsWith('>')) continue;
            parts.push(token);
        }
    }
    let text = parts.join('');
    text = text.replace(/▁/g, ' ');  // SentencePiece word boundary

    // Clean up artifacts from silence/noise at start
    text = text.replace(/^[\s.]+/, '');          // Strip leading dots/whitespace from silence
    text = text.replace(/\.{3,}/g, '...');       // Collapse excessive dots but preserve ellipsis
    text = text.trim();

    // Let the model's own punctuation stand — forced periods create artifacts
    // at VAD segment boundaries ("I was saying. That we should.")

    // Capitalize first letter
    if (text.length > 0) {
        text = text.charAt(0).toUpperCase() + text.slice(1);
    }

    return text;
}

/**
 * Compute 128-channel log-mel spectrogram for NeMo FastConformer encoder
 *
 * Matches sherpa-onnx's kaldi-native-fbank feature extraction:
 *   - No dithering (dither=0)
 *   - No preemphasis (NeMo FastConformer doesn't use it)
 *   - 25ms Hann window (periodic), 10ms hop, 512-pt FFT
 *   - 128 mel filterbanks, low_freq=20, high_freq=7600
 *   - Log compression with epsilon guard
 *   - Per-feature normalization (zero mean, unit variance per mel channel)
 *   - Audio samples in [-1,1] range (normalize_samples=true)
 *
 * Output shape: [nMels, nFrames] stored row-major (C, T)
 */
function computeMelSpectrogram(audio: Float32Array, sampleRate: number = 16000): { features: Float32Array; nFrames: number } {
    const nMels = 128;
    const windowSize = Math.round(sampleRate * 0.025); // 25ms = 400 samples
    const hopSize = Math.round(sampleRate * 0.01);     // 10ms = 160 samples
    const fftSize = 512;
    const nBins = fftSize / 2 + 1; // 257

    // No dithering, no preemphasis — matching sherpa-onnx defaults
    // Audio is already in [-1,1] float range (normalize_samples=true)

    // snip_edges=false: pad signal so we don't lose edge frames
    const padLength = Math.floor(windowSize / 2);
    const paddedLength = audio.length + 2 * padLength;
    const padded = new Float32Array(paddedLength);
    // Reflect padding
    for (let i = 0; i < padLength; i++) {
        padded[i] = audio[padLength - 1 - i] || 0;
    }
    padded.set(audio, padLength);
    for (let i = 0; i < padLength; i++) {
        padded[padLength + audio.length + i] = audio[audio.length - 1 - i] || 0;
    }

    const nFrames = Math.max(1, Math.floor((paddedLength - windowSize) / hopSize) + 1);

    // Periodic Hann window (matching torch.hann_window(periodic=True))
    const window = new Float32Array(windowSize);
    for (let i = 0; i < windowSize; i++) {
        window[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / windowSize));
    }

    // Mel filterbank: low_freq=20, high_freq=7600 (matching Kaldi/sherpa-onnx)
    const melFilters = createMelFilterbank(sampleRate, fftSize, nMels, 20, 7600);

    // STFT → power spectrum → mel → log
    const features = new Float32Array(nMels * nFrames);

    for (let frame = 0; frame < nFrames; frame++) {
        const start = frame * hopSize;

        // Windowed frame
        const real = new Float32Array(fftSize);
        const imag = new Float32Array(fftSize);
        for (let i = 0; i < windowSize && (start + i) < paddedLength; i++) {
            real[i] = padded[start + i] * window[i];
        }

        // FFT
        fft(real, imag, fftSize);

        // Power spectrum (magnitude squared / fftSize for energy normalization)
        const power = new Float32Array(nBins);
        for (let i = 0; i < nBins; i++) {
            power[i] = (real[i] * real[i] + imag[i] * imag[i]);
        }

        // Apply mel filterbank and log
        for (let m = 0; m < nMels; m++) {
            let energy = 0;
            for (let i = 0; i < nBins; i++) {
                energy += melFilters[m * nBins + i] * power[i];
            }
            // Kaldi-style log with floor (log_energy_floor_value)
            features[m * nFrames + frame] = Math.log(Math.max(energy, 1.1920929e-7));
        }
    }

    // Per-feature normalization (NeMo normalize_type="per_feature")
    // Zero mean, unit variance per mel channel
    for (let m = 0; m < nMels; m++) {
        let sum = 0, sumSq = 0;
        for (let t = 0; t < nFrames; t++) {
            const v = features[m * nFrames + t];
            sum += v;
            sumSq += v * v;
        }
        const mean = sum / nFrames;
        const variance = sumSq / nFrames - mean * mean;
        const std = Math.sqrt(Math.max(variance, 1e-10));
        for (let t = 0; t < nFrames; t++) {
            features[m * nFrames + t] = (features[m * nFrames + t] - mean) / std;
        }
    }

    return { features, nFrames };
}

function createMelFilterbank(sampleRate: number, fftSize: number, nMels: number, lowFreq: number = 20, highFreq: number = 7600): Float32Array {
    const nBins = fftSize / 2 + 1;

    // HTK mel scale (matching Kaldi)
    const hzToMel = (hz: number) => 2595 * Math.log10(1 + hz / 700);
    const melToHz = (mel: number) => 700 * (Math.pow(10, mel / 2595) - 1);

    const melMin = hzToMel(lowFreq);
    const melMax = hzToMel(highFreq);

    // Uniformly spaced mel points
    const melPoints = new Float32Array(nMels + 2);
    for (let i = 0; i < nMels + 2; i++) {
        melPoints[i] = melToHz(melMin + (melMax - melMin) * i / (nMels + 1));
    }

    // Convert to FFT bin indices
    const bins = new Float32Array(nMels + 2);
    for (let i = 0; i < nMels + 2; i++) {
        bins[i] = Math.floor((fftSize + 1) * melPoints[i] / sampleRate);
    }

    const filters = new Float32Array(nMels * nBins);
    for (let m = 0; m < nMels; m++) {
        for (let i = 0; i < nBins; i++) {
            if (i >= bins[m] && i < bins[m + 1]) {
                filters[m * nBins + i] = (i - bins[m]) / Math.max(bins[m + 1] - bins[m], 1);
            } else if (i >= bins[m + 1] && i <= bins[m + 2]) {
                filters[m * nBins + i] = (bins[m + 2] - i) / Math.max(bins[m + 2] - bins[m + 1], 1);
            }
        }
    }
    return filters;
}

function fft(real: Float32Array, imag: Float32Array, n: number): void {
    // Bit reversal
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            [real[i], real[j]] = [real[j], real[i]];
            [imag[i], imag[j]] = [imag[j], imag[i]];
        }
    }
    // Cooley-Tukey
    for (let size = 2; size <= n; size <<= 1) {
        const halfsize = size >> 1;
        const angle = -2 * Math.PI / size;
        const wReal = Math.cos(angle);
        const wImag = Math.sin(angle);
        for (let i = 0; i < n; i += size) {
            let curReal = 1, curImag = 0;
            for (let j = 0; j < halfsize; j++) {
                const tReal = curReal * real[i + j + halfsize] - curImag * imag[i + j + halfsize];
                const tImag = curReal * imag[i + j + halfsize] + curImag * real[i + j + halfsize];
                real[i + j + halfsize] = real[i + j] - tReal;
                imag[i + j + halfsize] = imag[i + j] - tImag;
                real[i + j] += tReal;
                imag[i + j] += tImag;
                const newCurReal = curReal * wReal - curImag * wImag;
                curImag = curReal * wImag + curImag * wReal;
                curReal = newCurReal;
            }
        }
    }
}

/**
 * Single-pass encode + decode for one audio segment.
 * Handles mel spectrogram, encoder, and TDT decoder in one call.
 */
async function transcribeSinglePass(audioData: Float32Array): Promise<{
    text: string;
    melTime: number;
    encTime: number;
    decTime: number;
}> {
    // Compute mel spectrogram
    const melStart = Date.now();
    const { features, nFrames } = computeMelSpectrogram(audioData);
    const melTime = Date.now() - melStart;

    // audio_signal: [1, 128, nFrames]
    const audioTensor = new ort.Tensor('float32', features, [1, 128, nFrames]);
    const lengthTensor = new ort.Tensor('int64', BigInt64Array.from([BigInt(nFrames)]), [1]);

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
    const text = await transducerGreedyDecode(encoderOut, encoderLen);
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
    if (!isInitialized || !encoderSession || !decoderSession || !joinerSession) {
        throw new Error('Parakeet not initialized');
    }

    const startTime = Date.now();
    const durationSeconds = audioData.length / 16000;
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

        // Transcribe each segment independently
        const texts: string[] = [];
        let totalMel = 0, totalEnc = 0, totalDec = 0;

        for (let i = 0; i < audioSegments.length; i++) {
            const seg = audioSegments[i];
            const segDur = seg.length / 16000;
            console.log(`[Parakeet] Segment ${i + 1}/${audioSegments.length}: ${segDur.toFixed(1)}s`);

            const { text, melTime, encTime, decTime } = await transcribeSinglePass(seg);
            totalMel += melTime;
            totalEnc += encTime;
            totalDec += decTime;

            if (text.trim()) {
                texts.push(text.trim());
            }
        }

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

export function getParakeetInfo(): { available: boolean; model: string; languages: number } {
    return {
        available: isInitialized,
        model: 'Parakeet TDT 0.6B-v3 (INT8)',
        languages: 25,
    };
}

export function cleanupParakeet(): void {
    encoderSession = null;
    decoderSession = null;
    joinerSession = null;
    vocabulary = [];
    isInitialized = false;
}
