/**
 * Streaming transcriber — transcribe-while-recording for the Parakeet engine.
 *
 * The renderer streams raw audio chunks (native sample rate) during recording.
 * An energy-based segmenter closes a segment at natural pauses (or a hard cap),
 * and each closed segment is resampled to 16k and transcribed IMMEDIATELY while
 * the user keeps speaking. At stop, only the small tail segment remains, so
 * perceived stop→text latency is ~100-300ms regardless of recording length
 * (previously the entire clip was processed after stop).
 *
 * Segments are transcribed independently and joined with spaces — the same
 * semantics as the existing VAD-batched long-audio path in parakeetService.
 * If anything fails mid-session the session is marked unhealthy and the caller
 * falls back to the classic full-buffer batch path (the renderer still sends
 * the full recording at stop), so streaming can never lose audio.
 *
 * Energy segmentation instead of Silero here: Silero VAD is used by the batch
 * path over complete buffers; for incremental chunks a simple RMS gate with
 * hysteresis is cheap (runs on every chunk) and only decides SPLIT POINTS in
 * long silences — actual speech detection quality still comes from Parakeet.
 */

type SegmentTranscriber = (audio16k: Float32Array) => Promise<string>;
type PartialListener = (fullTextSoFar: string, segmentIndex: number) => void;

// ── Tunables ────────────────────────────────────────────────────────────────
const SILENCE_RMS = 0.006;          // below this RMS a 32ms window counts as silence
const SILENCE_CLOSE_MS = 650;       // continuous silence that closes a segment
const MIN_VOICED_MS = 550;          // don't close segments with less voiced audio than this
const SOFT_CAP_MS = 15_000;         // no-pause talkers: split at the quietest recent window
const SOFT_CAP_LOOKBACK_MS = 6_000; // window in which the quietest split point is searched
const MAX_SEGMENT_MS = 28_000;      // hard cap (matches vadService segment cap)
const MIN_TAIL_MS = 250;            // tail shorter than this (and unvoiced) is dropped
const WINDOW_MS = 32;               // RMS analysis window

/**
 * Cubic (Catmull-Rom) resampler — same algorithm as src/workers/audioWorker.ts
 * (keep in sync) so streamed segments match the batch path's audio quality.
 */
export function resampleCubic(audio: Float32Array, fromRate: number, toRate: number): Float32Array {
    if (fromRate === toRate) return audio;
    const ratio = fromRate / toRate;
    const newLength = Math.round(audio.length / ratio);
    const result = new Float32Array(newLength);
    for (let i = 0; i < newLength; i++) {
        const position = i * ratio;
        const index = Math.floor(position);
        const t = position - index;
        const y0 = audio[Math.max(0, index - 1)];
        const y1 = audio[index];
        const y2 = audio[Math.min(audio.length - 1, index + 1)];
        const y3 = audio[Math.min(audio.length - 1, index + 2)];
        const c0 = y1;
        const c1 = 0.5 * (y2 - y0);
        const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
        const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
        result[i] = ((c3 * t + c2) * t + c1) * t + c0;
    }
    return result;
}

interface RmsWindow {
    startSample: number;            // offset within the OPEN segment
    rms: number;
}

interface Session {
    sampleRate: number;
    chunks: Float32Array[];         // raw audio of the CURRENT (open) segment
    openSamples: number;            // samples in the open segment
    voicedMsInSegment: number;      // voiced audio accumulated in the open segment
    silenceRunMs: number;           // trailing continuous silence
    windowCarry: Float32Array | null; // partial RMS window across chunk boundaries
    rmsHistory: RmsWindow[];        // per-window RMS of the open segment (for quietest-split)
    texts: string[];                // completed segment texts, in order
    queue: Promise<void>;           // serializes segment transcriptions
    segmentsQueued: number;
    healthy: boolean;
    finalized: boolean;
}

let transcriberFn: SegmentTranscriber | null = null;
let partialListener: PartialListener | null = null;
let session: Session | null = null;

/** Inject the segment transcriber (parakeet single-pass). Enables streaming. */
export function configureStreaming(transcribe: SegmentTranscriber): void {
    transcriberFn = transcribe;
}

/** Subscribe to partial-transcript updates (joined text after each segment). */
export function onPartial(listener: PartialListener | null): void {
    partialListener = listener;
}

export function isSessionActive(): boolean {
    return session !== null && !session.finalized;
}

/**
 * Begin a streaming session. Returns false (and stays inactive) when no
 * transcriber is configured — callers then use the classic batch path.
 */
export function startSession(sampleRate: number): boolean {
    if (!transcriberFn || !(sampleRate > 0)) return false;
    session = {
        sampleRate,
        chunks: [],
        openSamples: 0,
        voicedMsInSegment: 0,
        silenceRunMs: 0,
        windowCarry: null,
        rmsHistory: [],
        texts: [],
        queue: Promise.resolve(),
        segmentsQueued: 0,
        healthy: true,
        finalized: false,
    };
    return true;
}

/** Abort and discard the current session (recording error / cancel). */
export function abortSession(): void {
    session = null;
}

/**
 * Push a raw audio chunk (native sample rate). Runs the RMS segmenter and
 * closes + queues a segment when a long-enough pause is found.
 */
export function pushChunk(chunk: Float32Array): void {
    const s = session;
    if (!s || s.finalized || chunk.length === 0) return;

    s.chunks.push(chunk);
    s.openSamples += chunk.length;

    // RMS windows over the chunk (with carry so windows span chunk boundaries)
    const windowSamples = Math.max(1, Math.round((WINDOW_MS / 1000) * s.sampleRate));
    let data = chunk;
    if (s.windowCarry && s.windowCarry.length > 0) {
        const merged = new Float32Array(s.windowCarry.length + chunk.length);
        merged.set(s.windowCarry, 0);
        merged.set(chunk, s.windowCarry.length);
        data = merged;
    }
    const fullWindows = Math.floor(data.length / windowSamples);
    // `data` = carry + chunk; the carry's first sample sits at this offset
    // within the open segment, so window w starts at firstWindowStart + w*win.
    const carryLen = s.windowCarry?.length ?? 0;
    const firstWindowStart = s.openSamples - chunk.length - carryLen;
    for (let w = 0; w < fullWindows; w++) {
        let sum = 0;
        const off = w * windowSamples;
        for (let i = 0; i < windowSamples; i++) {
            const v = data[off + i];
            sum += v * v;
        }
        const rms = Math.sqrt(sum / windowSamples);
        s.rmsHistory.push({ startSample: Math.max(0, firstWindowStart + off), rms });
        if (rms >= SILENCE_RMS) {
            s.voicedMsInSegment += WINDOW_MS;
            s.silenceRunMs = 0;
        } else {
            s.silenceRunMs += WINDOW_MS;
        }
    }
    s.windowCarry = data.subarray(fullWindows * windowSamples).slice();

    const openMs = (s.openSamples / s.sampleRate) * 1000;
    const pauseClose = s.silenceRunMs >= SILENCE_CLOSE_MS && s.voicedMsInSegment >= MIN_VOICED_MS;
    if (pauseClose || openMs >= MAX_SEGMENT_MS) {
        closeOpenSegment(s);
        return;
    }

    // Soft cap for no-pause talkers: split at the QUIETEST window of the recent
    // lookback so the cut lands between words, not through one (the remainder
    // stays in the open segment). Bounds the tail size → bounds stop latency.
    if (openMs >= SOFT_CAP_MS && s.voicedMsInSegment >= MIN_VOICED_MS) {
        const lookbackStart = s.openSamples - Math.round((SOFT_CAP_LOOKBACK_MS / 1000) * s.sampleRate);
        let quietest: RmsWindow | null = null;
        for (const w of s.rmsHistory) {
            if (w.startSample < lookbackStart) continue;
            // <= prefers the LATEST minimum, keeping the carried-over tail small
            if (!quietest || w.rms <= quietest.rms) quietest = w;
        }
        if (quietest && quietest.startSample > 0) {
            closeOpenSegment(s, quietest.startSample);
        }
    }
}

/**
 * Close the open segment and queue its transcription. With `splitAt`, only
 * [0, splitAt) closes and the remainder stays as the new open segment.
 */
function closeOpenSegment(s: Session, splitAt?: number): void {
    if (s.openSamples === 0) return;
    const all = new Float32Array(s.openSamples);
    let off = 0;
    for (const c of s.chunks) { all.set(c, off); off += c.length; }

    const cut = splitAt !== undefined ? Math.min(splitAt, s.openSamples) : s.openSamples;
    const raw = all.subarray(0, cut).slice();
    const remainder = cut < s.openSamples ? all.subarray(cut).slice() : null;
    const hadVoice = s.voicedMsInSegment >= MIN_VOICED_MS;

    // Reset open-segment state to the remainder (empty when no split).
    s.chunks = remainder ? [remainder] : [];
    s.openSamples = remainder ? remainder.length : 0;
    s.silenceRunMs = 0;
    if (remainder) {
        // Rebase RMS history onto the remainder and recompute its voiced time.
        const rebased: RmsWindow[] = [];
        let voicedMs = 0;
        for (const w of s.rmsHistory) {
            if (w.startSample >= cut) {
                rebased.push({ startSample: w.startSample - cut, rms: w.rms });
                if (w.rms >= SILENCE_RMS) voicedMs += WINDOW_MS;
            }
        }
        s.rmsHistory = rebased;
        s.voicedMsInSegment = voicedMs;
    } else {
        s.rmsHistory = [];
        s.voicedMsInSegment = 0;
    }

    if (!hadVoice) return; // pure silence — nothing to transcribe

    const index = s.segmentsQueued++;
    const sampleRate = s.sampleRate;
    s.queue = s.queue.then(async () => {
        if (!transcriberFn || !s.healthy) return;
        try {
            const t0 = Date.now();
            const audio16k = resampleCubic(raw, sampleRate, 16000);
            const text = (await transcriberFn(audio16k)).trim();
            s.texts[index] = text;
            const secs = (audio16k.length / 16000).toFixed(1);
            console.log(`[Stream] Segment ${index + 1} (${secs}s) done in ${Date.now() - t0}ms: "${text.substring(0, 60)}"`);
            if (text && partialListener) {
                partialListener(joinedText(s), index);
            }
        } catch (e) {
            console.error(`[Stream] Segment ${index + 1} failed — session falls back to batch:`, e);
            s.healthy = false;
        }
    });
}

function joinedText(s: Session): string {
    return s.texts.filter(t => !!t).join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Finish the session: close the tail segment, drain the queue, and return the
 * joined transcript. `healthy: false` means the caller MUST re-transcribe the
 * full recording via the batch path.
 */
export async function finalizeSession(): Promise<{ healthy: boolean; text: string; segments: number }> {
    const s = session;
    if (!s || s.finalized) return { healthy: false, text: '', segments: 0 };
    s.finalized = true;

    // Tail: transcribe whatever remains if it plausibly contains speech.
    const tailMs = (s.openSamples / s.sampleRate) * 1000;
    if (tailMs >= MIN_TAIL_MS && s.voicedMsInSegment > 0) {
        // Relax the min-voiced rule for the tail — it's the end of the utterance.
        s.voicedMsInSegment = Math.max(s.voicedMsInSegment, MIN_VOICED_MS);
        closeOpenSegment(s);
    }

    await s.queue;
    const result = { healthy: s.healthy, text: joinedText(s), segments: s.segmentsQueued };
    session = null;
    return result;
}
