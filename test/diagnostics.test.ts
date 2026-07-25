/**
 * diagnostics — the counters must be correct, and must never leak content.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { diag, summary, __resetForTest } from '../electron/diagnostics';

beforeEach(() => __resetForTest());

describe('diagnostics', () => {
    it('reports nothing before anything happens', () => {
        const s = summary();
        expect(s.sessions).toBe(0);
        expect(s.stopToTextMs).toEqual({ p50: 0, p90: 0, p99: 0, n: 0 });
    });

    it('counts seams as the gaps BETWEEN segments, not the segments', () => {
        // Two sessions of 3 segments each = 2 seams each = 4 seams total.
        for (let i = 0; i < 2; i++) {
            diag.sessionStarted();
            diag.segmentClosed(false);
            diag.segmentClosed(false);
            diag.segmentClosed(false);
        }
        diag.seamRepaired();
        diag.seamRepaired();
        const s = summary();
        expect(s.segments).toBe(6);
        expect(s.segmentsPerSession).toBe(3);
        expect(s.seamRepairRate).toBe(0.5); // 2 repairs / 4 seams
    });

    it('tracks forced splits separately from ordinary closes', () => {
        diag.sessionStarted();
        diag.segmentClosed(true);
        diag.segmentClosed(false);
        const s = summary();
        expect(s.segments).toBe(2);
        expect(s.forcedSplits).toBe(1);
    });

    it('computes latency percentiles, not just an average', () => {
        diag.sessionStarted();
        // 1..100 ms — an average would hide the tail; percentiles must not.
        for (let i = 1; i <= 100; i++) diag.stopToText(i);
        const s = summary();
        expect(s.stopToTextMs.n).toBe(100);
        expect(s.stopToTextMs.p50).toBe(50);
        expect(s.stopToTextMs.p90).toBe(90);
        expect(s.stopToTextMs.p99).toBe(99);
    });

    it('reports the streaming fallback rate per session', () => {
        diag.sessionStarted();
        diag.sessionStarted();
        diag.sessionStarted();
        diag.sessionStarted();
        diag.streamingFellBack();
        expect(summary().streamingFallbackRate).toBe(0.25);
    });

    it('bounds memory in a long-lived process', () => {
        diag.sessionStarted();
        for (let i = 0; i < 5000; i++) diag.segmentDecode(i);
        const s = summary();
        expect(s.segmentDecodeMs.n).toBe(5000);   // total still counted
        expect(s.segmentDecodeMs.p99).toBeGreaterThan(0); // samples retained
    });

    it('exposes only numbers — never transcript text', () => {
        diag.sessionStarted();
        diag.segmentClosed(false);
        diag.seamRepaired();
        diag.stopToText(123);
        for (const v of Object.values(summary())) {
            if (typeof v === 'object' && v !== null) {
                for (const n of Object.values(v)) expect(typeof n).toBe('number');
            } else {
                expect(typeof v).toBe('number');
            }
        }
    });
});
