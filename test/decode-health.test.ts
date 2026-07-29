/**
 * decodeHealth — would we have caught the reported failure?
 *
 * The headline case uses the exact numbers from the user's log after ~24h of
 * uptime, where 3.8s of a 6.8s segment produced no tokens and the user was
 * handed "So that way we can get".
 */
import { describe, it, expect } from 'vitest';
import { assessDecode, preferBetterDecode, DecodeStats } from '../electron/decodeHealth';

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

    it('flags a large dead tail even with no collapse logged', () => {
        expect(assessDecode(stats({ lastTokenFrame: 30, totalFrames: 85 })).degraded).toBe(true);
    });

    it('flags near-total blanks', () => {
        expect(assessDecode(stats({ blankRatio: 0.95 })).degraded).toBe(true);
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
