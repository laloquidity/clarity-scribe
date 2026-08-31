/**
 * decodeHealth — would we have caught the reported failure?
 *
 * The headline case uses the exact numbers from the user's log after ~24h of
 * uptime, where 3.8s of a 6.8s segment produced no tokens and the user was
 * handed "So that way we can get".
 */
import { describe, it, expect } from 'vitest';
import {
    assessDecode, preferBetterDecode, shouldRefreshSessions, SESSION_MAX_AGE_MS, DecodeStats,
    peakWindowRms, nextRebuildAllowedAt, REBUILD_MIN_SPACING_MS, REBUILD_UNHELPFUL_BACKOFF_MS,
} from '../electron/decodeHealth';

const stats = (o: Partial<DecodeStats>): DecodeStats =>
    ({ lastTokenFrame: 80, totalFrames: 85, collapseRecoveries: 0, blankRatio: 0.3, ...o });

describe('assessDecode — the reported failure', () => {
    it('flags the exact decode from the log', () => {
        // "6 tokens from 85 frames | blanks 36/42 (85.7%) | lastToken frame 38 | recoveries: 1"
        const v = assessDecode(stats({
            lastTokenFrame: 38, totalFrames: 85, collapseRecoveries: 1, blankRatio: 0.857,
        }));
        expect(v.degraded).toBe(true);
        expect(v.reason).toMatch(/collapsed/);
        expect(v.reason).toMatch(/never recovered/);
    });

    it('flags a collapse that never resumed even with a modest tail', () => {
        expect(assessDecode(stats({ lastTokenFrame: 60, totalFrames: 85, collapseRecoveries: 1 })).degraded).toBe(true);
    });

    it('does NOT flag a large dead tail on its own — that is ordinary silence', () => {
        // Regression: this fired on a real dictation ending "Thank you." —
        // 0.5s of speech then 1.9s of genuine trailing silence (80% tail) —
        // and cost 3.1s rebuilding sessions to produce the same correct text.
        expect(assessDecode({
            lastTokenFrame: 6, totalFrames: 30, collapseRecoveries: 0, blankRatio: 0.692,
        }).degraded).toBe(false);
        expect(assessDecode(stats({ lastTokenFrame: 30, totalFrames: 85 })).degraded).toBe(false);
    });

    it('flags near-total blanks when the tokens also died out early', () => {
        expect(assessDecode(stats({ blankRatio: 0.95, lastTokenFrame: 40 })).degraded).toBe(true);
    });

    it('does NOT flag near-total blanks when tokens reach the end — that is sparse speech', () => {
        // Regression (2026-08-31 logs): "But the priority here." — 7 tokens in
        // 4.3s, 82% blank, last token at frame 52/54 — a CORRECT transcript
        // that paid two ~5s session rebuilds under the old ratio-only rule.
        expect(assessDecode({
            lastTokenFrame: 52, totalFrames: 54, collapseRecoveries: 1, blankRatio: 0.82,
        }).degraded).toBe(false);
        // The old shape of this test: 95% blank but full coverage.
        expect(assessDecode(stats({ blankRatio: 0.95 })).degraded).toBe(false);
    });
});

describe('assessDecode — quiet audio is not degradation', () => {
    // 2026-08-31 logs: live previews of open segments that held only a breath
    // or a lead-in pause decoded to zero tokens, tripped the collapse/blank
    // rules, and triggered ~10 mid-recording rebuilds — none of which changed
    // the result. Zero tokens from quiet audio is the decoder being RIGHT.
    const silentCollapse: DecodeStats = {
        lastTokenFrame: 0, totalFrames: 37, collapseRecoveries: 1, blankRatio: 1,
    };

    it('passes an all-blank decode when the audio never got loud enough for speech', () => {
        expect(assessDecode({ ...silentCollapse, audioPeakRms: 0.002 }).degraded).toBe(false);
    });

    it('still flags the same decode when the audio was clearly voiced', () => {
        expect(assessDecode({ ...silentCollapse, audioPeakRms: 0.1 }).degraded).toBe(true);
    });

    it('behaves as before when the caller has no audio energy to offer', () => {
        expect(assessDecode(silentCollapse).degraded).toBe(true);
    });
});

describe('peakWindowRms', () => {
    it('is zero for silence', () => {
        expect(peakWindowRms(new Float32Array(4096))).toBe(0);
    });

    it('finds a loud window even when the rest of the buffer is silent', () => {
        const audio = new Float32Array(4096);
        audio.fill(0.5, 1024, 1024 + 512); // one fully loud 512-sample window
        expect(peakWindowRms(audio)).toBeCloseTo(0.5, 5);
    });

    it('handles a buffer shorter than one window', () => {
        const audio = new Float32Array(100).fill(0.25);
        expect(peakWindowRms(audio)).toBeCloseTo(0.25, 5);
    });

    it('handles an empty buffer', () => {
        expect(peakWindowRms(new Float32Array(0))).toBe(0);
    });
});

describe('assessDecode — must not cry wolf', () => {
    it('passes a healthy decode', () => {
        expect(assessDecode(stats({ lastTokenFrame: 82, totalFrames: 85, blankRatio: 0.25 })).degraded).toBe(false);
    });

    it('passes the real golden decode (43 tokens, 92 frames, last token frame 90)', () => {
        // From the shipping fixture: blanks 13/56, lastToken frame 90 of 92.
        expect(assessDecode({
            lastTokenFrame: 90, totalFrames: 92, collapseRecoveries: 0, blankRatio: 13 / 56,
        }).degraded).toBe(false);
    });

    it('tolerates a normal short trailing pause', () => {
        // ~12% dead tail with no collapse — ordinary end-of-utterance.
        expect(assessDecode(stats({ lastTokenFrame: 75, totalFrames: 85 })).degraded).toBe(false);
    });

    it('ignores segments too short for the ratios to mean anything', () => {
        // A 1.5s blip: ratios are noise at this size, so never retry on it.
        expect(assessDecode({
            lastTokenFrame: 2, totalFrames: 18, collapseRecoveries: 1, blankRatio: 0.9,
        }).degraded).toBe(false);
    });

    it('handles a degenerate empty decode without dividing by zero', () => {
        expect(assessDecode({ lastTokenFrame: 0, totalFrames: 0, collapseRecoveries: 0, blankRatio: 0 }).degraded).toBe(false);
    });
});

describe('shouldRefreshSessions — prevention beats recovery', () => {
    const HOUR = 3_600_000;
    const now = 1_000_000_000;

    it('refreshes once the sessions are older than the threshold', () => {
        expect(shouldRefreshSessions({ builtAt: now - 5 * HOUR, now, inFlight: 0 })).toBe(true);
    });

    it('leaves young sessions alone', () => {
        expect(shouldRefreshSessions({ builtAt: now - 1 * HOUR, now, inFlight: 0 })).toBe(false);
    });

    it('NEVER rebuilds while a transcription is using the sessions', () => {
        // Swapping sessions mid-decode is the one thing that would make this
        // feature worse than the bug it prevents.
        expect(shouldRefreshSessions({ builtAt: now - 100 * HOUR, now, inFlight: 1 })).toBe(false);
    });

    it('does nothing before sessions exist', () => {
        expect(shouldRefreshSessions({ builtAt: 0, now, inFlight: 0 })).toBe(false);
    });

    it('would have fired long before the reported 24h failure', () => {
        expect(shouldRefreshSessions({ builtAt: now - 24 * HOUR, now, inFlight: 0 })).toBe(true);
        expect(SESSION_MAX_AGE_MS).toBeLessThan(24 * HOUR);
    });
});

describe('preferBetterDecode', () => {
    const d = (lastTokenFrame: number, text: string) =>
        ({ lastTokenFrame, totalFrames: 85, collapseRecoveries: 0, blankRatio: 0.3, text });

    it('takes the retry when it reaches further into the audio', () => {
        expect(preferBetterDecode(d(38, 'So that way we can get'), d(82, 'So that way we can get the whole sentence back')).lastTokenFrame).toBe(82);
    });

    it('keeps the original when the retry is no better', () => {
        expect(preferBetterDecode(d(82, 'good text'), d(40, 'worse')).text).toBe('good text');
    });

    it('breaks a tie on more text', () => {
        expect(preferBetterDecode(d(80, 'short'), d(80, 'a longer transcript')).text).toBe('a longer transcript');
    });

    it('never churns when the two are identical', () => {
        const a = d(80, 'same');
        expect(preferBetterDecode(a, d(80, 'same'))).toBe(a);
    });
});

describe('nextRebuildAllowedAt — rebuilds must earn their keep', () => {
    const now = 1_000_000_000;

    it('spaces out rebuilds even when the retry helped', () => {
        expect(nextRebuildAllowedAt(now, true)).toBe(now + REBUILD_MIN_SPACING_MS);
    });

    it('backs off much harder after a rebuild whose retry changed nothing', () => {
        // An identical retry proves the decode deterministic — session state
        // was not the problem, so rebuilding again soon is pure cost.
        expect(nextRebuildAllowedAt(now, false)).toBe(now + REBUILD_UNHELPFUL_BACKOFF_MS);
        expect(REBUILD_UNHELPFUL_BACKOFF_MS).toBeGreaterThan(REBUILD_MIN_SPACING_MS);
    });
});
