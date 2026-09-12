/**
 * The engines' transcript logging gate.
 *
 * Uploaded recordings are other people's conversations, so the file endpoint
 * asks the engines not to log their words. This guards that the gate withholds
 * text completely — not a shorter excerpt, not the first word — while leaving
 * the owner's own dictation logs exactly as they were.
 */
import { describe, it, expect } from 'vitest';
import { transcriptExcerpt } from '../electron/transcriptLog';

describe('transcriptExcerpt', () => {
    const words = 'the confidential budget for the renewal is four million dollars and change';

    it('withholds every word when logging is turned off', () => {
        const line = transcriptExcerpt(words, false);
        for (const w of words.split(' ')) {
            if (w.length > 3) expect(line).not.toContain(w);
        }
        expect(line).toBe(`[${words.length} chars, text withheld]`);
    });

    it('keeps the original 80-character excerpt for dictation', () => {
        expect(transcriptExcerpt(words, undefined)).toBe(`"${words.substring(0, 80)}"`);
        expect(transcriptExcerpt(words, true)).toBe(`"${words.substring(0, 80)}"`);
    });

    it('handles an empty or missing transcript either way', () => {
        expect(transcriptExcerpt('', false)).toBe('[0 chars, text withheld]');
        expect(transcriptExcerpt(null, false)).toBe('[0 chars, text withheld]');
        expect(transcriptExcerpt(undefined, true)).toBe('""');
    });
});
