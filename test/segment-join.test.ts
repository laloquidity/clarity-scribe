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

    it('lowercases any function word at a FORCED seam, not only the narrow list', () => {
        // Real dictation 2026-09-01: the 15s soft cap cut "…Did you know
        // that | In 1974, there was an act…" and "In" stayed capitalized.
        expect(joinSegments([
            { text: 'Did you know that', forcedSplit: true },
            { text: 'In nineteen seventy four there was an act' },
        ])).toBe('Did you know that in nineteen seventy four there was an act');
        expect(joinSegments([
            { text: 'we need to make sure', forcedSplit: true },
            { text: 'The file is preserved' },
        ])).toBe('we need to make sure the file is preserved');
    });

    it('applies the wide list after an UNFINISHED left segment too', () => {
        // Real dictation 2026-09-01: "…adapt those as well. Like | What should
        // the cap be…" — the left had no terminal punctuation, so the sentence
        // was certainly in flight.
        expect(joinSegments(['we can adapt those as well. Like', 'What should the cap be on each of those']))
            .toBe('we can adapt those as well. Like what should the cap be on each of those');
    });

    it('keeps the wide list off period-closed pause seams — "In" can open a real sentence', () => {
        expect(joinSegments(['Did you know that.', 'In 1974 there was an act']))
            .toBe('Did you know that. In 1974 there was an act');
    });

    it('never lowercases a name even at a forced seam', () => {
        expect(joinSegments([
            { text: 'I need to message', forcedSplit: true },
            { text: 'Ryan about the update' },
        ])).toBe('I need to message Ryan about the update');
    });
});

describe('joinSegments — a pause seam the model closed with its default period', () => {
    // The model ends EVERY isolated clip with a period, so at a pause seam
    // that period says nothing; a capitalized "And/Which" says the sentence
    // continued. Real dictation 2026-09-01: "…preserved. Tell me…" / "…. And…".
    it('renders the pause as a comma before a conjunction or relativizer', () => {
        expect(joinSegments(['I went to the store.', 'And then I left.']))
            .toBe('I went to the store, and then I left.');
        expect(joinSegments(['tell me if that was preserved.', 'Which it was']))
            .toBe('tell me if that was preserved, which it was');
    });
    it('joins a resultive "So" with a comma, but leaves a discourse-opening "So," alone', () => {
        // Chosen by the user, 2026-09-01.
        expect(joinSegments(['This is a very important design decision.', 'So we need to get this right.']))
            .toBe('This is a very important design decision, so we need to get this right.');
        expect(joinSegments(['That is the plan.', 'So, what do you think?']))
            .toBe('That is the plan. So, what do you think?');
    });

    it('renders the pause as nothing before a preposition', () => {
        expect(joinSegments(['I made a copy.', 'Of the file']))
            .toBe('I made a copy of the file');
    });
    it('leaves a question or exclamation alone — the model only writes those on evidence', () => {
        expect(joinSegments(['Are you coming?', 'But not right now.']))
            .toBe('Are you coming? But not right now.');
        expect(joinSegments(['Stop!', 'And listen']))
            .toBe('Stop! And listen');
    });
    it('still leaves words that can open a sentence alone after a period', () => {
        expect(joinSegments(['that was preserved.', 'Tell me if it worked']))
            .toBe('that was preserved. Tell me if it worked');
    });
});

describe('joinSegments — must NOT make things worse', () => {

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

    it('leaves words that legitimately open sentences alone after a period-closed pause', () => {
        // At a seam the model closed with a period these are off the narrow
        // list — "If something…" can genuinely open a sentence there.
        for (const w of ['If', 'When', 'After', 'Before', 'Since', 'While', 'The', 'This', 'That', 'Then', 'Because']) {
            expect(joinSegments(['some text.', `${w} something`])).toBe(`some text. ${w} something`);
        }
    });

    it('lowercases those same words when the left segment was left UNFINISHED', () => {
        // No terminal punctuation is the model itself saying the clip did not
        // end — the sentence is certainly in flight, so the wide list applies.
        expect(joinSegments(['some text', 'If something'])).toBe('some text if something');
        expect(joinSegments(['we said', 'The plan is fine'])).toBe('we said the plan is fine');
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
