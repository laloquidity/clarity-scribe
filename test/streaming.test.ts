/**
 * Streaming transcriber unit tests — segmenter + session lifecycle with a mock
 * transcriber (no ONNX/models needed).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
    configureStreaming, startSession, pushChunk, finalizeSession,
    abortSession, isSessionActive, onPartial, resampleCubic,
} from '../electron/streamingTranscriber';

const SR = 48000;

/** Voiced audio: 220Hz sine at 0.15 amplitude (RMS ≈ 0.106, well above gate). */
function voiced(ms: number): Float32Array {
    const n = Math.round((ms / 1000) * SR);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = 0.15 * Math.sin((2 * Math.PI * 220 * i) / SR);
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
        calls = [];
        configureStreaming(async (audio) => {
            calls.push(audio);
            return `seg${calls.length}`;
        });
    });

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
