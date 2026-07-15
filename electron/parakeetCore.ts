/**
 * Parakeet TDT — Pure DSP + decode core (no Electron dependency)
 *
 * This module holds the audio-feature frontend (mel spectrogram + FFT) and the
 * TDT greedy decoder, extracted from parakeetService.ts so they can be unit- and
 * regression-tested under plain Node (vitest) without pulling in `electron`.
 *
 * The functions here are either pure (mel/fft/filterbank/tokensToText) or take
 * their ONNX sessions / vocabulary / state dimensions as explicit parameters via
 * DecodeContext, rather than reaching for module-level globals. Behavior is
 * identical to the original inline implementation in parakeetService.ts.
 *
 * Reference (algorithm parity): sherpa-onnx offline-transducer-greedy-search-nemo
 * and onnx-asr NemoPreprocessorNumpy — see parakeetService.ts header for details.
 */

import * as ort from 'onnxruntime-node';
import { readFileSync } from 'fs';

// NeMo convention: blank token is the LAST token in vocabulary (v3: 8192)
export const BLANK_ID = 8192;

/**
 * Everything the TDT greedy decoder needs that used to live in module scope.
 */
export interface DecodeContext {
    decoderSession: ort.InferenceSession;
    joinerSession: ort.InferenceSession;
    vocabulary: string[];
    blankId: number;
    predRnnLayers: number;
    predHidden: number;
}

/**
 * ONNX Runtime session options for the encoder (largest model). Adds explicit
 * memory-arena/pattern reuse on top of full graph optimization. The execution
 * providers are passed in (dml/cuda/coreml/cpu per platform).
 */
export function encoderSessionOptions(providers: string[]): ort.InferenceSession.SessionOptions {
    // DirectML (Windows) needs specific options for stability: 'basic' graph opt
    // avoids aggressive QDQ fusion corrupting INT8 precision, and mem-pattern off
    // + sequential execution prevents stale GPU allocation patterns from corrupting
    // encoder outputs across different audio lengths (which caused decoder collapse).
    // Reference: sherpa-onnx session.cc + DirectML EP docs. (v2.7 DirectML fix)
    if (process.platform === 'win32') {
        return {
            executionProviders: providers,
            logSeverityLevel: 3,
            graphOptimizationLevel: 'basic',
            enableMemPattern: false,
            executionMode: 'sequential',
        };
    }
    // macOS/Linux CPU (and CUDA): full optimization + memory-arena/pattern reuse.
    return {
        executionProviders: providers,
        logSeverityLevel: 3,
        graphOptimizationLevel: 'all',
        enableCpuMemArena: true,
        enableMemPattern: true,
    };
}

/**
 * ONNX Runtime session options for the decoder + joiner. These are tiny models
 * invoked in a tight per-frame loop, so a single intra-op thread avoids
 * thread-pool synchronization overhead per call (and is the most deterministic),
 * while full graph optimization is enabled.
 */
export function smallModelSessionOptions(): ort.InferenceSession.SessionOptions {
    return {
        executionProviders: ['cpu'],
        logSeverityLevel: 3,
        graphOptimizationLevel: 'all',
        intraOpNumThreads: 1,
    };
}

/**
 * Load vocabulary from tokens.txt
 * Format: <token> <id> (one per line)
 */
export function loadTokens(path: string): string[] {
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
 * Create initial decoder LSTM states (all zeros)
 * Shape: [pred_rnn_layers, batch_size, pred_hidden] — two state tensors (h, c)
 */
export function getDecoderInitStates(predRnnLayers: number, predHidden: number): ort.Tensor[] {
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
export async function runDecoder(
    decoderSession: ort.InferenceSession,
    targets: ort.Tensor,
    targetLength: ort.Tensor,
    states: ort.Tensor[]
): Promise<{ output: ort.Tensor; nextStates: ort.Tensor[] }> {
    const result = await decoderSession.run({
        'targets': targets,
        'target_length': targetLength,
        'states.1': states[0],
        'onnx::Slice_3': states[1],
    });

    // outputs: [0]=decoder_output, [1]=prednet_lengths, [2:]=next_states
    const outputNames = decoderSession.outputNames;
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
export async function runJoiner(
    joinerSession: ort.InferenceSession,
    encoderOut: ort.Tensor,
    decoderOut: ort.Tensor
): Promise<ort.Tensor> {
    const result = await joinerSession.run({
        'encoder_outputs': encoderOut,
        'decoder_outputs': decoderOut,
    });
    return result[joinerSession.outputNames[0]] as ort.Tensor;
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
export async function transducerGreedyDecode(
    encoderOut: ort.Tensor,
    encoderOutLen: number,
    ctx: DecodeContext,
): Promise<{ text: string; lastTokenFrame: number; totalFrames: number }> {
    const { decoderSession, joinerSession, vocabulary, blankId, predRnnLayers, predHidden } = ctx;
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
    let decoderStates = getDecoderInitStates(predRnnLayers, predHidden);
    let prevToken = blankId;

    // --- Reusable hot-loop buffers (avoid per-frame allocation / GC churn) ---
    // The encoder-frame slice and the decoder target tensor are overwritten in
    // place each step; ONNX Runtime reads their contents synchronously at run()
    // and we always await before mutating again, so reuse is safe and produces
    // bit-identical inputs to fresh allocations.
    const encSlice = new Float32Array(D);
    const encTensor = new ort.Tensor('float32', encSlice, [1, D, 1]);
    const targetsBuf = Int32Array.from([prevToken]);
    const targets = new ort.Tensor('int32', targetsBuf, [1, 1]);
    const targetLen = new ort.Tensor('int32', Int32Array.from([1]), [1]);

    // --- Decoder-output caching (key optimization) ---
    // The prediction (decoder) LSTM is a pure, deterministic function of
    // (prevToken, decoderStates). Those change ONLY when a non-blank token is
    // emitted, so on every blank frame the decoder output is identical and
    // re-running it is wasted work + a wasted async ONNX round-trip. We compute
    // it once up front and refresh it ONLY after an emission — matching the
    // sherpa-onnx reference and FluidAudio's TdtDecoderV3. The joiner still runs
    // every frame (its encoder input changes), and the emitted tokens are
    // bit-identical to the naive per-frame-decoder version.
    let { output: decoderOut, nextStates } = await runDecoder(decoderSession, targets, targetLen, decoderStates);

    // TDT greedy decode — matching sherpa-onnx reference implementation exactly
    // See: offline-transducer-greedy-search-nemo-decoder.cc DecodeOneTDT()
    const maxTokensPerFrame = 5; // Matches sherpa-onnx reference: max_tokens_per_frame
    const COLLAPSE_BLANK_THRESHOLD = 15; // consecutive blanks before an LSTM-state reset
    let tokensThisFrame = 0;
    let skip = 0; // frames to advance

    // Diagnostic counters for truncation investigation
    let totalBlanks = 0;
    let totalIterations = 0;
    let lastTokenFrame = 0;
    let maxSkipSeen = 0;
    let consecutiveBlanks = 0;
    let maxConsecutiveBlanks = 0;
    let collapseRecoveries = 0;
    let decoderCalls = 1; // seed call above; +1 per emission / collapse reset (diagnostic)

    for (let t = 0; t < encoderOutLen; t += skip) {
        totalIterations++;

        // Extract encoder output at timestep t into the reused slice buffer.
        // Data layout [B, D, T]: data[d * T + t] for feature d at timestep t
        for (let d = 0; d < D; d++) {
            encSlice[d] = encoderData[d * T + t];
        }

        // Run joiner against the CACHED decoder output (valid for the current
        // prevToken/states — unchanged since the last emission).
        const logits = await runJoiner(joinerSession, encTensor, decoderOut);
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
        // Note: skip can be 0 (stay on same frame)
        skip = 0;
        if (numDurations > 0) {
            let durMax = logitsData[vocabSize];
            for (let i = 1; i < numDurations; i++) {
                if (logitsData[vocabSize + i] > durMax) {
                    durMax = logitsData[vocabSize + i];
                    skip = i;
                }
            }
        }

        if (y !== blankId) {
            // Non-blank token: emit, advance decoder state, and REFRESH the cache.
            tokens.push(y);
            prevToken = y;
            decoderStates = nextStates;
            tokensThisFrame += 1;
            lastTokenFrame = t;
            consecutiveBlanks = 0;

            targetsBuf[0] = prevToken;
            ({ output: decoderOut, nextStates } = await runDecoder(decoderSession, targets, targetLen, decoderStates));
            decoderCalls++;
        } else {
            totalBlanks++;
            consecutiveBlanks++;
            if (consecutiveBlanks > maxConsecutiveBlanks) {
                maxConsecutiveBlanks = consecutiveBlanks;
            }
        }

        // Decoder collapse detection & recovery (from v2.8). When the LSTM enters
        // a blank-emitting fixed point — e.g. DirectML encoder outputs nudging
        // marginal joiner logits across the blank/token boundary — reset to fresh
        // zero state. ~15 consecutive blanks ≈ 3.6s; normal speech never exceeds
        // ~10. With decoder-output caching, the reset also refreshes the cache.
        if (consecutiveBlanks >= COLLAPSE_BLANK_THRESHOLD) {
            collapseRecoveries++;
            console.log(`[Parakeet] ⚠ Decoder collapse detected at frame ${t} (~${(t * 0.08).toFixed(1)}s). Resetting LSTM state (recovery #${collapseRecoveries}).`);
            decoderStates = getDecoderInitStates(predRnnLayers, predHidden);
            prevToken = blankId;
            consecutiveBlanks = 0;
            tokensThisFrame = 0;
            targetsBuf[0] = prevToken;
            ({ output: decoderOut, nextStates } = await runDecoder(decoderSession, targets, targetLen, decoderStates));
            decoderCalls++;
        }

        if (skip > maxSkipSeen) maxSkipSeen = skip;

        // Frame advancement logic — three SEPARATE if-blocks, NOT else-if
        // This exactly matches sherpa-onnx DecodeOneTDT() reference:
        // https://github.com/k2-fsa/sherpa-onnx offline-transducer-greedy-search-nemo-decoder.cc
        if (skip > 0) {
            tokensThisFrame = 0;
        }

        if (tokensThisFrame >= maxTokensPerFrame) {
            tokensThisFrame = 0;
            skip = 1;
        }

        if (y === blankId && skip === 0) {
            tokensThisFrame = 0;
            skip = 1;
        }
    }

    // Diagnostic: frame-level decode summary (decoderCalls << totalIterations is the win)
    const blankRatio = totalIterations > 0 ? (totalBlanks / totalIterations * 100).toFixed(1) : '0';
    const lastTokenTimeSec = (lastTokenFrame * 0.08).toFixed(1); // ~80ms per encoder frame
    const totalTimeSec = (encoderOutLen * 0.08).toFixed(1);
    const unusedFrames = encoderOutLen - lastTokenFrame;
    console.log(`[Parakeet] Decode: ${tokens.length} tokens from ${encoderOutLen} frames | blanks: ${totalBlanks}/${totalIterations} (${blankRatio}%) | decoderCalls: ${decoderCalls}/${totalIterations} | maxSkip: ${maxSkipSeen} | maxConsecBlanks: ${maxConsecutiveBlanks} | lastToken: frame ${lastTokenFrame} (${lastTokenTimeSec}s/${totalTimeSec}s) | unusedTail: ${unusedFrames} frames${collapseRecoveries > 0 ? ` | ⚠ recoveries: ${collapseRecoveries}` : ''}`);
    return { text: tokensToText(tokens, vocabulary), lastTokenFrame, totalFrames: encoderOutLen };
}

/**
 * Convert token IDs to readable text
 * NeMo uses SentencePiece-style tokens: ▁ = word boundary (space)
 * Special tokens (< >) are filtered out
 * Post-processing: clean up leading/trailing dots from silence
 */
export function tokensToText(tokenIds: number[], vocabulary: string[]): string {
    const parts: string[] = [];
    for (const id of tokenIds) {
        if (id >= 0 && id < vocabulary.length) {
            const token = vocabulary[id];
            // Skip special tokens
            if (token.startsWith('<') && token.endsWith('>')) continue;
            // Replace SentencePiece ▁ with space (matching onnx-asr vocab load: line 127)
            parts.push(token.replace(/▁/g, ' '));
        }
    }
    let text = parts.join('');
    // Clean up spaces at subword boundaries (matching onnx-asr DECODE_SPACE_PATTERN)
    // Reference: asr.py:113 — re.compile(r"\A\s|\s\B|(\s)\b")
    // Removes: leading whitespace, spaces before non-word-boundaries (e.g. "'s ay" → "'say")
    // Keeps: spaces at real word boundaries
    text = text.replace(/^\s|(\s)(?=\B)/g, (match, captured) => captured ? '' : '');

    // Clean up artifacts from silence/noise at start
    text = text.replace(/^[\s.]+/, '');          // Strip leading dots/whitespace from silence
    text = text.replace(/\.{3,}/g, '...');       // Collapse excessive dots but preserve ellipsis
    text = text.trim();

    // Casing: trust the model's SentencePiece casing decisions.
    // cleanTranscription handles first-letter capitalization of the final joined text.

    return text;
}

// ── Memoized window + mel filterbank ────────────────────────────────────────
// Both are pure functions of fixed constants (sampleRate/nFft/nMels/winLength),
// so we build them once and reuse across every transcription/segment. Results
// are byte-identical to recomputing them each call.
let _hannCache: { key: string; window: Float32Array } | null = null;
function getHannWindow(nFft: number, winLength: number): Float32Array {
    const key = `${nFft}:${winLength}`;
    if (!_hannCache || _hannCache.key !== key) {
        const windowPad = (nFft - winLength) / 2;
        const window = new Float32Array(nFft); // zeros by default
        for (let i = 0; i < winLength; i++) {
            window[windowPad + i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (winLength - 1)));
        }
        _hannCache = { key, window };
    }
    return _hannCache.window;
}

let _melFilterCache: { key: string; filters: Float32Array; bandStart: Int32Array; bandEnd: Int32Array } | null = null;
function getMelFilterbank(sampleRate: number, nFft: number, nMels: number): { filters: Float32Array; bandStart: Int32Array; bandEnd: Int32Array } {
    const key = `${sampleRate}:${nFft}:${nMels}`;
    if (!_melFilterCache || _melFilterCache.key !== key) {
        const filters = createMelFilterbank(sampleRate, nFft, nMels, 0, sampleRate / 2);
        // Each mel filter is a narrow triangle — nonzero over only a handful of
        // the 257 bins. Precompute the nonzero band per filter so the mel matmul
        // skips guaranteed-zero terms. Skipped terms contribute exactly +0.0
        // (power ≥ 0, filter = 0), so the result is bit-identical to the dense loop.
        const nBins = nFft / 2 + 1;
        const bandStart = new Int32Array(nMels);
        const bandEnd = new Int32Array(nMels);
        for (let m = 0; m < nMels; m++) {
            let start = 0;
            while (start < nBins && filters[m * nBins + start] === 0) start++;
            let end = nBins;
            while (end > start && filters[m * nBins + (end - 1)] === 0) end--;
            bandStart[m] = start;
            bandEnd[m] = end;
        }
        _melFilterCache = { key, filters, bandStart, bandEnd };
    }
    return _melFilterCache;
}

/**
 * Compute 128-channel log-mel spectrogram for NeMo FastConformer encoder.
 *
 * Matches onnx-asr NemoPreprocessorNumpy (numpy_preprocessor.py:144-187)
 * and the ONNX builder (preprocessors/nemo.py) line-by-line:
 *   - Preemphasis coefficient 0.97
 *   - Zero-pad by n_fft/2 = 256 on each side
 *   - Symmetric Hann window (400 samples) centered in 512-pt FFT frame
 *   - 128 Slaney-scale mel filterbanks, 0–8000 Hz, Slaney area normalization
 *   - Log compression with guard value 2^-24
 *   - Per-feature CMVN with Bessel's correction (N-1), masked to valid frames
 *   - Audio samples in [-1,1] range
 *
 * Returns features in [nMels, totalFrames] layout (C, T) and the valid
 * frame count. The encoder length tensor should use validFrames, not
 * totalFrames, so that padding-contaminated edge frames are ignored.
 */
export function computeMelSpectrogram(
    audio: Float32Array,
    sampleRate: number = 16000
): { features: Float32Array; nFrames: number; validFrames: number } {
    const nMels = 128;
    const winLength = 400;   // 25ms at 16kHz
    const hopLength = 160;   // 10ms at 16kHz
    const nFft = 512;
    const nBins = nFft / 2 + 1; // 257
    const preemph = 0.97;
    const logZeroGuard = 5.960464477539063e-8; // 2^-24, matching NeMo/onnx-asr

    // ── 1. Preemphasis ──────────────────────────────────────────────────
    // y[n] = x[n] - 0.97 * x[n-1], with x[-1] = 0
    // Reference: onnx-asr numpy_preprocessor.py:161-163
    const preemphasized = new Float32Array(audio.length);
    preemphasized[0] = audio[0]; // x[-1] = 0, so y[0] = x[0]
    for (let i = 1; i < audio.length; i++) {
        preemphasized[i] = audio[i] - preemph * audio[i - 1];
    }

    // ── 2. Zero-pad by n_fft/2 on each side ─────────────────────────────
    // Reference: onnx-asr numpy_preprocessor.py:165
    const padSize = nFft / 2; // 256
    const paddedLength = preemphasized.length + 2 * padSize;
    const padded = new Float32Array(paddedLength); // zeros by default
    padded.set(preemphasized, padSize);

    // ── 3. Compute valid frame count (BEFORE computing total frames) ────
    // Reference: onnx-asr numpy_preprocessor.py:174
    // features_lens = waveforms_lens // hop_length
    const validFrames = Math.floor(audio.length / hopLength);

    // Total spectrogram frames from sliding_window_view
    const totalFrames = Math.floor((paddedLength - nFft) / hopLength) + 1;

    // ── 4. Symmetric Hann window, centered in n_fft frame (memoized) ───
    // Reference: onnx-asr preprocessors/nemo.py:56-58, numpy_preprocessor.py:167-169
    // np.hanning(win_length) padded to n_fft with (n_fft-win_length)/2 zeros each side
    // Window + filterbank are pure functions of fixed constants, so they are
    // built once and cached at module scope (previously rebuilt on every call).
    const window = getHannWindow(nFft, winLength);

    // ── 5. Mel filterbank (Slaney scale, Slaney norm, 0–8000 Hz, memoized) ─
    // bandStart/bandEnd bound each filter's nonzero bins so the matmul below
    // skips zero terms (bit-identical output, ~10x fewer multiplies).
    const { filters: melFilters, bandStart, bandEnd } = getMelFilterbank(sampleRate, nFft, nMels);

    // ── 6. STFT → power spectrum → mel → log ───────────────────────────
    const features = new Float32Array(nMels * totalFrames);

    // Reused per-frame scratch buffers (cleared each frame) — avoids allocating
    // ~3 typed arrays per frame (thousands per clip) with identical results.
    const real = new Float32Array(nFft);
    const imag = new Float32Array(nFft);
    const power = new Float32Array(nBins);

    for (let frame = 0; frame < totalFrames; frame++) {
        const start = frame * hopLength;

        // Clear scratch: fft() mutates both real & imag in place, and the
        // windowing loop only fills part of `real` for frames near the tail.
        real.fill(0);
        imag.fill(0);

        // Apply centered window to n_fft-sized frame
        for (let i = 0; i < nFft && (start + i) < paddedLength; i++) {
            real[i] = padded[start + i] * window[i];
        }

        fft(real, imag, nFft);

        // Power spectrum: |X|^2  (no division by n_fft — matches reference)
        for (let i = 0; i < nBins; i++) {
            power[i] = real[i] * real[i] + imag[i] * imag[i];
        }

        // mel → log (sparse: only each filter's nonzero band contributes)
        for (let m = 0; m < nMels; m++) {
            let energy = 0;
            const rowOff = m * nBins;
            const end = bandEnd[m];
            for (let i = bandStart[m]; i < end; i++) {
                energy += melFilters[rowOff + i] * power[i];
            }
            // features stored [C, T]: mel channel m at frame t
            features[m * totalFrames + frame] = Math.log(energy + logZeroGuard);
        }
    }

    // ── 7. Per-feature CMVN with masking & Bessel's correction ──────────
    // Reference: onnx-asr numpy_preprocessor.py:174-186
    // Only valid frames (< validFrames) participate in mean/var.
    // Non-valid frames are set to 0 after normalization.
    for (let m = 0; m < nMels; m++) {
        // Compute mean over valid frames only
        let sum = 0;
        for (let t = 0; t < validFrames; t++) {
            sum += features[m * totalFrames + t];
        }
        const mean = sum / validFrames;

        // Compute variance with Bessel's correction (N-1)
        let sumSqDev = 0;
        for (let t = 0; t < validFrames; t++) {
            const d = features[m * totalFrames + t] - mean;
            sumSqDev += d * d;
        }
        const variance = validFrames > 1 ? sumSqDev / (validFrames - 1) : 0;
        const std = Math.sqrt(variance) + 1e-5;

        // Normalize valid frames
        for (let t = 0; t < validFrames; t++) {
            features[m * totalFrames + t] = (features[m * totalFrames + t] - mean) / std;
        }
        // Zero out non-valid frames (padding artifacts)
        for (let t = validFrames; t < totalFrames; t++) {
            features[m * totalFrames + t] = 0;
        }
    }

    return { features, nFrames: totalFrames, validFrames };
}

/**
 * Create Slaney-scale mel filterbank with Slaney area normalization.
 *
 * Matches onnx-asr preprocessors/fbanks.py melscale_fbanks() called with:
 *   melscale_fbanks(257, 0, 8000, 128, 16000, "slaney", "slaney")
 *
 * Slaney mel scale: linear below 1000 Hz (3 mels per 200 Hz),
 * logarithmic above (27 mels per octave from 1000 Hz).
 * Slaney normalization: each filter is divided by its bandwidth in Hz
 * so that all filters have unit area (constant energy per mel band).
 */
export function createMelFilterbank(
    sampleRate: number, fftSize: number, nMels: number,
    lowFreq: number = 0, highFreq: number = 8000
): Float32Array {
    const nBins = fftSize / 2 + 1;
    const eps = 1.1920929e-7; // float32 eps for log guard

    // Slaney mel scale
    const hzToMel = (hz: number): number => {
        if (hz < 1000) return 3 * hz / 200.0;
        return 15 + 27 * Math.log(hz / 1000.0 + eps) / Math.log(6.4);
    };
    const melToHz = (mel: number): number => {
        if (mel < 15) return 200 * mel / 3.0;
        return 1000 * Math.pow(6.4, (mel - 15) / 27.0);
    };

    // Linearly spaced frequency bins (all_freqs in reference)
    const allFreqs = new Float64Array(nBins);
    for (let i = 0; i < nBins; i++) {
        allFreqs[i] = (sampleRate / 2) * i / (nBins - 1);
    }

    // Uniformly spaced mel points → convert back to Hz
    const mMin = hzToMel(lowFreq);
    const mMax = hzToMel(highFreq);
    const mPts = new Float64Array(nMels + 2);
    for (let i = 0; i < nMels + 2; i++) {
        mPts[i] = melToHz(mMin + (mMax - mMin) * i / (nMels + 1));
    }

    // Triangular filters on Hz scale with Slaney normalization
    // Reference: fbanks.py:54-59
    const filters = new Float32Array(nMels * nBins);
    for (let m = 0; m < nMels; m++) {
        const fLow = mPts[m];
        const fCenter = mPts[m + 1];
        const fHigh = mPts[m + 2];
        // Slaney normalization: 2 / (fHigh - fLow)
        const norm = 2.0 / (fHigh - fLow);

        for (let i = 0; i < nBins; i++) {
            const f = allFreqs[i];
            const upSlope = (fCenter - fLow) > 0 ? (f - fLow) / (fCenter - fLow) : 0;
            const downSlope = (fHigh - fCenter) > 0 ? (fHigh - f) / (fHigh - fCenter) : 0;
            const val = Math.max(0, Math.min(upSlope, downSlope));
            filters[m * nBins + i] = val * norm;
        }
    }
    return filters;
}

export function fft(real: Float32Array, imag: Float32Array, n: number): void {
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
