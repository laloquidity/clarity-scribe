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
    const threshold = 0.5;
    const minSilenceMs = 300; // Merge segments with <300ms silence gaps
    const minSilenceSamples = (minSilenceMs / 1000) * sampleRate;

    // Silero VAD state tensors
    let h = new ort.Tensor('float32', new Float32Array(2 * 1 * 64), [2, 1, 64]);
    let c = new ort.Tensor('float32', new Float32Array(2 * 1 * 64), [2, 1, 64]);
    const sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(sampleRate)]), [1]);

    try {
        for (let offset = 0; offset + WINDOW_SIZE <= audioData.length; offset += WINDOW_SIZE) {
            const chunk = audioData.slice(offset, offset + WINDOW_SIZE);
            const input = new ort.Tensor('float32', chunk, [1, WINDOW_SIZE]);

            const result = await vadSession.run({ input, h, c, sr });
            const prob = (result.output.data as Float32Array)[0];

            // Update state from output
            h = result.hn as any;
            c = result.cn as any;

            if (prob >= threshold) {
                if (speechStart === -1) {
                    speechStart = offset;
                }
            } else {
                if (speechStart !== -1) {
                    segments.push({
                        startSample: speechStart,
                        endSample: offset + WINDOW_SIZE,
                        durationMs: ((offset + WINDOW_SIZE - speechStart) / sampleRate) * 1000,
                    });
                    speechStart = -1;
                }
            }
        }

        // Close any open segment
        if (speechStart !== -1) {
            segments.push({
                startSample: speechStart,
                endSample: audioData.length,
                durationMs: ((audioData.length - speechStart) / sampleRate) * 1000,
            });
        }
    } catch (error) {
        console.error('[VAD] Inference error:', error);
        return [{ startSample: 0, endSample: audioData.length, durationMs: (audioData.length / sampleRate) * 1000 }];
    }

    // No speech detected — return full audio
    if (segments.length === 0) {
        return [{ startSample: 0, endSample: audioData.length, durationMs: (audioData.length / sampleRate) * 1000 }];
    }

    // Merge segments with small gaps (<300ms)
    const merged: SpeechSegment[] = [segments[0]];
    for (let i = 1; i < segments.length; i++) {
        const prev = merged[merged.length - 1];
        const gap = segments[i].startSample - prev.endSample;
        if (gap < minSilenceSamples) {
            // Merge
            prev.endSample = segments[i].endSample;
            prev.durationMs = ((prev.endSample - prev.startSample) / sampleRate) * 1000;
        } else {
            merged.push({ ...segments[i] });
        }
    }

    // Split segments longer than 28s at the quietest point
    const maxSegmentSamples = 28 * sampleRate;
    const finalSegments: SpeechSegment[] = [];

    for (const seg of merged) {
        const segLength = seg.endSample - seg.startSample;
        if (segLength <= maxSegmentSamples) {
            finalSegments.push(seg);
            continue;
        }

        // Split long segments at quietest 300ms window
        let offset = seg.startSample;
        while (offset < seg.endSample) {
            const remaining = seg.endSample - offset;
            if (remaining <= maxSegmentSamples) {
                finalSegments.push({
                    startSample: offset,
                    endSample: seg.endSample,
                    durationMs: (remaining / sampleRate) * 1000,
                });
                break;
            }

            // Find quietest 300ms window in the second half of the chunk
            const searchStart = offset + Math.floor(maxSegmentSamples * 0.5);
            const searchEnd = Math.min(offset + maxSegmentSamples, seg.endSample);
            const windowSamples = Math.floor(0.3 * sampleRate); // 300ms
            let bestPos = searchEnd - windowSamples;
            let bestRms = Infinity;

            for (let pos = searchStart; pos + windowSamples <= searchEnd; pos += Math.floor(windowSamples / 3)) {
                let sum = 0;
                for (let j = pos; j < pos + windowSamples; j++) {
                    sum += audioData[j] * audioData[j];
                }
                const rms = Math.sqrt(sum / windowSamples);
                if (rms < bestRms) {
                    bestRms = rms;
                    bestPos = pos;
                }
            }

            const splitPoint = bestPos + Math.floor(windowSamples / 2);
            finalSegments.push({
                startSample: offset,
                endSample: splitPoint,
                durationMs: ((splitPoint - offset) / sampleRate) * 1000,
            });
            offset = splitPoint;
        }
    }

    // Add padding: 150ms before and after each segment
    const padSamples = Math.floor(0.15 * sampleRate);
    for (const seg of finalSegments) {
        seg.startSample = Math.max(0, seg.startSample - padSamples);
        seg.endSample = Math.min(audioData.length, seg.endSample + padSamples);
        seg.durationMs = ((seg.endSample - seg.startSample) / sampleRate) * 1000;
    }

    console.log(`[VAD] Detected ${finalSegments.length} speech segments: ${finalSegments.map(s => `${(s.durationMs / 1000).toFixed(1)}s`).join(', ')}`);
    return finalSegments;
}

export function isVADReady(): boolean {
    return vadSession !== null;
}

export function cleanupVAD(): void {
    vadSession = null;
}
