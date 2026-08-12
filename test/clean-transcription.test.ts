/**
 * Doubled-word cleanup. The rule is allowlisted rather than blanket, because
 * English doubles words legitimately far more often than it looks — and a
 * corrupted word is a worse bug than a surviving stutter.
 */
import { describe, it, expect } from 'vitest';
import { cleanTranscription } from '../src/utils/cleanTranscription';

describe('cleanTranscription — doubled words', () => {
    it('collapses stutters on function words', () => {
        expect(cleanTranscription('We need to to fix this.')).toBe('We need to fix this.');
        expect(cleanTranscription('Put it in the the folder.')).toBe('Put it in the folder.');
        expect(cleanTranscription('I I think so.')).toBe('I think so.');
        expect(cleanTranscription('Bread and and butter.')).toBe('Bread and butter.');
    });

    // Regression: a blanket /\b(\w+)\s+\1\b/ rewrote every one of these. Each
    // is valid English, and the rewrite changed the meaning rather than
    // tidying a disfluency.
    it('leaves legitimate doubles alone', () => {
        expect(cleanTranscription('He had had enough of it.')).toBe('He had had enough of it.');
        expect(cleanTranscription('The thing that that person said.')).toBe('The thing that that person said.');
        expect(cleanTranscription('What it is is a problem.')).toBe('What it is is a problem.');
        expect(cleanTranscription('What he does does not matter.')).toBe('What he does does not matter.');
        expect(cleanTranscription('It was very very good.')).toBe('It was very very good.');
    });

    it('leaves doubled interjections alone', () => {
        expect(cleanTranscription('No no no, do not do that.')).toBe('No no no, do not do that.');
        expect(cleanTranscription('Bye bye for now.')).toBe('Bye bye for now.');
    });

});

describe('cleanTranscription — false-start fragments', () => {
    it('drops a truncated syllable before the word it starts', () => {
        expect(cleanTranscription('tr truncated word here.')).toBe('Truncated word here.');
        expect(cleanTranscription('The pr project is late.')).toBe('The project is late.');
    });

    // Regression: the fragment must not be a word in its own right. These were
    // all losing their first word — "the theory of relativity" became "theory
    // of relativity".
    it('leaves a short real word that prefixes the next one', () => {
        expect(cleanTranscription('We went to the store.')).toBe('We went to the store.');
        expect(cleanTranscription('The theory of relativity.')).toBe('The theory of relativity.');
        expect(cleanTranscription('He held the door.')).toBe('He held the door.');
        expect(cleanTranscription('So sorry about that.')).toBe('So sorry about that.');
    });
});

describe('cleanTranscription — restarted phrases', () => {
    it('collapses a repeated phrase of two or more words', () => {
        expect(cleanTranscription('Would you would you like a cappuccino?'))
            .toBe('Would you like a cappuccino?');
        expect(cleanTranscription('What do you what do you think about tomorrow?'))
            .toBe('What do you think about tomorrow?');
        expect(cleanTranscription('I was thinking that we should we should probably wait.'))
            .toBe('I was thinking that we should probably wait.');
    });

    it('keeps the leading capital from the first copy', () => {
        expect(cleanTranscription('Would you would you mind?')).toBe('Would you mind?');
    });

    // The model punctuates deliberate repetition and leaves restarts bare, so
    // punctuation between the copies is the signal that this was meant.
    it('will not cross punctuation between the copies', () => {
        expect(cleanTranscription('It was very, very good.')).toBe('It was very, very good.');
        expect(cleanTranscription('Would you like coffee? Would you like tea?'))
            .toBe('Would you like coffee? Would you like tea?');
    });

    // "banger after banger after banger" — the only false positive found across
    // 200 real dictations. A restart stops after two copies; a chain continues.
    it('leaves a continuing chain alone', () => {
        expect(cleanTranscription("It's just banger after banger after banger."))
            .toBe("It's just banger after banger after banger.");
        expect(cleanTranscription('We went block by block by block.'))
            .toBe('We went block by block by block.');
    });

    it('still leaves single-word doubles to the allowlisted rule', () => {
        expect(cleanTranscription('He had had enough of it.')).toBe('He had had enough of it.');
    });
});
