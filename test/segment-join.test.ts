/**
 * segmentJoin — sentence-boundary repair across segment seams.
 *
 * The bug: both paths transcribe pause-separated segments in isolation, so
 * Parakeet capitalizes each one's first word as if it began an utterance, and
 * a bare space-join preserves the mistake ("...to the store And bought milk").
 *
 * The guiding rule under test is NEVER MAKE IT WORSE: a wrongly-lowercased
 * name is a worse bug than the one being fixed, so the "leaves alone" cases
 * below matter at least as much as the repairs.
 */
import { describe, it, expect } from 'vitest';
import { joinSegments } from '../electron/segmentJoin';

describe('joinSegments — repairs the reported bug', () => {
    it('lowercases a continuation word after an unfinished segment', () => {
        expect(joinSegments(['I went to the store', 'And bought some milk']))
            .toBe('I went to the store and bought some milk');
    });

    it('handles the common continuation words', () => {
        for (const [w, fixed] of [['And', 'and'], ['But', 'but'], ['Or', 'or'], ['With', 'with'], ['To', 'to'], ['Of', 'of'], ['Which', 'which'], ['Than', 'than']]) {
            expect(joinSegments([`the thing`, `${w} more words`])).toBe(`the thing ${fixed} more words`);
        }
    });

    it('repairs across several seams', () => {
        expect(joinSegments(['I called the bank', 'And asked about the fee', 'But they had no idea']))
            .toBe('I called the bank and asked about the fee but they had no idea');
    });

    it('strips the bogus period too when WE cut mid-speech', () => {
        // A length-cap split invents both the period and the capital.
        expect(joinSegments([
            { text: 'I was explaining the whole thing.', forcedSplit: true },
            { text: 'And then it crashed' },
        ])).toBe('I was explaining the whole thing and then it crashed');
    });
});

describe('joinSegments — must NOT make things worse', () => {
    it('leaves a genuine sentence break alone', () => {
        expect(joinSegments(['I went to the store.', 'And then I left.']))
            .toBe('I went to the store. And then I left.');
        expect(joinSegments(['Are you coming?', 'But not right now.']))
            .toBe('Are you coming? But not right now.');
    });

    it('never lowercases a name or ordinary noun', () => {
        expect(joinSegments(['I spoke to', 'David about the report']))
            .toBe('I spoke to David about the report');
        expect(joinSegments(['we flew to', 'Paris last week']))
            .toBe('we flew to Paris last week');
    });

    it('never lowercases "I" or acronyms', () => {
        expect(joinSegments(['he said', 'I should go'])).toBe('he said I should go');
        expect(joinSegments(['it uses', 'API keys'])).toBe('it uses API keys');
        expect(joinSegments(['based in', 'US offices'])).toBe('based in US offices');
    });

    it('leaves words that legitimately open sentences alone', () => {
        // Deliberately excluded from the closed set — too risky to touch.
        for (const w of ['If', 'When', 'After', 'Before', 'Since', 'While', 'The', 'This', 'That', 'Then', 'Because']) {
            expect(joinSegments(['some text', `${w} something`])).toBe(`some text ${w} something`);
        }
    });

    it('leaves an already-lowercase continuation untouched', () => {
        expect(joinSegments(['I went to the store', 'and bought milk']))
            .toBe('I went to the store and bought milk');
    });
});

describe('joinSegments — structural behaviour', () => {
    it('is identity for a single segment (the common case)', () => {
        expect(joinSegments(['And so it begins.'])).toBe('And so it begins.');
        expect(joinSegments([{ text: 'And so it begins.', forcedSplit: true }])).toBe('And so it begins.');
    });

    it('drops empty segments and normalizes whitespace', () => {
        expect(joinSegments(['hello', '', '   ', 'world'])).toBe('hello world');
        expect(joinSegments(['  spaced   out  ', 'text'])).toBe('spaced out text');
        expect(joinSegments([])).toBe('');
        expect(joinSegments(['', ''])).toBe('');
    });

    it('accepts plain strings and JoinParts interchangeably', () => {
        expect(joinSegments(['a thing', { text: 'And another' }])).toBe('a thing and another');
    });

    it('handles segments ending in quotes or brackets', () => {
        expect(joinSegments(['he said "no thanks."', 'And left'])).toBe('he said "no thanks." And left');
    });
});

describe('joinSegments — restarted phrases at a pause seam', () => {
    // The speaker abandoned an attempt and said it again. Both attempts get
    // transcribed because each segment is decoded in isolation.
    it('drops a repeated phrase when a pause closed the seam', () => {
        expect(joinSegments(['Would you.', 'Would you like a cappuccino?']))
            .toBe('Would you like a cappuccino?');
        expect(joinSegments(['I think we should.', 'We should ship it.']))
            .toBe('I think we should ship it.');
    });

    it('removes the longest overlap, not a fragment of it', () => {
        expect(joinSegments(['Can you send me the.', 'Send me the report please.']))
            .toBe('Can you send me the report please.');
    });

    it('keeps the restart capitalized when it becomes the whole transcript', () => {
        expect(joinSegments(['Would you.', 'Would you mind?'])).toBe('Would you mind?');
    });

    // A forced cut is our own knife landing mid-speech; a repeat across it is
    // not evidence of anything, and trimming would delete real words.
    it('never trims across a forced (length-cap) split', () => {
        expect(joinSegments([{ text: 'we should', forcedSplit: true }, 'we should go']))
            .toBe('we should we should go');
    });

    // Single-word overlap at a pause is usually real speech, not disfluency.
    it('leaves a single repeated word alone', () => {
        expect(joinSegments(['I said no.', 'No, I did not.'])).toBe('I said no. No, I did not.');
        expect(joinSegments(['That is the store.', 'Store was closed.']))
            .toBe('That is the store. Store was closed.');
    });

    it('does not trim unrelated segments', () => {
        expect(joinSegments(['Would you like coffee?', 'Would you like tea?']))
            .toBe('Would you like coffee? Would you like tea?');
        expect(joinSegments(['I went to the store.', 'It was closed.']))
            .toBe('I went to the store. It was closed.');
    });

    it('reports each trim for diagnostics', () => {
        let trims = 0;
        joinSegments(['Would you.', 'Would you like tea?'], undefined, () => { trims++; });
        expect(trims).toBe(1);
        trims = 0;
        joinSegments(['I went to the store.', 'It was closed.'], undefined, () => { trims++; });
        expect(trims).toBe(0);
    });
});
