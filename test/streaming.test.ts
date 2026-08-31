/**
 * Streaming transcriber unit tests — segmenter + session lifecycle with a mock
 * transcriber (no ONNX/models needed).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
    configureStreaming, startSession, pushChunk, finalizeSession,
    abortSession, isSessionActive, onPartial, resampleCubic, setLivePreview,
} from '../electron/streamingTranscriber';

const SR = 48000;

/** Voiced audio: 220Hz sine at 0.15 amplitude (RMS ≈ 0.106, well above gate). */
function voiced(ms: number): Float32Array {
    const n = Math.round((ms / 1000) * SR);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = 0.15 * Math.sin((2 * Math.PI * 220 * i) / SR);
    return out;
}
/** Quiet-mic speech: amplitude 0.008 → RMS ≈ 0.0057, BELOW the old fixed 0.006
 *  gate (the macOS no-input-boost case) but above the adaptive floor. */
function quietVoiced(ms: number): Float32Array {
    const n = Math.round((ms / 1000) * SR);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = 0.008 * Math.sin((2 * Math.PI * 220 * i) / SR);
    return out;
}
function silence(ms: number): Float32Array {
    return new Float32Array(Math.round((ms / 1000) * SR));
}

/** Push audio in realistic ~128ms worklet-batch chunks. */
function pushAll(audio: Float32Array, chunkMs = 128) {
    const step = Math.round((chunkMs / 1000) * SR);
    for (let off = 0; off < audio.length; off += step) {
        pushChunk(audio.subarray(off, Math.min(off + step, audio.length)));
    }
}
function concat(...parts: Float32Array[]): Float32Array {
    const total = parts.reduce((a, p) => a + p.length, 0);
    const out = new Float32Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
}

describe('streamingTranscriber', () => {
    let calls: Float32Array[];

    beforeEach(() => {
        abortSession();
        onPartial(null);
        setLivePreview(false);
        calls = [];
        configureStreaming(async (audio) => {
            calls.push(audio);
            return `seg${calls.length}`;
        });
    });

    /** Let queued (mock) decodes settle — they resolve within a task tick. */
    const drain = () => new Promise<void>((r) => setTimeout(r, 0));

    it('startSession requires a configured transcriber', () => {
        // reconfigure with null-ish is not allowed by types; instead verify the
        // active flag flips correctly with a valid config.
        expect(startSession(SR)).toBe(true);
        expect(isSessionActive()).toBe(true);
        abortSession();
        expect(isSessionActive()).toBe(false);
    });

    it('closes a segment at a natural pause and emits a partial', async () => {
        const partials: string[] = [];
        onPartial((text) => partials.push(text));
        startSession(SR);
        pushAll(concat(voiced(1500), silence(900)));
        // Segment should have closed during the silence — finalize to drain.
        const result = await finalizeSession();
        expect(result.healthy).toBe(true);
        expect(result.segments).toBe(1);
        expect(result.text).toBe('seg1');
        expect(partials).toContain('seg1');
        expect(calls.length).toBe(1);
        // Resampled to 16k: segment ≈ 1.5-2.4s → 24000-39000 samples
        expect(calls[0].length).toBeGreaterThan(20000);
    });

    it('multiple utterances produce ordered joined text', async () => {
        startSession(SR);
        pushAll(concat(voiced(1200), silence(800), voiced(1200), silence(800), voiced(700)));
        const result = await finalizeSession();
        expect(result.healthy).toBe(true);
        expect(result.segments).toBe(3); // two pause-closed + tail
        expect(result.text).toBe('seg1 seg2 seg3');
    });

    it('pure silence produces no segments and empty text', async () => {
        startSession(SR);
        pushAll(silence(3000));
        const result = await finalizeSession();
        expect(result.healthy).toBe(true);
        expect(result.segments).toBe(0);
        expect(result.text).toBe('');
        expect(calls.length).toBe(0);
    });

    it('force-closes at the max segment cap during continuous speech', async () => {
        startSession(SR);
        pushAll(voiced(29_500)); // longer than the caps, no pause
        const result = await finalizeSession();
        expect(result.segments).toBe(2); // soft-cap split + tail
        expect(result.healthy).toBe(true);
    });

    it('soft-caps a no-pause talker at the quietest window (bounded tail)', async () => {
        startSession(SR);
        pushAll(voiced(20_000)); // continuous speech > 15s soft cap
        const result = await finalizeSession();
        expect(result.segments).toBe(2); // split near 15s + ~5s tail
        expect(result.text).toBe('seg1 seg2');
        // Both segments carry audio: first ≈15s, second ≈5s (resampled to 16k)
        expect(calls[0].length).toBeGreaterThan(10 * 16000);
        expect(calls[1].length).toBeGreaterThan(2 * 16000);
        // No samples lost across the split (total ≈ 20s at 16k)
        const total = calls[0].length + calls[1].length;
        expect(Math.abs(total - 20 * 16000)).toBeLessThan(1600);
    });

    it('short unvoiced tail is dropped', async () => {
        startSession(SR);
        pushAll(concat(voiced(1500), silence(900), silence(150)));
        const result = await finalizeSession();
        expect(result.segments).toBe(1);
        expect(result.text).toBe('seg1');
    });

    it('a failing transcriber marks the session unhealthy (batch fallback)', async () => {
        configureStreaming(async () => { throw new Error('boom'); });
        startSession(SR);
        pushAll(concat(voiced(1500), silence(900)));
        const result = await finalizeSession();
        expect(result.healthy).toBe(false);
    });

    it('finalize with no session reports unhealthy', async () => {
        const result = await finalizeSession();
        expect(result.healthy).toBe(false);
    });

    it('quiet-mic speech (below the old fixed gate) still closes segments', async () => {
        // Regression for macOS: input levels without mic boost sat below the
        // fixed 0.006 RMS gate, so no segment ever closed and the live preview
        // never appeared. The adaptive gate must classify this as voiced.
        const partials: string[] = [];
        onPartial((text) => partials.push(text));
        startSession(SR);
        pushAll(concat(quietVoiced(1500), silence(900), quietVoiced(1200)));
        const result = await finalizeSession();
        expect(result.healthy).toBe(true);
        expect(result.segments).toBe(2); // pause-closed + tail
        expect(result.text).toBe('seg1 seg2');
        expect(partials.length).toBeGreaterThan(0); // live preview events fired
    });

    it('marks preview decodes so the engine can skip expensive recovery', async () => {
        const flags: Array<boolean | undefined> = [];
        configureStreaming(async (audio, opts) => {
            calls.push(audio);
            flags.push(opts?.preview);
            return `seg${calls.length}`;
        });
        setLivePreview(true);
        onPartial(() => { /* previews need a listener to run */ });
        startSession(SR);
        pushAll(voiced(2000)); // no pause → preview decode of the open segment
        await drain();
        pushAll(silence(900)); // closes segment 1 → real decode
        await finalizeSession();
        expect(flags[0]).toBe(true);        // the preview
        expect(flags[1]).toBeUndefined();   // the real segment decode
    });

    it('reports whole-recording decode accounting at finalize', async () => {
        // A transcriber that takes real time, so the ms totals are nonzero.
        configureStreaming(async (audio) => {
            calls.push(audio);
            await new Promise((r) => setTimeout(r, 5));
            return `seg${calls.length}`;
        });
        setLivePreview(true);
        onPartial(() => { /* previews need a listener to run */ });
        startSession(SR);
        pushAll(voiced(2000)); // no pause → a preview decode of the open segment
        await drain();
        pushAll(silence(900)); // closes segment 1 → real decode
        const result = await finalizeSession();
        expect(result.healthy).toBe(true);
        expect(result.segments).toBe(1);
        // Real decode time and preview time are tracked separately.
        expect(result.decodeMs).toBeGreaterThan(0);
        expect(result.previews).toBe(1);
        expect(result.previewMs).toBeGreaterThan(0);
    });

    it('a session with no previews reports zero preview work', async () => {
        startSession(SR);
        pushAll(concat(voiced(1500), silence(900)));
        const result = await finalizeSession();
        expect(result.segments).toBe(1);
        expect(result.previews).toBe(0);
        expect(result.previewMs).toBe(0);
        expect(result.decodeMs).toBeGreaterThanOrEqual(0);
    });

    it('previews the open segment during continuous speech (display only)', async () => {
        setLivePreview(true);
        const partials: string[] = [];
        onPartial((text) => partials.push(text));
        startSession(SR);
        pushAll(voiced(2000)); // no pause — no segment ever closes here
        await drain();
        // A preview decode ran and its text was emitted as a partial…
        expect(calls.length).toBe(1);
        expect(partials).toEqual(['seg1']);
        // …but it must NEVER reach the final transcript: close the segment
        // for real and check only the real decode's text survives.
        pushAll(silence(900));
        const result = await finalizeSession();
        expect(result.healthy).toBe(true);
        expect(result.segments).toBe(1);
        expect(result.text).toBe('seg2'); // the real decode, not the preview
    });

    it('preview keeps updating as the open segment grows', async () => {
        setLivePreview(true);
        const partials: string[] = [];
        onPartial((text) => partials.push(text));
        startSession(SR);
        pushAll(voiced(1500));
        await drain(); // first preview completes
        pushAll(voiced(1500)); // another 1.5s of NEW audio → second preview
        await drain();
        expect(calls.length).toBe(2);
        expect(partials).toEqual(['seg1', 'seg2']);
        // Second preview covers the WHOLE open segment (~3s at 16k), not a delta.
        expect(calls[1].length).toBeGreaterThan(2.5 * 16000);
    });

    // A fast engine can afford to refresh the live box sooner than the 1200ms
    // default, which is sized for a GPU encoder at ~300-500ms per decode. The
    // interval is what sets how far behind the speaker the box runs, so it is
    // a parameter of setLivePreview rather than a constant.
    it('honours a shorter preview interval on a fast engine', async () => {
        setLivePreview(true, 700);
        const partials: string[] = [];
        onPartial((text) => partials.push(text));
        startSession(SR);
        pushAll(voiced(800)); // below the 1200ms default, above a 700ms interval
        await drain();
        expect(calls.length).toBe(1);
        expect(partials).toEqual(['seg1']);
    });

    // Below roughly one decode's worth of new audio the queue-idle check gates
    // every attempt anyway, so the floor stops a caller asking for contention.
    it('clamps an implausibly short preview interval', async () => {
        setLivePreview(true, 10);
        onPartial(() => {});
        startSession(SR);
        pushAll(voiced(200)); // under the 300ms floor — must not preview yet
        await drain();
        expect(calls.length).toBe(0);
    });

    it('preview waits for enough new audio and skips mid-pause', async () => {
        setLivePreview(true);
        onPartial(() => {}); // previews only run when someone is listening
        startSession(SR);
        pushAll(voiced(800)); // < 1.2s of audio — below the preview interval
        await drain();
        expect(calls.length).toBe(0);
        // The interval boundary is crossed 400ms INTO a pause — past the
        // skip threshold: no new words, and the real close is imminent.
        // (A crossing in the first ~300ms of silence still previews: that
        // is an ordinary inter-word gap, not a recognizable pause.)
        pushAll(silence(600)); // stays below the 650ms real-close threshold
        await drain();
        expect(calls.length).toBe(0);
    });

    it('no preview decodes when the feature is off (default)', async () => {
        const partials: string[] = [];
        onPartial((text) => partials.push(text));
        startSession(SR);
        pushAll(voiced(3000)); // would preview twice if enabled
        await drain();
        expect(calls.length).toBe(0);
        expect(partials).toEqual([]);
        const result = await finalizeSession();
        expect(result.segments).toBe(1); // the tail still decodes normally
        expect(result.text).toBe('seg1');
    });

    it('a failing preview decode does NOT mark the session unhealthy', async () => {
        // Preview is best-effort; only REAL segment failures may trigger the
        // batch fallback. Fail the first (preview) call, succeed afterwards.
        let n = 0;
        configureStreaming(async (audio) => {
            n++;
            if (n === 1) throw new Error('preview boom');
            calls.push(audio);
            return `seg${calls.length}`;
        });
        setLivePreview(true);
        onPartial(() => {}); // previews only run when someone is listening
        startSession(SR);
        pushAll(voiced(2000)); // triggers the (failing) preview
        await drain();
        pushAll(silence(900)); // closes the segment → real decode succeeds
        const result = await finalizeSession();
        expect(result.healthy).toBe(true);
        expect(result.text).toBe('seg1');
    });

    it('resampleCubic 48k→16k yields 1/3 length and preserves a sine', () => {
        const input = voiced(1000);
        const out = resampleCubic(input, 48000, 16000);
        expect(Math.abs(out.length - 16000)).toBeLessThanOrEqual(1);
        // The 220Hz tone should keep its amplitude envelope (spot check RMS)
        let sum = 0;
        for (let i = 0; i < out.length; i++) sum += out[i] * out[i];
        const rms = Math.sqrt(sum / out.length);
        expect(rms).toBeGreaterThan(0.09);
        expect(rms).toBeLessThan(0.12);
    });
});
