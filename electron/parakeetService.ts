/**
 * Parakeet TDT 0.6B-v3 Service — High-performance ASR via ONNX Runtime
 * Downloads INT8-quantized ONNX models (~890MB) from HuggingFace
 * Supports 25 European languages, ~20x real-time on CPU, faster with CUDA
 */

import * as ort from 'onnxruntime-node';
import { existsSync, mkdirSync, createWriteStream, readFileSync } from 'fs';
import { join } from 'path';
import { app } from 'electron';
import https from 'https';
import { tdtGreedyDecode, loadVocabulary } from './tdtDecoder';

// HuggingFace model URLs (INT8 quantized)
const MODEL_BASE_URL = 'https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main';
const MODEL_FILES = [
    { name: 'encoder-int8.onnx', size: 1_400_000, label: 'encoder graph' },
    { name: 'encoder-int8.onnx.data', size: 838_000_000, label: 'encoder weights' },
    { name: 'decoder_joint-int8.onnx', size: 52_000_000, label: 'decoder' },
    { name: 'vocab.txt', size: 92_000, label: 'vocabulary' },
];

const TOTAL_SIZE = MODEL_FILES.reduce((s, f) => s + f.size, 0);

// Supported languages (Parakeet TDT 0.6B-v3)
const SUPPORTED_LANGUAGES = [
    'en', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'pl', 'uk', 'cs',
    'ro', 'hu', 'sv', 'bg', 'da', 'fi', 'el', 'hr', 'lt', 'sk',
    'sl', 'et', 'lv', 'no', 'ca'
];

let encoderSession: ort.InferenceSession | null = null;
let decoderSession: ort.InferenceSession | null = null;
let vocabulary: string[] = [];
let isInitialized = false;

function getModelDir(): string {
    const dir = join(app.getPath('home'), '.smart-whisper', 'models', 'parakeet-tdt-0.6b-v3');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * Download a single model file with progress reporting
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
                    return reject(new Error(`HTTP ${res.statusCode}`));
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
 * Download all Parakeet model files
 */
export async function downloadParakeetModel(
    onProgress?: (percent: number, status: string) => void
): Promise<boolean> {
    const modelDir = getModelDir();
    let downloadedTotal = 0;

    for (const file of MODEL_FILES) {
        const filePath = join(modelDir, file.name);
        if (existsSync(filePath)) {
            downloadedTotal += file.size;
            continue;
        }

        const url = `${MODEL_BASE_URL}/${file.name}`;
        console.log(`[Parakeet] Downloading ${file.label} (${(file.size / 1e6).toFixed(0)}MB)...`);
        onProgress?.(Math.round((downloadedTotal / TOTAL_SIZE) * 100), `Downloading ${file.label}...`);

        try {
            const baseDownloaded = downloadedTotal;
            await downloadFile(url, filePath, (bytes) => {
                const total = baseDownloaded + bytes;
                onProgress?.(Math.round((total / TOTAL_SIZE) * 100), `Downloading ${file.label}...`);
            });
            downloadedTotal += file.size;
        } catch (error) {
            console.error(`[Parakeet] Failed to download ${file.name}:`, error);
            return false;
        }
    }

    console.log('[Parakeet] All model files downloaded');
    return true;
}

/**
 * Initialize Parakeet ONNX Runtime sessions
 */
export async function initParakeet(
    onProgress?: (percent: number, status: string) => void
): Promise<boolean> {
    if (isInitialized) return true;

    const modelDir = getModelDir();

    // Check if all model files exist, download if needed
    const allExist = MODEL_FILES.every(f => existsSync(join(modelDir, f.name)));
    if (!allExist) {
        onProgress?.(0, 'Downloading Parakeet model...');
        const downloaded = await downloadParakeetModel(onProgress);
        if (!downloaded) return false;
    }

    try {
        onProgress?.(90, 'Loading Parakeet encoder...');
        console.log('[Parakeet] Loading encoder...');

        // Determine execution provider
        const providers: string[] = ['cpu'];
        // Try CUDA on Windows with NVIDIA GPU
        if (process.platform === 'win32') {
            try {
                // Check if CUDA provider is available
                providers.unshift('cuda');
            } catch { /* CUDA not available, use CPU */ }
        }

        encoderSession = await ort.InferenceSession.create(
            join(modelDir, 'encoder-int8.onnx'),
            {
                executionProviders: providers,
                logSeverityLevel: 3,
                graphOptimizationLevel: 'all',
            }
        );
        console.log('[Parakeet] Encoder loaded');

        onProgress?.(95, 'Loading Parakeet decoder...');
        decoderSession = await ort.InferenceSession.create(
            join(modelDir, 'decoder_joint-int8.onnx'),
            {
                executionProviders: ['cpu'], // Decoder is tiny, CPU is fine
                logSeverityLevel: 3,
            }
        );
        console.log('[Parakeet] Decoder loaded');

        // Load vocabulary
        vocabulary = loadVocabulary(join(modelDir, 'vocab.txt'));
        console.log(`[Parakeet] Vocabulary loaded: ${vocabulary.length} tokens`);

        isInitialized = true;
        onProgress?.(100, 'Parakeet ready');
        console.log('[Parakeet] ✓ Initialized successfully');
        return true;
    } catch (error) {
        console.error('[Parakeet] Initialization failed:', error);
        encoderSession = null;
        decoderSession = null;
        isInitialized = false;
        return false;
    }
}

/**
 * Transcribe audio using Parakeet TDT
 */
export async function transcribeParakeet(
    audioData: Float32Array,
    options: { language?: string; onProgress?: (progress: number) => void } = {}
): Promise<string> {
    if (!isInitialized || !encoderSession || !decoderSession) {
        throw new Error('Parakeet not initialized');
    }

    const startTime = Date.now();
    const durationSeconds = audioData.length / 16000;
    console.log(`[Parakeet] Transcribing ${durationSeconds.toFixed(1)}s...`);

    try {
        // Prepare audio input: [1, T] at 16kHz
        const audioTensor = new ort.Tensor('float32', audioData, [1, audioData.length]);
        const audioLengths = new ort.Tensor('int64', BigInt64Array.from([BigInt(audioData.length)]), [1]);

        // Run encoder
        const encoderResult = await encoderSession.run({
            audio_signal: audioTensor,
            length: audioLengths,
        });

        // Get encoder output and lengths
        const encoderOutput = encoderResult.logits || encoderResult.outputs || Object.values(encoderResult)[0];
        const encodedLengths = encoderResult.encoded_lengths || Object.values(encoderResult)[1];

        // Run TDT decoder
        const decoded = await tdtGreedyDecode(
            decoderSession,
            encoderOutput as ort.Tensor,
            encodedLengths as ort.Tensor,
            vocabulary,
        );

        const duration = Date.now() - startTime;
        console.log(`[Parakeet] Done in ${duration}ms: "${decoded.text.substring(0, 80)}"`);
        return decoded.text;
    } catch (error) {
        console.error('[Parakeet] Transcription failed:', error);
        throw error;
    }
}

/**
 * Check if Parakeet is available and initialized
 */
export function isParakeetAvailable(): boolean {
    return isInitialized;
}

/**
 * Check if a language is supported by Parakeet
 */
export function isLanguageSupported(language: string): boolean {
    if (language === 'auto') return true;
    return SUPPORTED_LANGUAGES.includes(language);
}

/**
 * Get Parakeet acceleration info
 */
export function getParakeetInfo(): { available: boolean; model: string; languages: number } {
    return {
        available: isInitialized,
        model: 'Parakeet TDT 0.6B-v3',
        languages: SUPPORTED_LANGUAGES.length,
    };
}

export function cleanupParakeet(): void {
    encoderSession = null;
    decoderSession = null;
    vocabulary = [];
    isInitialized = false;
}
