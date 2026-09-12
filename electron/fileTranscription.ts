/**
 * File transcription — the work behind `POST /v1/audio/transcriptions`.
 *
 * Transcribing an uploaded recording needs two things the main process cannot
 * do by itself, so this module is mostly an orchestrator:
 *
 *   1. DECODING. `.m4a`, `.mp3`, `.ogg` need real codecs. Electron already
 *      ships them inside Chromium, but only a renderer can reach them (see
 *      src/utils/audioFileDecode.ts). So the bytes go down to the window, and
 *      16 kHz mono float samples come back.
 *   2. POST-PROCESSING. Filler-word removal and Personal Dictionary
 *      replacement live in the renderer alongside the dictation pipeline. A
 *      file transcript goes through the same cleanup a dictation does, so the
 *      endpoint's output matches what the app itself would have produced.
 *
 * Between those two the main process runs the engines exactly as dictation
 * does — `nativeWhisper.transcribe`, which picks Parakeet or Whisper, segments
 * long audio on Silero VAD boundaries, and reassembles the text.
 *
 * WHY a pull-free, chunked transfer: a 45-minute call is ~173 MB of float
 * samples. Shipping that as one IPC message is slow and, at the top of the
 * size range, unreliable. The renderer pushes it in bounded slices into a
 * buffer the main process allocated up front, so peak memory is one copy and
 * no single message is enormous.
 *
 * WHY one job at a time: the endpoint's contract is a single owner uploading a
 * single call, and the engines are shared with live dictation — which is the
 * app's core promise and must not be slowed down by a background batch job.
 * A second caller gets a 409 telling them to retry, not a queue that silently
 * grows.
 */

import { httpError, type FileTranscriptionRequest, type FileTranscriptionResult } from './localApi';
import { checkAudioUpload, mimeForContainer } from './audioFile';

/** Channel the main process uses to hand a unit of work to the renderer. */
export const JOB_REQUEST_CHANNEL = 'file-job-request';
/** Channel the renderer answers on. */
export const JOB_EMIT_CHANNEL = 'file-job-emit';

/** Samples per IPC message: 4M floats = 16 MB, ~4 minutes of 16 kHz audio. */
const CHUNK_SAMPLES = 4 * 1024 * 1024;

/**
 * How long a job may go with no word from the renderer before we give up.
 *
 * This is a liveness watchdog, not a work budget: the renderer sends a message
 * per chunk, so the gap between messages stays small even for a long file.
 * It exists so a renderer that reloaded or crashed mid-job fails the HTTP
 * request instead of holding the caller until their own timeout.
 */
const RENDERER_SILENCE_TIMEOUT_MS = 180_000;

/** Sample rate the engines require. */
const SAMPLE_RATE = 16000;

/** Anything shorter than this almost certainly decoded wrong. */
const MIN_AUDIO_SECONDS = 0.05;

/** Everything this module needs from the host, injected so it stays testable. */
export interface FileTranscriptionDeps {
    /** Post a job to the renderer. Returns false when no window is available. */
    sendToRenderer: (channel: string, payload: unknown) => boolean;
    /** Run the engines over 16 kHz mono samples — the same call dictation makes. */
    transcribe: (pcm: Float32Array, language?: string) => Promise<string>;
    /** A human-readable reason the app cannot take the job now, or null. */
    busyReason: () => string | null;
    /** Whether the transcription engines have finished loading. */
    engineReady: () => boolean;
    /** Optional hook so the host can log/emit progress. */
    onStage?: (stage: 'decoding' | 'transcribing' | 'formatting' | 'done', detail?: string) => void;
}

// --- Renderer job bookkeeping -------------------------------------------------

interface PendingJob {
    resolve: (value: any) => void;
    reject: (err: Error) => void;
    /** Allocated once `begin` reports the total; filled by `chunk` messages. */
    pcm: Float32Array | null;
    received: number;
    timer: NodeJS.Timeout;
}

const pending = new Map<string, PendingJob>();
let jobCounter = 0;

/** One in-flight upload at a time; holds the caller's description for the 409. */
let activeUpload: string | null = null;

/**
 * Handle one message from the renderer. Wire this to
 * `ipcMain.on(JOB_EMIT_CHANNEL, …)`.
 *
 * Unknown job ids are ignored rather than thrown on: they are the normal
 * result of a renderer reload racing a job we already timed out.
 */
export function handleRendererMessage(msg: any): void {
    const job = msg && typeof msg.jobId === 'string' ? pending.get(msg.jobId) : undefined;
    if (!job) return;

    // Any message is proof of life — restart the watchdog.
    job.timer.refresh();

    switch (msg.kind) {
        case 'begin': {
            const total = Number(msg.totalSamples);
            if (!Number.isFinite(total) || total <= 0) {
                settle(msg.jobId, () => job.reject(httpError(400, 'The audio file decoded to zero samples — it contains no audio.')));
                return;
            }
            job.pcm = new Float32Array(total);
            job.received = 0;
            return;
        }
        case 'chunk': {
            if (!job.pcm) return; // chunk before begin — renderer bug; let the watchdog fire
            const offset = Number(msg.offset) || 0;
            const samples: Float32Array = msg.samples instanceof Float32Array
                ? msg.samples
                : new Float32Array(msg.samples);
            if (offset + samples.length > job.pcm.length) {
                settle(msg.jobId, () => job.reject(new Error('Decoded audio was larger than the renderer declared.')));
                return;
            }
            job.pcm.set(samples, offset);
            job.received += samples.length;
            return;
        }
        case 'done': {
            if (!job.pcm) {
                settle(msg.jobId, () => job.reject(new Error('The renderer reported no decoded audio.')));
                return;
            }
            // A short transfer means lost chunks; hand back only what is whole.
            const pcm = job.received === job.pcm.length ? job.pcm : job.pcm.subarray(0, job.received);
            settle(msg.jobId, () => job.resolve(pcm));
            return;
        }
        case 'text': {
            settle(msg.jobId, () => job.resolve(String(msg.text ?? '')));
            return;
        }
        case 'error': {
            // What the window reports is the decoder refusing the FILE (corrupt,
            // truncated, a codec it cannot open) — the caller's problem to fix,
            // so 400. Left as a plain Error it surfaced as a 500, which reads as
            // a Scribe bug and invites pointless retries.
            settle(msg.jobId, () => job.reject(httpError(400, String(msg.message || 'The audio could not be decoded.'))));
            return;
        }
        default:
            return;
    }
}

/** Clear a job's bookkeeping, then run its completion. */
function settle(jobId: string, run: () => void): void {
    const job = pending.get(jobId);
    if (job) clearTimeout(job.timer);
    pending.delete(jobId);
    run();
}

/**
 * Dispatch one job to the renderer and await its answer.
 *
 * `decode` resolves with the samples; `postprocess` resolves with the text.
 */
function runRendererJob<T>(payload: Record<string, unknown>, deps: FileTranscriptionDeps): Promise<T> {
    const jobId = `fj_${Date.now().toString(36)}_${++jobCounter}`;

    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            pending.delete(jobId);
            reject(httpError(504, 'Clarity Scribe’s window stopped responding while processing the audio. Make sure the app is running, then try again.'));
        }, RENDERER_SILENCE_TIMEOUT_MS);
        // Never let a pending job keep the app alive at quit time.
        timer.unref?.();

        pending.set(jobId, { resolve, reject, pcm: null, received: 0, timer });

        const delivered = deps.sendToRenderer(JOB_REQUEST_CHANNEL, { ...payload, jobId });
        if (!delivered) {
            settle(jobId, () => reject(httpError(
                503,
                'Clarity Scribe’s window is not available, so the audio cannot be decoded. The app must be running (it can be minimized to the tray).'
            )));
        }
    });
}

// --- The endpoint's work ------------------------------------------------------

/**
 * Transcribe one uploaded file, end to end.
 *
 * Rejections carry an HTTP status (see `httpError`) so the API layer can answer
 * 409 for "busy" and 400 for "that file is not audio" instead of flattening
 * everything into a 500.
 */
export async function transcribeUploadedFile(
    req: FileTranscriptionRequest,
    deps: FileTranscriptionDeps
): Promise<FileTranscriptionResult> {
    if (activeUpload) {
        throw httpError(409, `Clarity Scribe is already transcribing "${activeUpload}". This endpoint handles one file at a time — retry when it finishes.`);
    }

    const busy = deps.busyReason();
    if (busy) throw httpError(409, busy);

    if (!deps.engineReady()) {
        throw httpError(503, 'The transcription engines are still loading. Wait a few seconds and try again.');
    }

    // Reject what we can positively identify as wrong before spending a decode
    // on it, so the caller gets a specific reason rather than "decode failed".
    const check = checkAudioUpload(req.bytes, req.filename);
    if (!check.ok) throw httpError(400, check.reason);

    activeUpload = req.filename || 'an uploaded file';
    try {
        deps.onStage?.('decoding', activeUpload);

        // Copy into a plain Uint8Array: `req.bytes` is a view into the whole
        // request body, and structured-cloning a view sends the entire backing
        // buffer across the process boundary.
        const bytes = new Uint8Array(req.bytes.byteLength);
        bytes.set(req.bytes);

        const pcm = await runRendererJob<Float32Array>({
            kind: 'decode',
            bytes,
            mime: mimeForContainer(check.container, check.extension),
        }, deps);

        const durationSec = pcm.length / SAMPLE_RATE;
        if (durationSec < MIN_AUDIO_SECONDS) {
            throw httpError(400, 'The recording contains no audio (it decoded to well under a second).');
        }

        deps.onStage?.('transcribing', `${durationSec.toFixed(1)}s`);
        const raw = await deps.transcribe(pcm, req.language);

        if (!raw || !raw.trim()) {
            // Not an error: silence and pure noise legitimately transcribe to
            // nothing, and the contract has a place for that — an empty string.
            deps.onStage?.('done', 'empty');
            return { text: '', durationSec, language: req.language };
        }

        deps.onStage?.('formatting');
        // Post-processing is best-effort. If the renderer cannot do it, the raw
        // engine text is still a usable transcript and is far better than
        // failing a request that already did all the expensive work.
        let text = raw;
        try {
            text = await runRendererJob<string>({ kind: 'postprocess', text: raw }, deps);
            if (!text.trim()) text = raw;
        } catch {
            text = raw;
        }

        deps.onStage?.('done', `${text.length} chars`);
        return { text: text.trim(), durationSec, language: req.language };
    } finally {
        activeUpload = null;
    }
}

/** Samples per renderer→main message, exported so the renderer agrees on it. */
export const RENDERER_CHUNK_SAMPLES = CHUNK_SAMPLES;

/** Test hook: drop all in-flight jobs. */
export function __resetFileTranscription(): void {
    for (const [, job] of pending) clearTimeout(job.timer);
    pending.clear();
    activeUpload = null;
}
