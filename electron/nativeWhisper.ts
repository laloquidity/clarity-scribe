/**
 * Native Whisper Service — Cross-platform transcription
 * macOS: Uses @napi-rs/whisper for GPU-accelerated transcription (Metal)
 * Windows: Uses smart-whisper with GPU acceleration (CUDA → Vulkan → CPU)
 * Audio segmentation: Silero VAD for intelligent speech boundary detection
 */

import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import https from 'https';
import { createWriteStream, mkdirSync, statSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { initVAD, detectSpeechSegments, isVADReady } from './vadService';
import * as parakeetService from './parakeetService';

const IS_WINDOWS = process.platform === 'win32';

// Model URLs (used by both backends; smart-whisper also has its own manager)
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

// Map our model names to smart-whisper's model manager names
const SMART_WHISPER_MODEL_NAMES: Record<string, string> = {
    'turbo': 'large-v3-turbo',
    'small': 'small',
};

let whisperInstance: any = null;
let currentModelType: string | null = null;

// --- @napi-rs/whisper (macOS) ---
let NapiWhisperModule: any = null;

// --- smart-whisper (Windows) ---
let SmartWhisperClass: any = null;

// --- GPU Backend Detection (Windows) ---
type GpuBackend = 'cuda' | 'vulkan' | 'cpu';
let detectedBackend: GpuBackend = 'cpu';

/**
 * Detect the best available GPU backend on Windows.
 * Priority: CUDA (NVIDIA) → Vulkan (any GPU) → CPU
 */
function detectGpuBackend(): GpuBackend {
    if (!IS_WINDOWS) return 'cpu';

    const gpuDir = getGpuDllDir();

    // Check CUDA: need NVIDIA GPU + cuda DLL directory
    const cudaDir = join(gpuDir, 'cuda');
    if (existsSync(join(cudaDir, 'whisper.dll')) && existsSync(join(cudaDir, 'ggml-cuda.dll'))) {
        try {
            execSync('nvidia-smi --query-gpu=name --format=csv,noheader', {
                encoding: 'utf-8', timeout: 3000, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore']
            });
            return 'cuda';
        } catch { /* no NVIDIA GPU */ }
    }

    // Check Vulkan: need vulkan DLL directory (works on any modern GPU)
    const vulkanDir = join(gpuDir, 'vulkan');
    if (existsSync(join(vulkanDir, 'whisper.dll')) && existsSync(join(vulkanDir, 'ggml-vulkan.dll'))) {
        return 'vulkan';
    }

    return 'cpu';
}

/**
 * Get the directory containing GPU DLLs.
 * In dev: resources/win-gpu/   In production: process.resourcesPath/win-gpu/
 */
function getGpuDllDir(): string {
    const { app } = require('electron');
    if (app.isPackaged) {
        return join(process.resourcesPath!, 'win-gpu');
    }
    return join(app.getAppPath(), 'resources', 'win-gpu');
}

/**
 * Prepend the GPU backend DLL directory to PATH so the OS loader finds
 * the GPU-accelerated whisper.dll and its dependencies (ggml-cuda.dll etc.)
 * BEFORE the CPU-only ones bundled inside smart-whisper.
 */
function injectGpuDllPath(backend: GpuBackend): void {
    if (backend === 'cpu') return;
    const dllDir = join(getGpuDllDir(), backend);
    if (existsSync(dllDir)) {
        process.env.PATH = dllDir + ';' + (process.env.PATH || '');
        console.log(`[Whisper] Injected ${backend.toUpperCase()} DLL path: ${dllDir}`);
    }
    // Also add the CUDA Toolkit bin directory for transitive deps (nvJitLink, nvrtc, etc.)
    if (backend === 'cuda') {
        const cudaPath = process.env.CUDA_PATH || 'C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v13.2';
        const cudaBinX64 = join(cudaPath, 'bin', 'x64');
        const cudaBin = join(cudaPath, 'bin');
        if (existsSync(cudaBinX64)) {
            process.env.PATH = cudaBinX64 + ';' + (process.env.PATH || '');
            console.log(`[Whisper] Injected CUDA Toolkit path: ${cudaBinX64}`);
        }
        if (existsSync(cudaBin)) {
            process.env.PATH = cudaBin + ';' + (process.env.PATH || '');
        }
    }
}

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
    if (IS_WINDOWS && SmartWhisperClass) {
        // Use smart-whisper's built-in model manager
        try {
            const { manager } = require('smart-whisper');
            const modelName = SMART_WHISPER_MODEL_NAMES[modelType] || SMART_WHISPER_MODEL_NAMES['turbo'];
            return manager.check(modelName);
        } catch {
            // Fallback to manual check
        }
    }

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
    if (IS_WINDOWS) {
        // Try smart-whisper's built-in model manager first
        try {
            const { manager } = require('smart-whisper');
            const modelName = SMART_WHISPER_MODEL_NAMES[modelType] || SMART_WHISPER_MODEL_NAMES['turbo'];
            console.log(`[Whisper] Downloading ${modelName} via smart-whisper manager...`);
            onProgress?.(10, 'Downloading model...');
            await manager.download(modelName);
            console.log(`[Whisper] Download complete via smart-whisper manager`);
            onProgress?.(100, 'Download complete');
            return;
        } catch (e) {
            console.warn('[Whisper] smart-whisper manager download failed, falling back to manual download:', e);
        }
    }

    // Fallback: manual download
    const modelsDir = getModelsDir();
    try { mkdirSync(modelsDir, { recursive: true }); } catch { /* exists */ }

    const modelUrl = MODEL_URLS[modelType] || MODEL_URLS['turbo'];
    const modelFile = MODEL_FILES[modelType] || MODEL_FILES['turbo'];
    const modelPath = join(modelsDir, modelFile);

    console.log(`[Whisper] Downloading ${modelType} to ${modelPath}`);
    await downloadFile(modelUrl, modelPath, onProgress);
    console.log(`[Whisper] Download complete`);
}

function getModelPath(modelType: string): string {
    if (IS_WINDOWS) {
        // Try smart-whisper's model manager path first
        try {
            const { manager } = require('smart-whisper');
            const modelName = SMART_WHISPER_MODEL_NAMES[modelType] || SMART_WHISPER_MODEL_NAMES['turbo'];
            if (manager.check(modelName)) {
                return manager.resolve(modelName);
            }
        } catch { /* fall through */ }
    }

    const modelFile = MODEL_FILES[modelType] || MODEL_FILES['turbo'];
    return join(getModelsDir(), modelFile);
}

export async function initWhisper(
    modelType: string = 'turbo',
    onProgress?: (percent: number, status: string) => void
): Promise<boolean> {
    try {
        if (IS_WINDOWS) {
            return await initSmartWhisper(modelType, onProgress);
        } else {
            return await initNapiWhisper(modelType, onProgress);
        }
    } catch (error) {
        console.error('[Whisper] Init failed:', error);
        return false;
    }
}

// --- Windows: smart-whisper initialization ---
async function initSmartWhisper(
    modelType: string,
    onProgress?: (percent: number, status: string) => void
): Promise<boolean> {
    // Detect and inject GPU backend BEFORE loading smart-whisper
    if (!SmartWhisperClass) {
        detectedBackend = detectGpuBackend();
        console.log(`[Whisper] Detected GPU backend: ${detectedBackend.toUpperCase()}`);
        injectGpuDllPath(detectedBackend);

        try {
            const smartWhisper = require('smart-whisper');
            SmartWhisperClass = smartWhisper.Whisper;
            console.log('[Whisper] smart-whisper module loaded');
        } catch (importErr) {
            console.error('[Whisper] Failed to load smart-whisper:', importErr);
            throw importErr;
        }
    }

    if (!(await isModelDownloaded(modelType))) {
        onProgress?.(0, 'Downloading model...');
        await downloadModel(modelType, onProgress);
    }

    if (whisperInstance && currentModelType === modelType) {
        return true;
    }

    const modelPath = getModelPath(modelType);
    console.log(`[Whisper] Loading model via smart-whisper: ${modelPath}`);
    onProgress?.(90, 'Loading model...');

    // offload: 86400 = keep model in memory for 24h (0 means "free immediately" — a bug!)
    // gpu: true = use CUDA if available, falls back to CPU transparently
    whisperInstance = new SmartWhisperClass(modelPath, { gpu: true, offload: 86400 });
    await whisperInstance.load();
    currentModelType = modelType;

    // Pre-warm: force compute buffer allocation so first real transcription is instant
    console.log('[Whisper] Pre-warming compute buffers...');
    const warmupAudio = new Float32Array(16000); // 1s of silence at 16kHz
    try {
        const warmupTask = await whisperInstance.transcribe(warmupAudio, {
            language: 'en',
            single_segment: true,
            no_timestamps: true,
        });
        await warmupTask.result;
        console.log('[Whisper] Pre-warm complete');
    } catch (e) {
        console.warn('[Whisper] Pre-warm failed (non-fatal):', e);
    }

    console.log(`[Whisper] ✓ Ready (smart-whisper)`);
    onProgress?.(100, 'Ready');
    return true;
}

// --- macOS: @napi-rs/whisper initialization ---
async function initNapiWhisper(
    modelType: string,
    onProgress?: (percent: number, status: string) => void
): Promise<boolean> {
    if (!NapiWhisperModule) {
        try {
            NapiWhisperModule = await import('@napi-rs/whisper');
            console.log('[Whisper] @napi-rs/whisper module loaded');
        } catch (importErr: any) {
            console.error('[Whisper] Failed to load @napi-rs/whisper:', importErr);
            throw importErr;
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

    whisperInstance = new NapiWhisperModule.Whisper(modelBuffer);
    currentModelType = modelType;

    console.log(`[Whisper] ✓ Ready (@napi-rs/whisper)`);
    onProgress?.(100, 'Ready');
    return true;
}

// --- Engine Selection ---
type TranscriptionEngine = 'auto' | 'whisper' | 'parakeet';
let currentEngine: TranscriptionEngine = 'auto';

export function setTranscriptionEngine(engine: TranscriptionEngine): void {
    currentEngine = engine;
    console.log(`[Engine] Transcription engine set to: ${engine}`);
}

export function getTranscriptionEngine(): TranscriptionEngine {
    return currentEngine;
}

export async function initParakeetEngine(
    onProgress?: (percent: number, status: string) => void
): Promise<boolean> {
    try {
        const ok = await parakeetService.initParakeet(onProgress);
        if (ok) {
            console.log('[Engine] Parakeet TDT engine initialized');
        }
        return ok;
    } catch (e) {
        console.error('[Engine] Parakeet init failed:', e);
        return false;
    }
}

export function getEngineInfo(): { whisper: string; parakeet: boolean; currentEngine: string } {
    return {
        whisper: getAccelerationInfo().type,
        parakeet: parakeetService.isParakeetAvailable(),
        currentEngine,
    };
}

export async function transcribe(
    audioData: Float32Array,
    options: { language?: string; onProgress?: (progress: number) => void } = {}
): Promise<string> {
    const durationSeconds = audioData.length / 16000;
    console.log(`[Engine] Transcribing ${durationSeconds.toFixed(1)}s (engine=${currentEngine}, lang=${options.language || 'auto'})...`);
    const startTime = Date.now();

    // Determine whether to use Parakeet
    const language = options.language || 'auto';
    const useParakeet = (
        currentEngine !== 'whisper' &&
        parakeetService.isParakeetAvailable() &&
        parakeetService.isLanguageSupported(language) &&
        language !== 'en-translate' // Parakeet doesn't do translation
    );

    if (useParakeet) {
        try {
            console.log('[Engine] Using Parakeet TDT');
            const text = await parakeetService.transcribeParakeet(audioData, options);
            if (text) return text;
            console.warn('[Engine] Parakeet returned empty, falling back to Whisper');
        } catch (error) {
            console.warn('[Engine] Parakeet failed, falling back to Whisper:', error);
        }
    }

    // Whisper path
    if (!whisperInstance) {
        throw new Error('Whisper not initialized');
    }

    try {
        if (IS_WINDOWS) {
            return await transcribeSmartWhisper(audioData, options, durationSeconds, startTime);
        } else {
            return await transcribeNapi(audioData, options, durationSeconds, startTime);
        }
    } catch (error) {
        console.error('[Whisper] Transcription failed:', error);
        throw error;
    }
}

// --- Audio Segmentation ---
// Primary: Silero VAD detects speech boundaries, splits on natural pauses
// Fallback: Fixed 28s chunks with 1s overlap if VAD unavailable
const CHUNK_DURATION_SECONDS = 28;
const CHUNK_OVERLAP_SECONDS = 1;
const SAMPLE_RATE = 16000;

// Initialize VAD (called during app startup)
export async function initAudioSegmentation(): Promise<void> {
    try {
        const ok = await initVAD();
        if (ok) {
            console.log('[Whisper] VAD-based segmentation enabled');
        } else {
            console.warn('[Whisper] VAD init failed, using fixed chunking fallback');
        }
    } catch (e) {
        console.warn('[Whisper] VAD init error, using fixed chunking fallback:', e);
    }
}

function chunkAudioFixed(audioData: Float32Array): Float32Array[] {
    const chunkSamples = CHUNK_DURATION_SECONDS * SAMPLE_RATE;
    const overlapSamples = CHUNK_OVERLAP_SECONDS * SAMPLE_RATE;
    const totalSamples = audioData.length;

    if (totalSamples <= chunkSamples) {
        return [audioData];
    }

    const chunks: Float32Array[] = [];
    let offset = 0;

    while (offset < totalSamples) {
        const end = Math.min(offset + chunkSamples, totalSamples);
        chunks.push(audioData.slice(offset, end));
        offset += chunkSamples - overlapSamples;
        if (totalSamples - offset < SAMPLE_RATE * 2) {
            if (offset < totalSamples) {
                chunks.push(audioData.slice(offset));
            }
            break;
        }
    }

    console.log(`[Whisper] Fixed chunking: ${(totalSamples / SAMPLE_RATE).toFixed(1)}s → ${chunks.length} chunks`);
    return chunks;
}

async function segmentAudio(audioData: Float32Array): Promise<Float32Array[]> {
    const durationSeconds = audioData.length / SAMPLE_RATE;

    // Short audio doesn't need segmentation
    if (durationSeconds <= CHUNK_DURATION_SECONDS) {
        return [audioData];
    }

    // Try VAD-based segmentation
    if (isVADReady()) {
        try {
            const segments = await detectSpeechSegments(audioData, SAMPLE_RATE);
            if (segments.length > 0) {
                return segments.map(seg => audioData.slice(seg.startSample, seg.endSample));
            }
        } catch (e) {
            console.warn('[Whisper] VAD segmentation failed, falling back to fixed chunking:', e);
        }
    }

    // Fallback: fixed chunking
    return chunkAudioFixed(audioData);
}

// --- Phase 1A: Hallucination Detection ---
// Detect when Whisper repeats a phrase (4+ words) 3+ times consecutively
function detectHallucination(text: string): boolean {
    if (!text || text.length < 50) return false;
    // Match 4+ word phrase repeated 3+ times
    return /(\b[\w']+(?:\s+[\w']+){3,})\s*(?:\1\s*){2,}/i.test(text);
}

function cleanHallucination(text: string): string {
    // Remove all but the first occurrence of the repeated phrase
    return text.replace(/(\b[\w']+(?:\s+[\w']+){3,})\s*(?:\1\s*){2,}/gi, '$1').trim();
}

// --- Phase 1C: Overlap Deduplication ---
// Remove duplicate words at chunk boundaries from 1s audio overlap
function deduplicateOverlap(prevText: string, currText: string): string {
    if (!prevText || !currText) return currText;
    const prevWords = prevText.split(/\s+/).slice(-15); // last 15 words
    const currWords = currText.split(/\s+/);
    // Find longest matching suffix of prev / prefix of curr (min 3 words)
    for (let len = Math.min(prevWords.length, currWords.length); len >= 3; len--) {
        const suffix = prevWords.slice(-len).join(' ').toLowerCase();
        const prefix = currWords.slice(0, len).join(' ').toLowerCase();
        if (suffix === prefix) {
            console.log(`[Whisper] Dedup: removed ${len} overlapping words at chunk boundary`);
            return currWords.slice(len).join(' ');
        }
    }
    return currText;
}

// --- Phase 1B: Context Prompting ---
// Extract the last sentence from a transcription to use as prompt for the next chunk
function extractContextPrompt(text: string): string {
    if (!text) return '';
    // Try to get the last complete sentence
    const lastSentence = text.match(/[^.!?]*[.!?]\s*$/)?.[0]?.trim();
    if (lastSentence && lastSentence.length > 10) return lastSentence.slice(0, 224);
    // Fallback: last ~100 chars
    return text.slice(-200).trim();
}

// --- Windows: smart-whisper transcription ---
async function transcribeSmartWhisper(
    audioData: Float32Array,
    options: { language?: string; onProgress?: (progress: number) => void },
    durationSeconds: number,
    startTime: number
): Promise<string> {
    const isTranslateMode = options.language === 'en-translate';
    const language = isTranslateMode ? 'auto' : (options.language || 'auto');

    const chunks = await segmentAudio(audioData);
    const transcriptions: string[] = [];
    let contextPrompt = '';

    for (let i = 0; i < chunks.length; i++) {
        const chunkDuration = chunks[i].length / SAMPLE_RATE;
        console.log(`[Whisper] Transcribing chunk ${i + 1}/${chunks.length} (${chunkDuration.toFixed(1)}s)...`);

        const transcribeOpts: any = {
            language,
            translate: isTranslateMode,
            print_progress: false,
            single_segment: chunkDuration < 25,
            format: 'simple' as const,
        };
        // Phase 1B: context prompting
        if (contextPrompt && i > 0) {
            transcribeOpts.initial_prompt = contextPrompt;
        }

        let task = await whisperInstance.transcribe(chunks[i], transcribeOpts);
        let results = await task.result;
        let text = results.map((r: any) => r.text).join(' ').trim();

        // Phase 1A: hallucination detection & retry
        if (text && detectHallucination(text)) {
            console.log(`[Whisper] ⚠ Hallucination detected in chunk ${i + 1}/${chunks.length}, retrying with temperature=0.2...`);
            const retryOpts = { ...transcribeOpts, temperature: 0.2, no_speech_threshold: 0.4 };
            task = await whisperInstance.transcribe(chunks[i], retryOpts);
            results = await task.result;
            const retryText = results.map((r: any) => r.text).join(' ').trim();

            if (retryText && !detectHallucination(retryText)) {
                text = retryText;
                console.log(`[Whisper] ✓ Retry succeeded for chunk ${i + 1}`);
            } else {
                // Both attempts hallucinated — clean the shorter one
                const cleaned = cleanHallucination(text);
                const retryCleaned = retryText ? cleanHallucination(retryText) : '';
                text = (retryCleaned.length > cleaned.length) ? retryCleaned : cleaned;
                console.log(`[Whisper] Retry also hallucinated for chunk ${i + 1}, using cleaned text`);
            }
        }

        if (text) {
            // Phase 1C: overlap dedup (skip first chunk)
            if (transcriptions.length > 0) {
                text = deduplicateOverlap(transcriptions[transcriptions.length - 1], text);
            }
            transcriptions.push(text);
            // Phase 1B: extract context for next chunk
            contextPrompt = extractContextPrompt(text);
        }

        if (options.onProgress) {
            options.onProgress(Math.round(((i + 1) / chunks.length) * 100));
        }
    }

    const fullText = transcriptions.join(' ').trim();
    const duration = Date.now() - startTime;
    console.log(`[Whisper] Done in ${duration}ms (${chunks.length} chunks): "${fullText?.substring(0, 80) || ''}"`);
    return fullText || '';
}

// --- macOS: @napi-rs/whisper transcription ---
async function transcribeNapi(
    audioData: Float32Array,
    options: { language?: string; onProgress?: (progress: number) => void },
    durationSeconds: number,
    startTime: number
): Promise<string> {
    const isTranslateMode = options.language === 'en-translate';
    const chunks = await segmentAudio(audioData);
    const transcriptions: string[] = [];
    let contextPrompt = '';

    for (let i = 0; i < chunks.length; i++) {
        const chunkDuration = chunks[i].length / SAMPLE_RATE;
        const params = new NapiWhisperModule.WhisperFullParams(NapiWhisperModule.WhisperSamplingStrategy.Greedy);

        params.language = isTranslateMode ? 'auto' : (options.language || 'auto');
        params.translate = isTranslateMode;
        params.printProgress = false;
        params.singleSegment = chunkDuration < 25;
        params.printRealtime = false;
        // Phase 1B: context prompting
        if (contextPrompt && i > 0) {
            params.initialPrompt = contextPrompt;
        }

        let text = whisperInstance.full(params, chunks[i]) || '';

        // Phase 1A: hallucination detection & retry
        if (text && detectHallucination(text)) {
            console.log(`[Whisper] ⚠ Hallucination detected in chunk ${i + 1}/${chunks.length}, retrying...`);
            const retryParams = new NapiWhisperModule.WhisperFullParams(NapiWhisperModule.WhisperSamplingStrategy.Greedy);
            retryParams.language = params.language;
            retryParams.translate = params.translate;
            retryParams.printProgress = false;
            retryParams.singleSegment = chunkDuration < 25;
            retryParams.printRealtime = false;
            retryParams.temperature = 0.2;
            if (contextPrompt) retryParams.initialPrompt = contextPrompt;

            const retryText = whisperInstance.full(retryParams, chunks[i]) || '';

            if (retryText && !detectHallucination(retryText)) {
                text = retryText;
                console.log(`[Whisper] ✓ Retry succeeded for chunk ${i + 1}`);
            } else {
                const cleaned = cleanHallucination(text);
                const retryCleaned = retryText ? cleanHallucination(retryText) : '';
                text = (retryCleaned.length > cleaned.length) ? retryCleaned : cleaned;
                console.log(`[Whisper] Retry also hallucinated for chunk ${i + 1}, using cleaned text`);
            }
        }

        if (text) {
            // Phase 1C: overlap dedup (skip first chunk)
            if (transcriptions.length > 0) {
                text = deduplicateOverlap(transcriptions[transcriptions.length - 1], text);
            }
            transcriptions.push(text);
            // Phase 1B: extract context for next chunk
            contextPrompt = extractContextPrompt(text);
        }

        if (options.onProgress) {
            options.onProgress(Math.round(((i + 1) / chunks.length) * 100));
        }
    }

    const fullText = transcriptions.join(' ').trim();
    const duration = Date.now() - startTime;
    console.log(`[Whisper] Done in ${duration}ms (${chunks.length} chunks): "${fullText?.substring(0, 80) || ''}"`);
    return fullText || '';
}

export function getAccelerationInfo(): { type: string; available: boolean } {
    if (process.platform === 'darwin') {
        return { type: 'Metal', available: true };
    } else if (process.platform === 'win32') {
        const backendNames: Record<GpuBackend, string> = {
            cuda: 'CUDA',
            vulkan: 'Vulkan',
            cpu: 'CPU',
        };
        return { type: backendNames[detectedBackend], available: true };
    }
    return { type: 'CPU', available: true };
}

export function cleanup(): void {
    if (IS_WINDOWS && whisperInstance) {
        try {
            whisperInstance.free();
        } catch { /* ignore */ }
    }
    whisperInstance = null;
    currentModelType = null;
}
