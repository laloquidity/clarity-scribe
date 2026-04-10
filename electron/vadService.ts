/**
 * Silero VAD Service — Voice Activity Detection for intelligent audio segmentation
 * Uses Silero VAD v5 ONNX model (~2MB) to detect speech boundaries.
 * Splits audio on natural pauses instead of arbitrary time marks.
 */

import * as ort from 'onnxruntime-node';
import { existsSync, mkdirSync, createWriteStream } from 'fs';
import { join } from 'path';
import { app } from 'electron';
import https from 'https';

const VAD_MODEL_URL = 'https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx';
const VAD_MODEL_FILENAME = 'silero_vad.onnx';
const SAMPLE_RATE = 16000;
const WINDOW_SIZE = 512; // 32ms at 16kHz — Silero VAD v5 window

export interface SpeechSegment {
    startSample: number;
    endSample: number;
    durationMs: number;
}

let vadSession: ort.InferenceSession | null = null;

function getModelDir(): string {
    const dir = join(app.getPath('home'), '.smart-whisper', 'models');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
}

function getModelPath(): string {
    return join(getModelDir(), VAD_MODEL_FILENAME);
}

/**
 * Download Silero VAD ONNX model if not present
 */
async function downloadVADModel(): Promise<string> {
    const modelPath = getModelPath();
    if (existsSync(modelPath)) return modelPath;

    console.log('[VAD] Downloading Silero VAD model...');
    return new Promise((resolve, reject) => {
        const follow = (url: string) => {
            https.get(url, (res) => {
                if (res.statusCode === 301 || res.statusCode === 302) {
                    return follow(res.headers.location!);
                }
                if (res.statusCode !== 200) {
                    return reject(new Error(`HTTP ${res.statusCode}`));
                }
                const file = createWriteStream(modelPath);
                res.pipe(file);
                file.on('finish', () => {
                    file.close();
                    console.log('[VAD] Model downloaded successfully');
                    resolve(modelPath);
                });
            }).on('error', reject);
        };
        follow(VAD_MODEL_URL);
    });
}

/**
 * Initialize VAD session (CPU-only, <1ms per frame)
 */
export async function initVAD(): Promise<boolean> {
    try {
        const modelPath = await downloadVADModel();
        vadSession = await ort.InferenceSession.create(modelPath, {
            executionProviders: ['cpu'],
            logSeverityLevel: 3, // Suppress verbose logs
        });
        console.log('[VAD] Silero VAD initialized');
        return true;
    } catch (error) {
        console.error('[VAD] Failed to initialize:', error);
        vadSession = null;
        return false;
    }
}

/**
 * Run Silero VAD on audio data to detect speech segments
 */
export async function detectSpeechSegments(
    audioData: Float32Array,
    sampleRate: number = SAMPLE_RATE
): Promise<SpeechSegment[]> {
    if (!vadSession) {
        console.warn('[VAD] Not initialized, falling back to full audio');
        return [{ startSample: 0, endSample: audioData.length, durationMs: (audioData.length / sampleRate) * 1000 }];
    }

    const segments: SpeechSegment[] = [];
    let speechStart = -1;

    // Thresholds — matching onnx-asr silero.py:75-80 (hysteresis)
    // https://github.com/istupakov/onnx-asr/blob/main/src/onnx_asr/models/silero.py#L75-L80
    const threshold = 0.5;
    const negThreshold = threshold - 0.15; // 0.35 — speech END threshold (hysteresis)

    // Merge parameters — based on onnx-asr vad.py:59-70 (_merge_segments)
    // https://github.com/istupakov/onnx-asr/blob/main/src/onnx_asr/vad.py#L59-L70
    // NOTE: onnx-asr uses min_silence_duration_ms=100, but that creates too many
    // segments for Parakeet TDT which benefits from larger context windows.
    // We use 500ms to merge through conversational pauses while still
    // splitting at genuine sentence/topic boundaries.
    const speechPadMs = 30;
    const minSpeechDurationMs = 250;
    const maxSpeechDurationS = 55; // onnx-asr default: 20s. Raised to 55s to match macOS single-pass encoder limit (60s) with 5s margin
    const minSilenceDurationMs = 700; // onnx-asr default: 100ms, bumped to reduce over-segmentation

    const speechPadSamples = Math.floor(speechPadMs * sampleRate / 1000);
    const minSpeechSamples = Math.floor(minSpeechDurationMs * sampleRate / 1000) - 2 * speechPadSamples;
    const maxSpeechSamples = Math.floor(maxSpeechDurationS * sampleRate) - 2 * speechPadSamples;
    const minSilenceSamples = Math.floor(minSilenceDurationMs * sampleRate / 1000) + 2 * speechPadSamples;

    // Silero VAD v5 state tensor (consolidated h+c into single state)
    // Shape: [2, 1, 128] — see https://github.com/snakers4/silero-vad
    let state = new ort.Tensor('float32', new Float32Array(2 * 1 * 128), [2, 1, 128]);
    const sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(sampleRate)]), [1]);

    // Silero VAD v5 requires 64 context samples prepended to each 512-sample window
    // Input tensor shape: [1, 576] (64 context + 512 audio)
    // Reference: https://github.com/snakers4/silero-vad/blob/master/src/silero_vad/utils_vad.py#L70-L91
    // Reference: https://github.com/istupakov/onnx-asr/blob/main/src/onnx_asr/models/silero.py#L43-L68
    const CONTEXT_SIZE = 64;
    let context = new Float32Array(CONTEXT_SIZE); // Initialize with zeros (matches official: line 80)

    // Raw speech segments from VAD (before merging)
    const rawSegments: Array<{ start: number; end: number }> = [];

    try {
        for (let offset = 0; offset + WINDOW_SIZE <= audioData.length; offset += WINDOW_SIZE) {
            const chunk = audioData.slice(offset, offset + WINDOW_SIZE);

            // Prepend context to chunk: [64 context + 512 audio] = 576 samples
            const inputData = new Float32Array(CONTEXT_SIZE + WINDOW_SIZE);
            inputData.set(context, 0);
            inputData.set(chunk, CONTEXT_SIZE);
            const input = new ort.Tensor('float32', inputData, [1, CONTEXT_SIZE + WINDOW_SIZE]);

            const result = await vadSession.run({ input, state, sr });
            const prob = (result.output.data as Float32Array)[0];

            // Update state from output (v5 returns 'stateN')
            state = result.stateN as any;

            // Update context with last 64 samples of current chunk (matches official: line 91)
            context = chunk.slice(-CONTEXT_SIZE);

            // Hysteresis: use threshold (0.5) to START speech, negThreshold (0.35) to END speech
            // Reference: onnx-asr silero.py:85-90
            if (prob >= threshold) {
                if (speechStart === -1) {
                    speechStart = offset;
                }
            } else if (prob < negThreshold) {
                if (speechStart !== -1) {
                    rawSegments.push({ start: speechStart, end: offset + WINDOW_SIZE });
                    speechStart = -1;
                }
            }
            // When negThreshold <= prob < threshold: no state change (hysteresis zone)
        }

        // Close any open segment
        if (speechStart !== -1) {
            rawSegments.push({ start: speechStart, end: audioData.length });
        }
    } catch (error) {
        console.error('[VAD] Inference error:', error);
        return [{ startSample: 0, endSample: audioData.length, durationMs: (audioData.length / sampleRate) * 1000 }];
    }

    // No speech detected — return full audio
    if (rawSegments.length === 0) {
        return [{ startSample: 0, endSample: audioData.length, durationMs: (audioData.length / sampleRate) * 1000 }];
    }

    // Merge segments — exact port of onnx-asr _merge_segments (vad.py:59-86)
    // https://github.com/istupakov/onnx-asr/blob/main/src/onnx_asr/vad.py#L59-L86
    // Merges adjacent segments as long as:
    //   1. Gap between them < minSilenceSamples (100ms + 2*pad)
    //   2. Combined segment stays under maxSpeechSamples (20s - 2*pad)
    // Drops segments shorter than minSpeechSamples (250ms - 2*pad)
    const mergedSegments: Array<{ start: number; end: number }> = [];
    let curStart = -Infinity;
    let curEnd = -Infinity;

    // Chain: rawSegments + sentinel pair to flush the last segment (matches reference chain pattern)
    const sentinel = [
        { start: audioData.length, end: audioData.length },
        { start: Infinity, end: Infinity },
    ];

    for (const seg of [...rawSegments, ...sentinel]) {
        if (seg.start - curEnd < minSilenceSamples && seg.end - curStart < maxSpeechSamples) {
            // Merge: extend current segment
            curEnd = seg.end;
        } else {
            // Emit current segment if long enough
            if (curEnd - curStart > minSpeechSamples) {
                const paddedStart = Math.max(curStart - speechPadSamples, 0);
                const paddedEnd = Math.min(curEnd + speechPadSamples, audioData.length);
                mergedSegments.push({ start: paddedStart, end: paddedEnd });
            }
            // Handle segments longer than maxSpeechSamples (split)
            let s = seg.start;
            while (seg.end - s > maxSpeechSamples) {
                const paddedStart = Math.max(s - speechPadSamples, 0);
                const paddedEnd = s + maxSpeechSamples + speechPadSamples;
                mergedSegments.push({ start: paddedStart, end: paddedEnd });
                s += maxSpeechSamples;
            }
            curStart = s;
            curEnd = seg.end;
        }
    }

    // Convert to SpeechSegment format
    const finalSegments: SpeechSegment[] = mergedSegments.map(seg => ({
        startSample: seg.start,
        endSample: seg.end,
        durationMs: ((seg.end - seg.start) / sampleRate) * 1000,
    }));

    console.log(`[VAD] Detected ${finalSegments.length} speech segments: ${finalSegments.map(s => `${(s.durationMs / 1000).toFixed(1)}s`).join(', ')}`);
    return finalSegments;
}

export function isVADReady(): boolean {
    return vadSession !== null;
}

export function cleanupVAD(): void {
    vadSession = null;
}
