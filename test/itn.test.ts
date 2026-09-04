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
        expect(applyITN('one thousand')).toBe('1,000');
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

describe('applyITN — "a hundred" and a bare leading "hundred"', () => {
    it('reads the article or a dropped article as the multiplier one', () => {
        // Spoken "$164,000 pool" came out "hundred $64,000 pool" (real
        // dictation, 2026-09-01).
        expect(applyITN('a hundred sixty four thousand dollar pool')).toBe('$164,000 pool');
        expect(applyITN('hundred sixty four thousand dollar pool')).toBe('$164,000 pool');
        expect(applyITN('a hundred dollars')).toBe('$100');
        expect(applyITN('a thousand times')).toBe('1,000 times');
        expect(applyITN('a hundred and five people')).toBe('105 people');
    });
    it('leaves a lone "hundred" and an ordinary article alone', () => {
        expect(applyITN('the hundred people')).toBe('the hundred people');
        expect(applyITN('a dog and a cat')).toBe('a dog and a cat');
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

describe('applyITN — spelled-out acronyms', () => {
    // All from real dictation, 2026-08-31: spoken letters come out of the
    // model as isolated capitals ("V C", "C F O") and stayed that way.
    it('collapses runs of spoken single capitals', () => {
        expect(applyITN('the V C fund')).toBe('the VC fund');
        expect(applyITN('our C F O and C I O met')).toBe('our CFO and CIO met');
        expect(applyITN('the U S A')).toBe('the USA');
        expect(applyITN('using A I tools')).toBe('using AI tools');
    });
    it("keeps a trailing possessive attached", () => {
        expect(applyITN("the C E O's decision")).toBe("the CEO's decision");
    });
    it('joins a spelled acronym the model chunked into known pieces', () => {
        // "USDC" came out "USD C" and "US DC" in one dictation, 2026-09-01.
        expect(applyITN('only lend and borrow USD C')).toBe('only lend and borrow USDC');
        expect(applyITN("the USD C's peg")).toBe("the USDC's peg");
        // Two two-letter chunks carry no lone-letter signal, and "US EU
        // trade" must not become "USEU" — this shape is the Personal
        // Dictionary's job (a "USDC" entry also biases the decoder itself).
        expect(applyITN("you're lending US DC, correct?")).toBe("you're lending US DC, correct?");
        expect(applyITN('US EU trade talks')).toBe('US EU trade talks');
    });
    it('does not glue real acronyms together or eat the pronoun I', () => {
        expect(applyITN('the FBI CIA rivalry')).toBe('the FBI CIA rivalry');
        expect(applyITN('the US I think')).toBe('the US I think');
        expect(applyITN('a NASA X-ray')).toBe('a NASA X-ray');
    });
    it('leaves a lone capital alone', () => {
        expect(applyITN('the draft D that I reviewed')).toBe('the draft D that I reviewed');
    });
    it('leaves lowercase letters alone', () => {
        expect(applyITN('a b testing plan')).toBe('a b testing plan');
    });
    it('never collapses across a sentence boundary written with a period', () => {
        expect(applyITN('went with plan B. Development starts Monday'))
            .toBe('went with plan B. Development starts Monday');
    });
});

describe('applyITN — spaced/dotted meridiems (real ASR output)', () => {
    // The model writes spoken "AM"/"PM" as spelled letters: "eight A. M."
    // (verbatim from dictation, 2026-08-31) — the times rule now reads them.
    it('converts "A. M." with a space between the letters', () => {
        expect(applyITN('eight A. M.')).toBe('8 AM');
        expect(applyITN('nine 30 A. M.')).toBe('9:30 AM');
    });
    it('converts bare spaced letters after the acronym pass', () => {
        expect(applyITN('meet at nine A M')).toBe('meet at 9 AM');
        expect(applyITN('nine thirty a m')).toBe('9:30 AM');
    });
    it('does not mistake an article + m-word for a meridiem', () => {
        // ("eight" itself stays a word — the under-ten rule — the point here
        // is that "a month" must never be read as "AM".)
        expect(applyITN('paid eight a month ago')).toBe('paid eight a month ago');
    });
    it('reads "p. M" whose M the acronym pass would otherwise swallow', () => {
        // "…a big wick at five twenty p. M E…" (real dictation, 2026-09-04;
        // the E is the clipped start of "Eastern"). "M E" joined into "ME"
        // and the time came out "five 20 p. ME".
        expect(applyITN('a big wick at five twenty p. M E that broke'))
            .toBe('a big wick at 5:20 PM E that broke');
        expect(applyITN('five twenty p. M.')).toBe('5:20 PM');
        expect(applyITN('at five twenty p. M eastern time')).toBe('at 5:20 PM eastern time');
    });
});

describe('applyITN — percent', () => {
    it('writes a percentage with the symbol, whatever form the number took', () => {
        expect(applyITN('it rose 80 percent')).toBe('it rose 80%');
        expect(applyITN('it rose eighty percent')).toBe('it rose 80%');
        expect(applyITN('eighty point six percent')).toBe('80.6%');
        expect(applyITN('only five percent')).toBe('only 5%');
        expect(applyITN('one hundred percent sure')).toBe('100% sure');
    });
    it('leaves surrounding punctuation exactly where it was', () => {
        expect(applyITN('it rose 80 percent.')).toBe('it rose 80%.');
        expect(applyITN('about 80 percent, which is a lot')).toBe('about 80%, which is a lot');
        expect(applyITN('was it 80 percent?')).toBe('was it 80%?');
    });
    it('never touches "percentage" or a number-less "percent"', () => {
        expect(applyITN('a large percentage of users')).toBe('a large percentage of users');
        expect(applyITN('the percent of users')).toBe('the percent of users');
    });
});

describe('applyITN — decimals in any word/digit mix', () => {
    it('reads the decimal however the model chose to write it', () => {
        // "10 point six" verbatim from real dictation, 2026-08-31.
        expect(applyITN('it came out to 10 point six')).toBe('it came out to 10.6');
        expect(applyITN('ten point six')).toBe('10.6');
        expect(applyITN('ten point 6')).toBe('10.6');
    });
    it('reads digit runs, leading zeros, and compound fractions', () => {
        expect(applyITN('three point one four')).toBe('3.14');
        expect(applyITN('nine point oh five')).toBe('9.05');
        expect(applyITN('ten point sixty five')).toBe('10.65');
        expect(applyITN('zero point five')).toBe('0.5');
    });
    it('requires a number on BOTH sides of "point"', () => {
        expect(applyITN('at that point six people left'))
            .toBe('at that point six people left');
        expect(applyITN('the ten point plan')).toBe('the 10 point plan');
    });
});

describe('applyITN — multiplier X', () => {
    it('attaches a lone X to the number before it', () => {
        // "the flat 20 X is really interesting" verbatim, 2026-09-01.
        expect(applyITN('the flat 20 X is really interesting')).toBe('the flat 20X is really interesting');
        expect(applyITN('add a flat thirty three X tier')).toBe('add a flat 33X tier');
        expect(applyITN('more than ten X leverage')).toBe('more than 10X leverage');
    });
    it('leaves an X that is not a multiplier alone', () => {
        expect(applyITN('the X axis')).toBe('the X axis');
        expect(applyITN('20 Xbox games')).toBe('20 Xbox games');
    });
});

describe('applyITN — letter-number designators', () => {
    it('joins a spoken letter and number into a designator', () => {
        // "C five and C six" should read "C5 and C6" — verbatim from real
        // dictation, 2026-08-31.
        expect(applyITN('compare C five and C six')).toBe('compare C5 and C6');
        expect(applyITN('the T six variant')).toBe('the T6 variant');
        expect(applyITN('vitamin B twelve')).toBe('vitamin B12');
        expect(applyITN('gate B 52')).toBe('gate B52');
    });
    it('never joins the article A or the pronoun I', () => {
        expect(applyITN('A five minute break')).toBe('A five minute break');
        expect(applyITN('should I five them')).toBe('should I five them');
    });
    it('a scale word after the number keeps the quantity reading', () => {
        expect(applyITN('vitamin C five hundred milligrams'))
            .toBe('vitamin C 500 milligrams');
    });
    it('joins a short spelled acronym and a number too', () => {
        // "a T D nine" → "TD nine" (acronym pass) → "TD9". Real dictation,
        // 2026-09-04: the TD Sequential indicator's ninth candle.
        expect(applyITN('a couple candles before was a T D nine')).toBe('a couple candles before was a TD9');
        expect(applyITN('a TD 9 on the daily')).toBe('a TD9 on the daily');
    });
    it('never treats an everyday acronym as a designator stem', () => {
        expect(applyITN('one that the US five agencies use')).toBe('one that the US five agencies use');
        expect(applyITN('the EU 27 members')).toBe('the EU 27 members');
        expect(applyITN('the CEO 20 minutes late')).toBe('the CEO 20 minutes late');
    });
});

describe('applyITN — the meridiem dot that was also the sentence period', () => {
    it('keeps the period when a new sentence follows the time', () => {
        // Run-on verbatim from real dictation, 2026-08-31: "…around 9:17 AM I
        // found that…" — the model's "A. M." dot was the sentence ending too.
        expect(applyITN('around nine 17 A. M. I found that the milk'))
            .toBe('around 9:17 AM. I found that the milk');
        expect(applyITN('at eight thirty A. Then we left'))
            .toBe('at 8:30 AM. Then we left');
    });
    it('drops the dot for lowercase continuations and end of text', () => {
        expect(applyITN('nine a.m. yesterday was fine')).toBe('9 AM yesterday was fine');
        expect(applyITN('nine a.m.')).toBe('9 AM');
    });
    it('treats day/month/timezone continuations as the same sentence', () => {
        expect(applyITN('nine a.m. Monday works')).toBe('9 AM Monday works');
        expect(applyITN('eight p.m. Eastern is late')).toBe('8 PM Eastern is late');
    });
});

describe('applyITN — truncated meridiem (the lost "M")', () => {
    it('finishes a clipped AM/PM when minutes are present', () => {
        // "at eight thirty A." and "eight 30 A." verbatim from real
        // dictation, 2026-08-31 — the model lost the trailing "M".
        expect(applyITN('I went to get coffee at eight thirty A.'))
            .toBe('I went to get coffee at 8:30 AM');
        expect(applyITN('eight 30 A.')).toBe('8:30 AM');
        expect(applyITN('eight thirty P.')).toBe('8:30 PM');
        expect(applyITN("seven o'clock A.")).toBe('7 AM');
    });
    it('requires a capital letter — a lowercase article never converts', () => {
        expect(applyITN('pills eight thirty a day')).not.toContain('AM');
    });
    it('requires minutes — names like "gate eight A" are untouched', () => {
        expect(applyITN('meet at gate eight A')).toBe('meet at gate eight A');
    });
});

describe('applyITN — compound minutes in any word/digit mix', () => {
    it('reads the minute however the model chose to write it', () => {
        // "eight 20 6 AM" verbatim from real dictation (spoken "8:26 AM"),
        // 2026-08-31: the model split the minute into digits-tens + digit-one.
        expect(applyITN('eight 20 6 AM')).toBe('8:26 AM');
        expect(applyITN('eight twenty six AM')).toBe('8:26 AM');
        expect(applyITN('eight twenty 6 AM')).toBe('8:26 AM');
        expect(applyITN('8 20 6 PM')).toBe('8:26 PM');
    });
    it('reads bare tens and spoken leading-zero minutes', () => {
        expect(applyITN('eight 20 AM')).toBe('8:20 AM');
        expect(applyITN('eight twenty AM')).toBe('8:20 AM');
        expect(applyITN('seven oh five PM')).toBe('7:05 PM');
    });
});

describe('applyITN — spoken years', () => {
    it('joins century-word pairs into a four-digit year', () => {
        // "20 26" verbatim from real dictation, 2026-08-31.
        expect(applyITN('the year twenty twenty six')).toBe('the year 2026');
        expect(applyITN('nineteen eighty four')).toBe('1984');
        expect(applyITN('twenty nineteen')).toBe('2019');
        expect(applyITN('back in twenty twenty')).toBe('back in 2020');
    });
    it('leaves plain cardinals without a century word to the cardinal rule', () => {
        expect(applyITN('twenty six')).toBe('26');
        expect(applyITN('twenty one')).toBe('21');
    });
    it('a scale word after the pair vetoes the year reading', () => {
        expect(applyITN('twenty twenty thousand')).not.toContain('2020');
    });
});

describe('applyITN — hyphenated compound numbers', () => {
    it('converts the whole compound, never half of it', () => {
        // "20-four" verbatim from real dictation, 2026-08-31.
        expect(applyITN('twenty-four')).toBe('24');
        expect(applyITN('I said twenty-four hours')).toBe('I said 24 hours');
        expect(applyITN('forty-five dollars')).toBe('$45');
    });
    it('leaves non-number hyphenations alone', () => {
        expect(applyITN('the check-in desk')).toBe('the check-in desk');
        expect(applyITN('twenty-twenty vision')).toBe('20-20 vision');
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
        'our C F O and C I O met',
        'eight A. M.',
        'eight 20 6 AM',
        'coffee at eight thirty A.',
        'around nine 17 A. M. I found that the milk',
        'compare C five and C six',
        'it came out to 10 point six',
        'it rose eighty point six percent.',
        'the year twenty twenty six',
        'twenty-four',
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
        expect(applyITN('1234')).toBe('1234');
    });
    it('leaves the digit-string the model emitted untouched', () => {
        // Parakeet renders "one two three four" as "1234" already. (Five
        // digits and up now take separators — see the thousands tests — so a
        // five-digit code would; four-digit codes and years never do.)
        expect(applyITN('the code is 1234')).toBe('the code is 1234');
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
    it('groups large bare integers (5+ digits)', () => {
        expect(applyITN('need to pay 5000000.')).toBe('need to pay 5,000,000.');
        expect(applyITN('about 123456789 rows')).toBe('about 123,456,789 rows');
        expect(applyITN('peaked at 82000')).toBe('peaked at 82,000');
    });
    it('groups spoken currency end-to-end', () => {
        expect(applyITN('fifty million dollars')).toBe('$50,000,000');
    });
    it('groups spoken thousands as they are written', () => {
        // Real dictation, 2026-09-04: prices that came out "82000", "80800",
        // "79400" — "give proper formatting and account for tens, hundreds,
        // thousands, 100,000s, 1,000,000s, 10,000,000".
        expect(applyITN('up at eighty two thousand')).toBe('up at 82,000');
        expect(applyITN('peaked at eighty two thousand two hundred and seventy nine'))
            .toBe('peaked at 82,279');
        expect(applyITN('went to eighty thousand eight hundred')).toBe('went to 80,800');
        expect(applyITN('down to seventy nine thousand four hundred')).toBe('down to 79,400');
        expect(applyITN('three thousand rows')).toBe('3,000 rows');
        expect(applyITN('twelve hundred units')).toBe('1,200 units');
        expect(applyITN('a hundred sixty four thousand')).toBe('164,000');
        expect(applyITN('two point five million')).toBe('2.5 million');
        expect(applyITN('ten million')).toBe('10,000,000');
        expect(applyITN('three hundred million')).toBe('300,000,000');
    });
    it('keeps a spoken year range bare — "two thousand twenty six" is a year', () => {
        expect(applyITN('in two thousand twenty six')).toBe('in 2026');
        expect(applyITN('two thousand and twenty four')).toBe('2024');
        // The accepted cost: a spoken count in that range stays ungrouped.
        expect(applyITN('two thousand people')).toBe('2000 people');
    });
    it('leaves years, PINs, and fractions alone', () => {
        expect(applyITN('back in 2026 it was fine')).toBe('back in 2026 it was fine');
        expect(applyITN('PIN 1234')).toBe('PIN 1234');
        expect(applyITN('pi is 3.1415926')).toBe('pi is 3.1415926');
        expect(applyITN('$50000.25')).toBe('$50,000.25');
    });
    it('reads a spoken decimal on a large number', () => {
        expect(applyITN('eighty two thousand point three eight')).toBe('82,000.38');
        expect(applyITN('eighty two thousand point thirty eight')).toBe('82,000.38');
        expect(applyITN('82000 point 38')).toBe('82,000.38');
        expect(applyITN('eighty two dollars and thirty eight cents')).toBe('$82.38');
    });
    it('is idempotent on grouped output', () => {
        expect(applyITN('$50,000,000')).toBe('$50,000,000');
        expect(applyITN(applyITN('my payment of $50000000'))).toBe('my payment of $50,000,000');
    });
});
