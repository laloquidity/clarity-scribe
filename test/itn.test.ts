import { describe, it, expect } from 'vitest';
import { applyITN } from '../src/utils/itn';

/** Helper: assert idempotency — running twice equals running once. */
function expectIdempotent(input: string) {
    const once = applyITN(input);
    const twice = applyITN(once);
    expect(twice).toBe(once);
}

describe('applyITN — punctuation commands', () => {
    it('converts standalone comma attached to preceding word', () => {
        expect(applyITN('hello comma world')).toBe('hello, world');
    });
    it('converts period and full stop', () => {
        expect(applyITN('done period')).toBe('done.');
        expect(applyITN('done full stop')).toBe('done.');
    });
    it('converts question mark and exclamation mark/point', () => {
        expect(applyITN('really question mark')).toBe('really?');
        expect(applyITN('wow exclamation mark')).toBe('wow!');
        expect(applyITN('wow exclamation point')).toBe('wow!');
    });
    it('converts colon and semicolon', () => {
        expect(applyITN('note colon here')).toBe('note: here');
        expect(applyITN('apples semicolon oranges')).toBe('apples; oranges');
    });
    it('converts new line and new paragraph', () => {
        expect(applyITN('line one new line line two')).toBe('line one\nline two');
        expect(applyITN('para one new paragraph para two')).toBe('para one\n\npara two');
        expect(applyITN('a newline b')).toBe('a\nb');
    });
    it('converts parens and quotes', () => {
        expect(applyITN('open paren note close paren')).toBe('(note)');
        expect(applyITN('open quote hi close quote')).toBe('"hi"');
    });
    it('converts hyphen and dash', () => {
        expect(applyITN('state hyphen of hyphen the art')).toContain('-');
    });
    it('does not invent leading space before attached punctuation', () => {
        expect(applyITN('yes comma no')).toBe('yes, no');
    });
});

describe('applyITN — cardinal numbers', () => {
    it('converts simple two-word cardinals', () => {
        expect(applyITN('twenty three')).toBe('23');
        expect(applyITN('forty five')).toBe('45');
    });
    it('converts hundreds with and-connector', () => {
        expect(applyITN('one hundred and five')).toBe('105');
        expect(applyITN('three hundred')).toBe('300');
        expect(applyITN('two hundred thirty two')).toBe('232');
    });
    it('converts thousands', () => {
        expect(applyITN('two thousand twenty four')).toBe('2024');
        expect(applyITN('one thousand')).toBe('1000');
    });
    it('converts standalone teen/tens words', () => {
        expect(applyITN('fifteen')).toBe('15');
        expect(applyITN('ninety')).toBe('90');
    });
    it('leaves small ambiguous standalone words alone', () => {
        expect(applyITN('one of the best')).toBe('one of the best');
        expect(applyITN('a dog and a cat')).toBe('a dog and a cat');
        // exact-match: the old /\b2\b/ assertion couldn't catch "a 2nd"
        expect(applyITN('give me a second')).toBe('give me a second');
    });
    it('keeps surrounding words intact', () => {
        expect(applyITN('I have twenty three apples')).toBe('I have 23 apples');
    });
});

describe('applyITN — ordinals', () => {
    it('converts simple ordinals', () => {
        expect(applyITN('first')).toBe('1st');
        expect(applyITN('second')).toBe('2nd');
        expect(applyITN('third')).toBe('3rd');
        expect(applyITN('fourth')).toBe('4th');
        expect(applyITN('eleventh')).toBe('11th');
        expect(applyITN('twentieth')).toBe('20th');
    });
    it('converts compound ordinals', () => {
        expect(applyITN('twenty-second')).toBe('22nd');
        expect(applyITN('twenty second')).toBe('22nd');
        expect(applyITN('thirty-first')).toBe('31st');
    });
    it('uses correct suffix in context', () => {
        expect(applyITN('the first item')).toBe('the 1st item');
    });
    it('keeps "second" as a time unit in duration contexts', () => {
        expect(applyITN('tokens per second')).toBe('tokens per second');
        expect(applyITN('sixty frames per second')).toBe('60 frames per second');
        expect(applyITN('one second please')).toBe('one second please');
        expect(applyITN('wait a second')).toBe('wait a second');
        // …while ordinal readings still convert
        expect(applyITN('the second option')).toBe('the 2nd option');
        expect(applyITN('second place')).toBe('2nd place');
        expect(applyITN('second')).toBe('2nd');
    });
});

describe('applyITN — currency', () => {
    it('converts dollars', () => {
        expect(applyITN('five dollars')).toBe('$5');
        expect(applyITN('twenty dollars')).toBe('$20');
    });
    it('converts euros and pounds', () => {
        expect(applyITN('ten euros')).toBe('€10');
        expect(applyITN('five pounds')).toBe('£5');
    });
    it('converts dollars and cents', () => {
        expect(applyITN('five dollars and fifty cents')).toBe('$5.50');
        expect(applyITN('twelve dollars and five cents')).toBe('$12.05');
    });
    it('does not touch a bare currency noun', () => {
        expect(applyITN('the dollars were spent')).toBe('the dollars were spent');
    });
});

describe('applyITN — times', () => {
    it('converts hour with am/pm', () => {
        expect(applyITN('nine am')).toBe('9 AM');
        expect(applyITN('five pm')).toBe('5 PM');
    });
    it('converts hour:minute with am/pm', () => {
        expect(applyITN('two thirty pm')).toBe('2:30 PM');
        expect(applyITN('twelve fifteen pm')).toBe('12:15 PM');
    });
    it('handles a.m./p.m. punctuation forms', () => {
        expect(applyITN('nine a.m.')).toBe('9 AM');
    });
    it('does not invent times without a meridiem', () => {
        expect(applyITN('two thirty')).not.toContain(':');
    });
});

describe('applyITN — dates', () => {
    it('converts month + ordinal', () => {
        expect(applyITN('january fifth')).toBe('January 5');
        expect(applyITN('may third')).toBe('May 3');
    });
    it('converts "the Nth of month"', () => {
        expect(applyITN('the third of may')).toBe('May 3');
        expect(applyITN('the twenty-first of june')).toBe('June 21');
    });
    it('rejects impossible day numbers', () => {
        // "march fortieth" → 40 is out of range, left untouched-ish
        const out = applyITN('march fortieth');
        expect(out).not.toBe('March 40');
    });
});

describe('applyITN — idempotency', () => {
    const cases = [
        'hello comma world',
        'done period',
        'twenty three',
        'one hundred and five',
        'two thousand twenty four',
        'first',
        'twenty-second',
        'five dollars',
        'five dollars and fifty cents',
        'ten euros',
        'nine am',
        'two thirty pm',
        'january fifth',
        'the third of may',
        'open paren note close paren',
    ];
    for (const c of cases) {
        it(`is idempotent for: ${c}`, () => expectIdempotent(c));
    }
});

describe('applyITN — already-written / negative passthrough', () => {
    it('leaves already-written digits unchanged', () => {
        expect(applyITN('I have 23 apples')).toBe('I have 23 apples');
        expect(applyITN('it cost $5')).toBe('it cost $5');
        expect(applyITN('meet at 2:30 PM')).toBe('meet at 2:30 PM');
        expect(applyITN('12345')).toBe('12345');
    });
    it('leaves the digit-string the model emitted untouched', () => {
        // Parakeet renders "one two three four five" as "12345" already.
        expect(applyITN('the code is 12345')).toBe('the code is 12345');
    });
    it('leaves plain prose unchanged', () => {
        expect(applyITN('the quick brown fox')).toBe('the quick brown fox');
        expect(applyITN('she said hello to me')).toBe('she said hello to me');
    });
    it('handles empty and whitespace input', () => {
        expect(applyITN('')).toBe('');
        expect(applyITN('   ')).toBe('   ');
    });
    it('does not double-convert previously converted currency', () => {
        expect(applyITN('$5')).toBe('$5');
        expect(applyITN('$5.50')).toBe('$5.50');
    });
});

describe('applyITN — combined / realistic sentences', () => {
    it('mixes punctuation and numbers', () => {
        expect(applyITN('I owe you twenty three dollars period')).toBe('I owe you $23.');
    });
    it('handles a meeting sentence', () => {
        expect(applyITN('lets meet january fifth at nine am')).toBe('lets meet January 5 at 9 AM');
    });
    it('handles a list with new lines', () => {
        expect(applyITN('one new line two new line three')).toBe('one\ntwo\nthree');
    });
});

describe('applyITN — line-break commands absorb ASR punctuation', () => {
    it('drops the period the ASR attached to the spoken command', () => {
        // Real artifact from dictation: "…thing. New line. I added" produced
        // "thing.\n. I added" — the "." after the command must be absorbed.
        expect(applyITN('one more thing. New line. I added the feature'))
            .toBe('one more thing.\nI added the feature');
    });
    it('drops a comma attached to the command', () => {
        expect(applyITN('when I tell you new line, it actually works'))
            .toBe('when I tell you\nit actually works');
    });
    it('keeps the sentence-final punctuation BEFORE the command', () => {
        expect(applyITN('done. new paragraph. Next topic'))
            .toBe('done.\n\nNext topic');
    });
});

describe('applyITN — thousands separators', () => {
    it('groups model-emitted currency digits', () => {
        expect(applyITN('my payment of $50000000')).toBe('my payment of $50,000,000');
        expect(applyITN('$5000')).toBe('$5,000');
        expect(applyITN('€1234567')).toBe('€1,234,567');
    });
    it('groups large bare integers (6+ digits)', () => {
        expect(applyITN('need to pay 5000000.')).toBe('need to pay 5,000,000.');
        expect(applyITN('about 123456789 rows')).toBe('about 123,456,789 rows');
    });
    it('groups spoken currency end-to-end', () => {
        expect(applyITN('fifty million dollars')).toBe('$50,000,000');
    });
    it('leaves years, codes, ZIPs, and fractions alone', () => {
        expect(applyITN('back in 2026 it was fine')).toBe('back in 2026 it was fine');
        expect(applyITN('the code is 12345')).toBe('the code is 12345');
        expect(applyITN('PIN 1234')).toBe('PIN 1234');
        expect(applyITN('pi is 3.1415926')).toBe('pi is 3.1415926');
        expect(applyITN('$50000.25')).toBe('$50,000.25');
    });
    it('is idempotent on grouped output', () => {
        expect(applyITN('$50,000,000')).toBe('$50,000,000');
        expect(applyITN(applyITN('my payment of $50000000'))).toBe('my payment of $50,000,000');
    });
});
