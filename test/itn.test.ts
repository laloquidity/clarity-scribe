import { describe, it, expect } from 'vitest';
import { applyITN } from '../src/utils/itn';

/** Helper: assert idempotency — running twice equals running once. */
function expectIdempotent(input: string) {
    const once = applyITN(input);
    const twice = applyITN(once);
    expect(twice).toBe(once);
}

/** Punctuation commands are opt-in — this is the caller that asked for them. */
const punct = (s: string) => applyITN(s, { punctuation: true });

describe('applyITN — punctuation commands (opt-in)', () => {
    it('converts standalone comma attached to preceding word', () => {
        expect(punct('hello comma world')).toBe('hello, world');
    });
    it('converts period and full stop', () => {
        expect(punct('done period')).toBe('done.');
        expect(punct('done full stop')).toBe('done.');
    });
    it('converts question mark and exclamation mark/point', () => {
        expect(punct('really question mark')).toBe('really?');
        expect(punct('wow exclamation mark')).toBe('wow!');
        expect(punct('wow exclamation point')).toBe('wow!');
    });
    it('converts colon and semicolon', () => {
        expect(punct('note colon here')).toBe('note: here');
        expect(punct('apples semicolon oranges')).toBe('apples; oranges');
    });
    it('converts new line and new paragraph', () => {
        expect(punct('line one new line line two')).toBe('line one\nline two');
        expect(punct('para one new paragraph para two')).toBe('para one\n\npara two');
        expect(punct('a newline b')).toBe('a\nb');
    });
    it('converts parens and quotes', () => {
        expect(punct('open paren note close paren')).toBe('(note)');
        expect(punct('open quote hi close quote')).toBe('"hi"');
    });
    it('converts hyphen and dash', () => {
        expect(punct('state hyphen of hyphen the art')).toContain('-');
    });
    it('does not invent leading space before attached punctuation', () => {
        expect(punct('yes comma no')).toBe('yes, no');
    });
});

describe('applyITN — smart formatting alone NEVER touches punctuation words', () => {
    // Regression: smart formatting shipped with its own naive punctuation
    // substitution that ignored the Spoken Punctuation setting AND ignored
    // punctuation the model had already written, so it doubled it. Reported
    // from real dictation 2026-08-10 with spokenPunctuation:false,
    // itnEnabled:true. Both strings below are verbatim from that report.
    it('leaves a spoken "period" alone instead of doubling the model\'s "?"', () => {
        expect(applyITN('What do you think about that time period?'))
            .toBe('What do you think about that time period?');
    });
    it('does not turn a spoken "comma" into a second comma', () => {
        expect(applyITN('the spoken punctuation is off comma, it is still functioning.'))
            .toBe('the spoken punctuation is off comma, it is still functioning.');
    });
    it('leaves every other punctuation command word untouched', () => {
        for (const s of [
            'done period', 'hello comma world', 'really question mark',
            'note colon here', 'line one new line line two',
            'open paren note close paren', 'state hyphen of hyphen the art',
        ]) {
            expect(applyITN(s)).toBe(s);
        }
    });
    it('still formats numbers, currency, times and dates', () => {
        // The point of the split: smart formatting keeps doing its actual job.
        expect(applyITN('twenty three')).toBe('23');
        expect(applyITN('five dollars and fifty cents')).toBe('$5.50');
        expect(applyITN('two thirty pm')).toBe('2:30 PM');
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
    it('spells out ordinals below ten, converts ten and up', () => {
        // Mirrors the cardinal rule this file already applies (a standalone
        // "five" stays a word, "fifteen" becomes 15) and ordinary English
        // prose convention. Ordinals used to convert unconditionally.
        expect(applyITN('first')).toBe('first');
        expect(applyITN('second')).toBe('second');
        expect(applyITN('third')).toBe('third');
        expect(applyITN('ninth')).toBe('ninth');
        expect(applyITN('tenth')).toBe('10th');
        expect(applyITN('eleventh')).toBe('11th');
        expect(applyITN('twentieth')).toBe('20th');
    });
    it('converts compound ordinals', () => {
        expect(applyITN('twenty-second')).toBe('22nd');
        expect(applyITN('twenty second')).toBe('22nd');
        expect(applyITN('thirty-first')).toBe('31st');
        expect(applyITN('the twenty-first century')).toBe('the 21st century');
    });
    it('leaves the sentence-opening enumerator alone', () => {
        // Both verbatim from real dictation: "1st, let's make sure everything
        // is done" and "it should actually write out 1st".
        expect(applyITN("First, let's make sure everything is done"))
            .toBe("First, let's make sure everything is done");
        expect(applyITN('it should actually write out first'))
            .toBe('it should actually write out first');
        expect(applyITN('Second, we push everything together'))
            .toBe('Second, we push everything together');
    });
    it('leaves ordinary prose and idioms alone', () => {
        for (const s of [
            'first of all', 'at first', 'first and foremost', 'the first time',
            'I first met her there', 'you go first', 'second to none',
            'on second thought', 'third party', 'first name', 'first aid',
            'the first item', 'second place', 'the second option',
        ]) {
            expect(applyITN(s)).toBe(s);
        }
    });
    it('uses numerals for addresses and numbered series', () => {
        expect(applyITN('fifth avenue')).toBe('5th avenue');
        expect(applyITN('the third floor')).toBe('the 3rd floor');
        expect(applyITN('First Avenue')).toBe('1st Avenue');
        expect(applyITN('her fourth birthday')).toBe('her 4th birthday');
        expect(applyITN('the second edition')).toBe('the 2nd edition');
        expect(applyITN('third grade')).toBe('3rd grade');
    });
    it('keeps fixed phrases where the ordinal is idiom, not position', () => {
        // "at the eleventh hour" = at the last moment. Survives the spell-out
        // rule only because 11 is above the threshold, hence the explicit set.
        expect(applyITN('they fixed it at the eleventh hour'))
            .toBe('they fixed it at the eleventh hour');
        // …but the positional reading of the same word still converts.
        expect(applyITN('finished eleventh')).toBe('finished 11th');
        expect(applyITN('the eleventh item')).toBe('the 11th item');
    });
    it('keeps the fraction reading of ten-and-up ordinals', () => {
        // "a tenth of the budget" is not "a 10th of the budget". Below ten
        // this is already covered by the spell-out rule ("a fifth").
        expect(applyITN('a tenth of the budget')).toBe('a tenth of the budget');
        expect(applyITN('one twentieth of that')).toBe('one twentieth of that');
        // …but the positional reading still converts.
        expect(applyITN('the tenth time')).toBe('the 10th time');
    });
    it('keeps "second" as a time unit in duration contexts', () => {
        expect(applyITN('tokens per second')).toBe('tokens per second');
        expect(applyITN('sixty frames per second')).toBe('60 frames per second');
        expect(applyITN('one second please')).toBe('one second please');
        expect(applyITN('wait a second')).toBe('wait a second');
        // "second" is below ORDINAL_NUMERAL_MIN, so the ordinal reading now
        // stays spelled out too — which is also the correct prose form.
        expect(applyITN('the second option')).toBe('the second option');
        expect(applyITN('second place')).toBe('second place');
        expect(applyITN('second')).toBe('second');
    });

    it('treats any count before "second" as a duration, not an ordinal', () => {
        // Caught in real dictation: "a quick five second recording" was being
        // written as "five 2nd recording". ("five" itself stays spelled out —
        // standalone cardinals under ten are left as words by design.)
        expect(applyITN('a quick five second recording')).toBe('a quick five second recording');
        expect(applyITN('a fifteen second recording')).toBe('a 15 second recording');
        expect(applyITN('a ten second delay')).toBe('a 10 second delay');
        expect(applyITN('every second counts')).toBe('every second counts');
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
        expect(punct('I owe you twenty three dollars period')).toBe('I owe you $23.');
    });
    it('handles a meeting sentence', () => {
        expect(applyITN('lets meet january fifth at nine am')).toBe('lets meet January 5 at 9 AM');
    });
    it('handles a list with new lines', () => {
        expect(punct('one new line two new line three')).toBe('one\ntwo\nthree');
    });
});

describe('applyITN — line-break commands absorb ASR punctuation', () => {
    it('drops the period the ASR attached to the spoken command', () => {
        // Real artifact from dictation: "…thing. New line. I added" produced
        // "thing.\n. I added" — the "." after the command must be absorbed.
        expect(punct('one more thing. New line. I added the feature'))
            .toBe('one more thing.\nI added the feature');
    });
    it('drops a comma attached to the command', () => {
        expect(punct('when I tell you new line, it actually works'))
            .toBe('when I tell you\nit actually works');
    });
    it('keeps the sentence-final punctuation BEFORE the command', () => {
        expect(punct('done. new paragraph. Next topic'))
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
