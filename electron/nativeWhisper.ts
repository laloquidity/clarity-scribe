/**
 * Native Whisper Service — Uses @napi-rs/whisper for GPU-accelerated transcription
 * Ported from Clarity, simplified for Clarity Scribe (Whisper-only, no Parakeet)
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import https from 'https';
import { createWriteStream, mkdirSync, statSync } from 'fs';

// Using ggml-large-v3-turbo for best speed/quality balance (809M params, ~7.7% WER)
const MODEL_URLS: Record<string, string> = {
    'turbo': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin',
    'small': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
};

const MODEL_FILES: Record<string, string> = {
    'turbo': 'ggml-large-v3-turbo.bin',
    'small': 'ggml-small.bin',
};

const MODEL_SIZES: Record<string, number> = {
    'turbo': 1_500_000_000,
    'small': 460_000_000,
};

let whisperInstance: any = null;
let currentModelType: string | null = null;
let WhisperModule: any = null;

function getModelsDir(): string {
    const { app } = require('electron');
    return join(app.getPath('userData'), 'whisper-models');
}

async function downloadFile(
    url: string,
    destPath: string,
    onProgress?: (percent: number, status: string) => void
): Promise<void> {
    return new Promise((resolve, reject) => {
        const file = createWriteStream(destPath);
        const request = https.get(url, {
            headers: { 'User-Agent': 'clarity-lite' }
        }, (response) => {
            if (response.statusCode === 302 || response.statusCode === 301) {
                const redirectUrl = response.headers.location;
                if (redirectUrl) {
                    file.close();
                    downloadFile(redirectUrl, destPath, onProgress).then(resolve).catch(reject);
                    return;
                }
            }

            if (response.statusCode !== 200) {
                reject(new Error(`Download failed: ${response.statusCode}`));
                return;
            }

            const totalSize = parseInt(response.headers['content-length'] || '0', 10);
            let downloadedSize = 0;

            response.on('data', (chunk: Buffer) => {
                downloadedSize += chunk.length;
                if (totalSize > 0 && onProgress) {
                    const percent = Math.round((downloadedSize / totalSize) * 100);
                    onProgress(percent, `Downloading model: ${percent}%`);
                }
            });

            response.pipe(file);
            file.on('finish', () => { file.close(); resolve(); });
        });
        request.on('error', (err) => { file.close(); reject(err); });
    });
}

export async function isModelDownloaded(modelType: string = 'turbo'): Promise<boolean> {
    const modelFile = MODEL_FILES[modelType] || MODEL_FILES['turbo'];
    const modelPath = join(getModelsDir(), modelFile);
    const expectedSize = MODEL_SIZES[modelType] || MODEL_SIZES['turbo'];

    try {
        const stats = statSync(modelPath);
        return stats.size >= expectedSize * 0.9;
    } catch {
        return false;
    }
}

export async function downloadModel(
    modelType: string = 'turbo',
    onProgress?: (percent: number, status: string) => void
): Promise<void> {
    const modelsDir = getModelsDir();
    try { mkdirSync(modelsDir, { recursive: true }); } catch { /* exists */ }

    const modelUrl = MODEL_URLS[modelType] || MODEL_URLS['turbo'];
    const modelFile = MODEL_FILES[modelType] || MODEL_FILES['turbo'];
    const modelPath = join(modelsDir, modelFile);

    console.log(`[Whisper] Downloading ${modelType} to ${modelPath}`);
    await downloadFile(modelUrl, modelPath, onProgress);
    console.log(`[Whisper] Download complete`);
}

export async function initWhisper(
    modelType: string = 'turbo',
    onProgress?: (percent: number, status: string) => void
): Promise<boolean> {
    try {
        if (!WhisperModule) {
            try {
                WhisperModule = await import('@napi-rs/whisper');
                console.log('[Whisper] Module loaded');
            } catch (importErr: any) {
                if (process.platform === 'win32') {
                    console.warn('[Whisper] CUDA failed, trying CPU fallback...');
                    process.env.CUDA_VISIBLE_DEVICES = '-1';
                    try {
                        delete require.cache[require.resolve('@napi-rs/whisper')];
                        WhisperModule = await import('@napi-rs/whisper');
                        console.log('[Whisper] CPU fallback loaded');
                    } catch (fallbackErr) {
                        console.error('[Whisper] CPU fallback also failed:', fallbackErr);
                        throw fallbackErr;
                    }
                } else {
                    throw importErr;
                }
            }
        }

        if (!(await isModelDownloaded(modelType))) {
            onProgress?.(0, 'Downloading model...');
            await downloadModel(modelType, onProgress);
        }

        if (whisperInstance && currentModelType === modelType) {
            return true;
        }

        const modelFile = MODEL_FILES[modelType] || MODEL_FILES['turbo'];
        const modelPath = join(getModelsDir(), modelFile);
        const modelBuffer = await readFile(modelPath);

        console.log(`[Whisper] Loading model: ${modelFile}`);
        onProgress?.(90, 'Loading model...');

        whisperInstance = new WhisperModule.Whisper(modelBuffer);
        currentModelType = modelType;

        console.log(`[Whisper] ✓ Ready`);
        onProgress?.(100, 'Ready');
        return true;
    } catch (error) {
        console.error('[Whisper] Init failed:', error);
        return false;
    }
}

export async function transcribe(
    audioData: Float32Array,
    options: { language?: string; onProgress?: (progress: number) => void } = {}
): Promise<string> {
    if (!whisperInstance || !WhisperModule) {
        throw new Error('Whisper not initialized');
    }

    try {
        const durationSeconds = audioData.length / 16000;
        console.log(`[Whisper] Transcribing ${durationSeconds.toFixed(1)}s...`);
        const startTime = Date.now();

        const params = new WhisperModule.WhisperFullParams(WhisperModule.WhisperSamplingStrategy.Greedy);

        const isTranslateMode = options.language === 'en-translate';
        params.language = isTranslateMode ? 'auto' : (options.language || 'auto');
        params.translate = isTranslateMode;
        params.printProgress = false;
        params.singleSegment = durationSeconds < 25;
        params.printRealtime = false;

        if (options.onProgress) params.onProgress = options.onProgress;

        const result = whisperInstance.full(params, audioData);
        const duration = Date.now() - startTime;
        console.log(`[Whisper] Done in ${duration}ms: "${result?.substring(0, 60) || ''}"`);

        return result || '';
    } catch (error) {
        console.error('[Whisper] Transcription failed:', error);
        throw error;
    }
}

export function getAccelerationInfo(): { type: string; available: boolean } {
    if (process.platform === 'darwin') {
        return { type: 'Metal', available: true };
    } else if (process.platform === 'win32') {
        return { type: 'CUDA (if available)', available: true };
    }
    return { type: 'CPU', available: true };
}

export function cleanup(): void {
    whisperInstance = null;
    currentModelType = null;
}
