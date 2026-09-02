/**
 * Inverse Text Normalization (ITN) — spoken-form → written-form
 *
 * Converts dictated spoken-form text to its written representation:
 *   - "comma"               → ","
 *   - "twenty three"        → "23"
 *   - "twenty first"        → "21st"  ("first" stays a word — see below)
 *   - "five dollars"        → "$5"
 *   - "two thirty pm"       → "2:30 PM"
 *   - "january fifth"       → "January 5"
 *   - "C F O"               → "CFO"
 *   - "twenty twenty six"   → "2026"
 *
 * DESIGN PRINCIPLES (this is a pure-JS, fully-offline feature):
 *   1. CONSERVATIVE — when a phrase is ambiguous, leave it unchanged. We would
 *      rather miss a conversion than corrupt already-correct text. The Parakeet
 *      model already renders some spoken numbers as digits on its own, so ITN
 *      must never fight the model or double-convert.
 *   2. IDEMPOTENT — `applyITN(applyITN(x)) === applyITN(x)` for all inputs.
 *      Every transform is anchored on word boundaries and only matches
 *      spelled-out spoken forms, never the digit/symbol forms it produces.
 *   3. WORD-BOUNDARY ANCHORED — never match inside a larger word.
 *
 * Each transform is a standalone function so it can be tested independently and
 * its order in the pipeline is explicit. `applyITN` is the single public entry.
 *
 * Reimplemented in TypeScript inspired by FluidAudio's TextNormalizer (Apache-2.0);
 * no code was copied — this is a much smaller, regex-based, dependency-free pass.
 */

// ---------------------------------------------------------------------------
// Number word tables
// ---------------------------------------------------------------------------

const ONES: Record<string, number> = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
    eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
    fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
    nineteen: 19,
};

const TENS: Record<string, number> = {
    twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
    eighty: 80, ninety: 90,
};

const SCALES: Record<string, number> = {
    hundred: 100, thousand: 1000, million: 1000000, billion: 1000000000,
};

// Ordinal word → cardinal value (suffix derived from the value).
const ORDINAL_WORDS: Record<string, number> = {
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7,
    eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13,
    fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
    eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30,
    fortieth: 40, fiftieth: 50, sixtieth: 60, seventieth: 70, eightieth: 80,
    ninetieth: 90,
};

// Tens prefix that can lead a compound ordinal, e.g. "twenty-second" → 22nd.
const TENS_PREFIX_FOR_ORDINAL: Record<string, number> = TENS;

const MONTHS: Record<string, string> = {
    january: 'January', february: 'February', march: 'March', april: 'April',
    may: 'May', june: 'June', july: 'July', august: 'August',
    september: 'September', october: 'October', november: 'November',
    december: 'December',
};

// Cap on number-word parsing to avoid runaway/ambiguous spans.
const MAX_CARDINAL = 999999999999;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Correct English ordinal suffix for a number (1→st, 2→nd, 3→rd, 11/12/13→th). */
function ordinalSuffix(n: number): string {
    const mod100 = n % 100;
    if (mod100 >= 11 && mod100 <= 13) return 'th';
    switch (n % 10) {
        case 1: return 'st';
        case 2: return 'nd';
        case 3: return 'rd';
        default: return 'th';
    }
}

const has = (obj: Record<string, unknown>, k: string) =>
    Object.prototype.hasOwnProperty.call(obj, k);

const isOnes = (w: string) => has(ONES, w);
const isTens = (w: string) => has(TENS, w);
const isScale = (w: string) => has(SCALES, w);
const isNumberWord = (w: string) => isOnes(w) || isTens(w) || isScale(w);

/**
 * Parse a maximal run of cardinal number words starting at `tokens[start]`.
 * Returns the numeric value and the count of word entries consumed (`next`),
 * or null if no valid number begins at `start`.
 *
 * Handles: "twenty three" (23), "one hundred and five" (105),
 * "two hundred thirty two" (232), "two thousand twenty four" (2024),
 * "three hundred" (300), "fifteen" (15). The connector "and" is allowed only
 * between number words.
 */
function parseCardinal(tokens: string[], start: number): { value: number; next: number } | null {
    let i = start;
    let total = 0;       // sum of completed scale groups (e.g. the "...thousand" part)
    let hundreds = 0;    // the "N hundred" portion of the current sub-thousand group
    let tensOnes = 0;    // the tens+ones portion (0..99) being built
    let consumedAny = false;
    let lastKind: 'none' | 'ones' | 'tens' | 'hundred' = 'none';

    const groupValue = () => hundreds + tensOnes;

    while (i < tokens.length) {
        const w = tokens[i];

        // "a hundred", "a thousand": the article is the multiplier one. Only
        // at the start of a number and only before a scale word, so "a dog"
        // is untouched. Spoken "a hundred sixty four thousand dollar pool"
        // came out "hundred $64,000 pool" without this (real dictation,
        // 2026-09-01) — the parser skipped "hundred" and began at "sixty".
        if (w === 'a' && !consumedAny && i + 1 < tokens.length && isScale(tokens[i + 1])) {
            tensOnes = 1;
            lastKind = 'ones';
            consumedAny = true;
            i++;
            continue;
        }

        if (w === 'and') {
            // "and" only bridges within a number (e.g. "hundred and five").
            // Require something already consumed and a non-scale number word next.
            if (!consumedAny) break;
            const nxt = tokens[i + 1];
            if (nxt !== undefined && isNumberWord(nxt) && !isScale(nxt)) {
                i++;
                continue;
            }
            break;
        }

        if (isOnes(w)) {
            const v = ONES[w];
            if (v < 10) {
                // A ones digit (1..9) is valid as the start of a number, or
                // directly after a tens word ("twenty three" → 23). It must not
                // follow another ones/teen — "five six" is two separate numbers.
                if (lastKind === 'ones') break;
                if (tensOnes % 10 !== 0) break; // a ones digit already filled
                tensOnes += v;
            } else {
                // A teen (10..19) can only start a fresh tens/ones slot.
                if (tensOnes !== 0) break;
                tensOnes += v;
            }
            lastKind = 'ones';
            consumedAny = true;
            i++;
            continue;
        }

        if (isTens(w)) {
            if (tensOnes !== 0) break;            // "twenty thirty" — stop
            tensOnes += TENS[w];
            lastKind = 'tens';
            consumedAny = true;
            i++;
            continue;
        }

        if (isScale(w)) {
            const scale = SCALES[w];
            if (scale === 100) {
                if (hundreds !== 0) break;
                // "hundred" normally needs a multiplier (1..99) before it; a
                // bare "hundred" OPENING a number is the spoken "a hundred"
                // with the article dropped by the model — read it as 100.
                if (tensOnes === 0) {
                    if (consumedAny) break;
                    hundreds = 100;
                } else {
                    hundreds = tensOnes * 100;
                }
                tensOnes = 0;
                lastKind = 'hundred';
            } else {
                // thousand / million / billion close out the current group.
                const base = total + groupValue() === 0 ? 1 : total + groupValue();
                total = base * scale;
                hundreds = 0;
                tensOnes = 0;
                lastKind = 'none';
            }
            consumedAny = true;
            i++;
            continue;
        }

        break;
    }

    if (!consumedAny) return null;
    const value = total + groupValue();
    if (value > MAX_CARDINAL) return null;
    return { value, next: i };
}

// ---------------------------------------------------------------------------
// Tokenizer — splits into word / space / other so transforms can operate on a
// word stream while preserving original whitespace and punctuation.
// ---------------------------------------------------------------------------

type Token =
    | { type: 'word'; value: string }
    | { type: 'space'; value: string }
    | { type: 'other'; value: string };

function tokenize(text: string): Token[] {
    const tokens: Token[] = [];
    const re = /([A-Za-z']+)|([ \t]+)|(\n+)|([^A-Za-z'\n \t]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        if (m[1] !== undefined) tokens.push({ type: 'word', value: m[1] });
        else if (m[2] !== undefined) tokens.push({ type: 'space', value: m[2] });
        else if (m[3] !== undefined) tokens.push({ type: 'other', value: m[3] });
        else if (m[4] !== undefined) tokens.push({ type: 'other', value: m[4] });
    }
    return tokens;
}

function detokenize(tokens: Token[]): string {
    return tokens.map(t => t.value).join('');
}

/**
 * Starting at token index `start` (which must be a word), collect the lowercased
 * word values, stopping at the first non-word token that is not a single
 * connecting space or a bare hyphen. Returns the list and a map from
 * list-index → token index.
 *
 * The hyphen counts as a connector because compound numbers are dictated (and
 * often transcribed) hyphenated: without it, "twenty-four" parsed as just
 * "twenty" and the cardinal pass produced the hybrid "20-four" (real
 * dictation, 2026-08-31). Spans that don't parse as numbers are untouched, so
 * ordinary hyphenated words ("check-in") are unaffected.
 */
function collectWords(tokens: Token[], start: number): { list: string[]; map: number[] } {
    const list: string[] = [];
    const map: number[] = [];
    let i = start;
    let expectWord = true;
    while (i < tokens.length) {
        const t = tokens[i];
        if (expectWord) {
            if (t.type === 'word') {
                list.push(t.value.toLowerCase());
                map.push(i);
                expectWord = false;
                i++;
            } else {
                break;
            }
        } else {
            if (t.type === 'space' || (t.type === 'other' && t.value === '-')) {
                expectWord = true;
                i++;
            } else {
                break;
            }
        }
    }
    return { list, map };
}

/** Index of the next 'word' token at or after `from`; -1 if punctuation/end first. */
function nextWordTokenIndex(tokens: Token[], from: number): number {
    for (let i = from; i < tokens.length; i++) {
        if (tokens[i].type === 'word') return i;
        if (tokens[i].type === 'other') return -1; // punctuation breaks a span
    }
    return -1;
}

// ---------------------------------------------------------------------------
// Transform 1: Spoken punctuation commands
// ---------------------------------------------------------------------------

// Attached punctuation binds to the preceding word (no leading space). Ordered
// so multi-word forms ("full stop") are tried before single words.
const ATTACHED_PUNCT: Array<[RegExp, string]> = [
    [/\bfull stop\b/gi, '.'],
    [/\bquestion mark\b/gi, '?'],
    [/\bexclamation mark\b/gi, '!'],
    [/\bexclamation point\b/gi, '!'],
    [/\bsemicolon\b/gi, ';'],
    [/\bsemi colon\b/gi, ';'],
    [/\bcomma\b/gi, ','],
    [/\bperiod\b/gi, '.'],
    [/\bcolon\b/gi, ':'],
];

// Line-break commands absorb punctuation the ASR attached to the SPOKEN
// command itself ("…thing. New line. I added" — the period after "line"
// belongs to the command, not the text) — otherwise it survives as a stray
// "." or "," at the start of the new line. Punctuation BEFORE the command is
// kept: it legitimately ends the previous sentence.
const NEWLINE_PUNCT: Array<[RegExp, string]> = [
    [/\bnew paragraph\b[ \t]*[.,;:!?]*/gi, '\n\n'],
    [/\bnew line\b[ \t]*[.,;:!?]*/gi, '\n'],
    [/\bnewline\b[ \t]*[.,;:!?]*/gi, '\n'],
];

// Sentinels for quote sides (control chars that never appear in transcripts).
const OPEN_Q = '\u0001';
const CLOSE_Q = '\u0002';

/**
 * Convert spoken punctuation commands to symbols.
 *
 * Conservative rules:
 *  - Only convert standalone words (whole-word match via \b).
 *  - Attached punctuation (, . ? ! : ;) binds to the preceding word with no
 *    leading space: "hello comma" → "hello,".
 *  - Opening delimiters attach to the following token, closing to the preceding.
 */
function applyPunctuation(text: string): string {
    let out = text;

    // Paragraph / line breaks first so surrounding spaces collapse cleanly.
    for (const [re, sym] of NEWLINE_PUNCT) out = out.replace(re, sym);

    // Attached trailing punctuation.
    for (const [re, sym] of ATTACHED_PUNCT) out = out.replace(re, sym);

    // Paired / inline punctuation.
    out = out.replace(/\bopen paren(?:thesis)?\b/gi, '(');
    out = out.replace(/\bclose paren(?:thesis)?\b/gi, ')');
    out = out.replace(/\bopen quote\b/gi, OPEN_Q);
    out = out.replace(/\bclose quote\b/gi, CLOSE_Q);
    out = out.replace(/\bhyphen\b/gi, '-');
    out = out.replace(/\bdash\b/gi, '-');

    // --- Spacing tidy-up (only touches spaces ITN may have introduced) ---
    out = out.replace(/[ \t]+([,.;:!?])/g, '$1');       // space before attached punct
    out = out.replace(/\(\s+/g, '(');                    // "( word" → "(word"
    out = out.replace(/\s+\)/g, ')');                    // "word )" → "word)"
    out = out.replace(new RegExp(`${OPEN_Q}[ \\t]+`, 'g'), '"');  // opening quote
    out = out.replace(new RegExp(`[ \\t]+${CLOSE_Q}`, 'g'), '"'); // closing quote
    out = out.replace(new RegExp(`[${OPEN_Q}${CLOSE_Q}]`, 'g'), '"'); // any leftover

    // Trim spaces around inserted newlines; collapse 3+ newlines to a paragraph.
    out = out.replace(/[ \t]+\n/g, '\n');
    out = out.replace(/\n[ \t]+/g, '\n');
    out = out.replace(/\n{3,}/g, '\n\n');

    return out;
}

// ---------------------------------------------------------------------------
// Transform: Spelled-out acronyms  (run before times, so "9 A M" → "9 AM"
// still reads as a time afterwards)
// ---------------------------------------------------------------------------

/**
 * Collapse a run of spoken single letters into one acronym:
 *   "V C" → "VC", "C F O" → "CFO", "U S A" → "USA", "A I" → "AI".
 *
 * The model writes a spelled letter as an isolated capital, so mid-sentence
 * runs of two or more single capitals are letters the user dictated one by
 * one — "the V C fund", "our C F O said" (real dictation, 2026-08-31). Only
 * bare capitals separated by single spaces collapse; letters written with
 * periods ("B. D.") are left alone because a period after a single capital
 * can end a sentence ("...went with plan B. Development starts Monday").
 * Trailing possessives survive: "the C E O's call" → "the CEO's call".
 */
function applyAcronyms(text: string): string {
    return text.replace(
        /(?<![A-Za-z0-9])[A-Z](?: [A-Z])+(?![A-Za-z0-9])/g,
        (m) => m.replace(/ /g, ''),
    );
}

// ---------------------------------------------------------------------------
// Transform: Letter-number designators  (run after acronyms)
// ---------------------------------------------------------------------------

/**
 * "C five" → "C5", "T six" → "T6", "B twelve" → "B12": a spoken single letter
 * followed by a spoken small number is a designator — versions, models,
 * vitamins, gates — dictated letter-then-number and transcribed as an
 * isolated capital plus a number word ("C five and C six" should read
 * "C5 and C6"; real dictation, 2026-08-31).
 *
 * Guards: A and I are excluded (article and pronoun — "A five minute break"
 * must survive), the letter must be a bare capital, and a scale word after
 * the number vetoes the join, so "vitamin C five hundred milligrams" keeps
 * its quantity (and still becomes "vitamin C 500 milligrams" downstream).
 */
function applyLetterNumbers(text: string): string {
    const numAlt = Object.keys(ONES).join('|');
    const scaleAlt = Object.keys(SCALES).join('|');
    const re = new RegExp(
        `(?<![A-Za-z0-9])([B-HJ-Z]) ((?:${numAlt})|\\d{1,4})(?![A-Za-z0-9])(?![ -](?:${scaleAlt})\\b)`,
        'g'
    );
    return text.replace(re, (_m, letter: string, num: string) => {
        const v = /^\d+$/.test(num) ? num : String(ONES[num]);
        return `${letter}${v}`;
    });
}

/**
 * Multiplier suffix: "20 X" → "20X", "33 X" → "33X" ("the flat 20 X is really
 * interesting", real dictation 2026-09-01 — leverage multiples are written
 * with the X attached). Runs after cardinals, so a spelled "twenty X" has
 * already become "20 X". Only a lone capital X directly after digits.
 */
function applyMultiplierX(text: string): string {
    return text.replace(/(?<![A-Za-z0-9.])(\d+(?:\.\d+)?) X(?![A-Za-z0-9])/g, '$1X');
}

// ---------------------------------------------------------------------------
// Transform 2: Currency  (run before plain cardinals)
// ---------------------------------------------------------------------------

const CURRENCY_UNITS: Record<string, { symbol: string; fractional: string[] }> = {
    dollar: { symbol: '$', fractional: ['cent', 'cents'] },
    dollars: { symbol: '$', fractional: ['cent', 'cents'] },
    euro: { symbol: '€', fractional: ['cent', 'cents'] },
    euros: { symbol: '€', fractional: ['cent', 'cents'] },
    pound: { symbol: '£', fractional: ['pence', 'penny', 'p'] },
    pounds: { symbol: '£', fractional: ['pence', 'penny', 'p'] },
};

/**
 * "five dollars" → "$5", "ten euros" → "€10",
 * "five dollars and fifty cents" → "$5.50".
 * Requires a spelled-out number immediately before the currency unit, so a bare
 * "dollars" noun is never touched.
 */
function applyCurrency(text: string): string {
    const tokens = tokenize(text);
    const out: Token[] = [];
    let i = 0;

    while (i < tokens.length) {
        const tok = tokens[i];
        if (tok.type !== 'word') { out.push(tok); i++; continue; }

        const words = collectWords(tokens, i);
        const parsed = parseCardinal(words.list, 0);
        if (parsed && parsed.next > 0) {
            const numEndTokenIdx = words.map[parsed.next - 1] + 1;
            const unitIdx = nextWordTokenIndex(tokens, numEndTokenIdx);
            const unitTok = unitIdx >= 0 ? tokens[unitIdx] : null;
            const unitKey = unitTok ? unitTok.value.toLowerCase() : '';

            if (unitTok && has(CURRENCY_UNITS, unitKey)) {
                const cfg = CURRENCY_UNITS[unitKey];
                let amount = `${parsed.value}`;
                let consumeUntil = unitIdx;

                // Optional "... and <N> cents/pence".
                const afterUnit = nextWordTokenIndex(tokens, unitIdx + 1);
                if (afterUnit >= 0 && tokens[afterUnit].value.toLowerCase() === 'and') {
                    const fracNumStart = nextWordTokenIndex(tokens, afterUnit + 1);
                    if (fracNumStart >= 0) {
                        const fracWords = collectWords(tokens, fracNumStart);
                        const fracParsed = parseCardinal(fracWords.list, 0);
                        if (fracParsed && fracParsed.value >= 0 && fracParsed.value < 100) {
                            const fracEndTokenIdx = fracWords.map[fracParsed.next - 1] + 1;
                            const fracUnitIdx = nextWordTokenIndex(tokens, fracEndTokenIdx);
                            const fracUnitKey = fracUnitIdx >= 0 ? tokens[fracUnitIdx].value.toLowerCase() : '';
                            if (fracUnitIdx >= 0 && cfg.fractional.includes(fracUnitKey)) {
                                amount = `${parsed.value}.${String(fracParsed.value).padStart(2, '0')}`;
                                consumeUntil = fracUnitIdx;
                            }
                        }
                    }
                }

                out.push({ type: 'word', value: `${cfg.symbol}${amount}` });
                i = consumeUntil + 1;
                continue;
            }
        }

        out.push(tok);
        i++;
    }

    return detokenize(out);
}

// ---------------------------------------------------------------------------
// Transform 3: Times  (run before plain cardinals)
// ---------------------------------------------------------------------------

const HOUR_WORDS: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
    seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

// Minute components. The model writes a spoken minute in ANY mix of words
// and digits — "twenty six", "20 6", "twenty 6", "26" were all seen for the
// same utterance — so tens and ones are matched as separate components and
// summed, instead of listing fixed phrases.
const MINUTE_TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50 };

/** "twenty six" / "20 6" / "twenty 6" / "oh five" / "26" → 0..59, else null. */
function parseMinute(raw: string): number | null {
    const m = raw.toLowerCase().replace(/[ -]+/g, ' ').trim();
    if (m === "o'clock" || m === 'oclock') return 0;

    const part = (w: string): number | null => {
        if (/^\d{1,2}$/.test(w)) return parseInt(w, 10);
        if (has(MINUTE_TENS, w)) return MINUTE_TENS[w];
        if (has(ONES, w)) return ONES[w];
        return null;
    };

    const words = m.split(' ');
    if (words.length === 1) {
        const v = part(words[0]);
        return v !== null && v >= 0 && v <= 59 ? v : null;
    }
    if (words.length === 2) {
        // "oh five" → 05 (the spoken leading zero).
        if (words[0] === 'oh' || words[0] === 'o') {
            const v = part(words[1]);
            return v !== null && v >= 0 && v <= 9 ? v : null;
        }
        // tens + ones, each independently a word or a digit.
        const t = part(words[0]);
        const o = part(words[1]);
        if (t !== null && o !== null && t >= 20 && t <= 50 && t % 10 === 0 && o >= 1 && o <= 9) {
            return t + o;
        }
    }
    return null;
}

/**
 * "two thirty pm" → "2:30 PM", "nine am" → "9 AM", "eight 20 6 AM" → "8:26 AM".
 * Only fires when a recognizable am/pm marker follows, which disambiguates a
 * time from a plain number. The hour may be a word or a digit, and the minute
 * may arrive as one chunk or as tens+ones in any word/digit mix — "eight
 * twenty six AM", "eight 20 6 AM", and "8:26 AM" all mean the same dictation
 * (the middle one verbatim from real use, 2026-08-31).
 *
 * The meridiem allows a space between its letters ("A. M.", "a m") — the
 * model frequently writes the spoken letters that way, and without it
 * "eight A. M." survived untouched (real dictation, 2026-08-31).
 */
// Words that legitimately follow a time CAPITALIZED without starting a new
// sentence — "9 AM Monday", "8 PM Eastern" — so a meridiem dot before them
// is abbreviation style, not a sentence ending.
const TIME_CONTINUATIONS = new Set([
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    ...Object.keys(MONTHS),
    'est', 'edt', 'cst', 'cdt', 'mst', 'mdt', 'pst', 'pdt', 'utc', 'gmt',
    'eastern', 'central', 'mountain', 'pacific',
]);

/**
 * The period a converted meridiem should carry, if any. The model writes
 * "a.m." / "A. M." with a trailing dot that does DOUBLE DUTY as the sentence
 * period — consuming it blindly produced the run-on "…around 9:17 AM I found
 * that…" (verbatim from real dictation, 2026-08-31). Keep a period when the
 * matched meridiem ended with a dot AND a capitalized new sentence follows;
 * a lowercase continuation, end-of-text, other punctuation, or a day/month/
 * timezone word means the dot was just abbreviation style.
 */
function meridiemPeriod(merRaw: string, after: string): string {
    if (!/\.$/.test(merRaw)) return '';
    const next = after.match(/^[ \t]+([A-Za-z']+)/);
    if (!next || !/^[A-Z]/.test(next[1])) return '';
    if (TIME_CONTINUATIONS.has(next[1].toLowerCase())) return '';
    return '.';
}

/** Regex alternation for a spoken/mixed minute — longest alternatives first
 *  so "twenty six" wins over bare "twenty". Shared with the truncated-meridiem
 *  rule below. */
function minuteAltPattern(): string {
    const tensAlt = `(?:${Object.keys(MINUTE_TENS).join('|')}|[2-5]0)`;
    const onesAlt = `(?:${Object.keys(ONES).filter(w => ONES[w] >= 1 && ONES[w] <= 9).join('|')}|[1-9])`;
    const teenAlt = Object.keys(ONES).filter(w => ONES[w] >= 10).join('|');
    return `o'?clock|oh[ -]${onesAlt}|${tensAlt}[ -]${onesAlt}|${tensAlt}|${teenAlt}|[0-5]?\\d`;
}

function applyTimes(text: string): string {
    const hourAlt = Object.keys(HOUR_WORDS).join('|');
    const minuteAlt = minuteAltPattern();
    const re = new RegExp(
        `\\b(\\d{1,2}|${hourAlt})` +
        `(?:[ -]+(${minuteAlt}))?` +
        `[ ]+(a\\.? ?m\\.?|p\\.? ?m\\.?)(?=$|[^a-zA-Z])`,
        'gi'
    );

    return text.replace(re, (match, hourRaw: string, minRaw: string | undefined, mer: string, offset: number, whole: string) => {
        const hourLower = hourRaw.toLowerCase();
        let hour: number;
        if (/^\d+$/.test(hourLower)) hour = parseInt(hourLower, 10);
        else if (HOUR_WORDS[hourLower] !== undefined) hour = HOUR_WORDS[hourLower];
        else return match;
        if (hour < 1 || hour > 12) return match;

        const meridiem = mer.replace(/[. ]/g, '').toUpperCase(); // AM / PM
        const period = meridiemPeriod(mer, whole.slice(offset + match.length));

        let minute: number | null = null;
        if (minRaw) {
            minute = parseMinute(minRaw);
            if (minute === null) return match;
        }

        if (minute === null || minute === 0) return `${hour} ${meridiem}${period}`;
        return `${hour}:${String(minute).padStart(2, '0')} ${meridiem}${period}`;
    });
}

/**
 * Truncated meridiem — run right after applyTimes, which has already consumed
 * every complete one. The model sometimes loses the trailing "M" of a spoken
 * "AM"/"PM" at the end of an utterance: "...coffee at eight thirty A."
 * (verbatim from real dictation, 2026-08-31). With MINUTES present, an hour
 * followed by a lone capital A or P at a word boundary can only be a clipped
 * meridiem, so finish the job: "eight thirty A." → "8:30 AM".
 *
 * Two guards keep this conservative: the letter must be a CAPITAL (a
 * lowercase "a" is an article — "eight thirty a day" must survive), and
 * minutes are required (so "gate eight A" is untouched).
 */
function applyTruncatedMeridiem(text: string): string {
    const hourAlt = Object.keys(HOUR_WORDS).join('|');
    const re = new RegExp(
        `\\b(\\d{1,2}|${hourAlt})[ -]+(${minuteAltPattern()})[ ]+([AaPp])\\.?(?=$|[^A-Za-z0-9])`,
        'gi'
    );
    return text.replace(re, (match, hourRaw: string, minRaw: string, letter: string, offset: number, whole: string) => {
        if (letter !== 'A' && letter !== 'P') return match; // capitals only
        const hourLower = hourRaw.toLowerCase();
        let hour: number;
        if (/^\d+$/.test(hourLower)) hour = parseInt(hourLower, 10);
        else if (HOUR_WORDS[hourLower] !== undefined) hour = HOUR_WORDS[hourLower];
        else return match;
        if (hour < 1 || hour > 12) return match;
        const minute = parseMinute(minRaw);
        if (minute === null) return match;
        const meridiem = letter === 'A' ? 'AM' : 'PM';
        const period = meridiemPeriod(match, whole.slice(offset + match.length));
        if (minute === 0) return `${hour} ${meridiem}${period}`;
        return `${hour}:${String(minute).padStart(2, '0')} ${meridiem}${period}`;
    });
}

// ---------------------------------------------------------------------------
// Transform 4: Dates  (conservative)
// ---------------------------------------------------------------------------

/** Convert an ordinal word/phrase or ordinal-digit string to its number. */
function resolveOrdinalToNumber(raw: string): number | null {
    const s = raw.toLowerCase().trim();
    const digitMatch = s.match(/^(\d{1,2})(?:st|nd|rd|th)?$/);
    if (digitMatch) return parseInt(digitMatch[1], 10);

    const parts = s.split(/[- ]+/);
    if (parts.length === 2 && TENS_PREFIX_FOR_ORDINAL[parts[0]] !== undefined && ORDINAL_WORDS[parts[1]] !== undefined) {
        return TENS_PREFIX_FOR_ORDINAL[parts[0]] + ORDINAL_WORDS[parts[1]];
    }
    if (ORDINAL_WORDS[s] !== undefined) return ORDINAL_WORDS[s];
    return null;
}

/**
 * "january fifth" → "January 5", "the third of may" → "May 3".
 * Only the two clear shapes are handled. Year handling is omitted to stay
 * conservative.
 */
function applyDates(text: string): string {
    const monthAlt = Object.keys(MONTHS).join('|');
    const ordAlt = Object.keys(ORDINAL_WORDS).join('|');
    const tensAlt = Object.keys(TENS_PREFIX_FOR_ORDINAL).join('|');
    // A spoken day: simple ordinal, compound ordinal ("twenty-first"), or digit.
    const daySpoken = `(?:(?:${tensAlt})[- ])?(?:${ordAlt})|\\d{1,2}(?:st|nd|rd|th)?`;

    let out = text;

    // Shape A: "<month> <day>"  e.g. "january fifth", "may 3rd".
    const reA = new RegExp(`\\b(${monthAlt})\\s+(${daySpoken})\\b`, 'gi');
    out = out.replace(reA, (match, month: string, dayRaw: string) => {
        const day = resolveOrdinalToNumber(dayRaw);
        if (day === null || day < 1 || day > 31) return match;
        return `${MONTHS[month.toLowerCase()]} ${day}`;
    });

    // Shape B: "the <day> of <month>"  e.g. "the third of may".
    const reB = new RegExp(`\\bthe\\s+(${daySpoken})\\s+of\\s+(${monthAlt})\\b`, 'gi');
    out = out.replace(reB, (match, dayRaw: string, month: string) => {
        const day = resolveOrdinalToNumber(dayRaw);
        if (day === null || day < 1 || day > 31) return match;
        return `${MONTHS[month.toLowerCase()]} ${day}`;
    });

    return out;
}

// ---------------------------------------------------------------------------
// Transform: Years  (run before ordinals/cardinals)
// ---------------------------------------------------------------------------

/**
 * Spoken year pairs → four-digit years:
 *   "twenty twenty six"    → "2026"
 *   "nineteen eighty four" → "1984"
 *   "twenty nineteen"      → "2019"
 *
 * Without this, applyCardinals converts each half separately and produces the
 * hybrid "20 26" (real dictation, 2026-08-31). Conservative by shape: only
 * the two century words that yield a plausible year (nineteen, twenty) can
 * lead the pair, the second half must itself be a spoken 10–99, and a scale
 * word after the pair vetoes it ("twenty twenty thousand" is not a year).
 * Plain "twenty six" (26) never matches — it has no century word.
 */
function applyYears(text: string): string {
    const teensAlt = Object.keys(ONES).filter(w => ONES[w] >= 10).join('|');
    const tensAlt = Object.keys(TENS).join('|');
    const onesAlt = Object.keys(ONES).filter(w => ONES[w] >= 1 && ONES[w] <= 9).join('|');
    const secondHalf = `(?:${tensAlt})(?:[ -](?:${onesAlt}))?|(?:${teensAlt})`;
    const scaleAlt = Object.keys(SCALES).join('|');
    const re = new RegExp(
        `\\b(nineteen|twenty) (${secondHalf})\\b(?![ -](?:${scaleAlt}))`,
        'gi'
    );
    return text.replace(re, (match, century: string, rest: string) => {
        const parsed = parseCardinal(rest.toLowerCase().split(/[ -]+/), 0);
        if (!parsed || parsed.value < 10 || parsed.value > 99) return match;
        return `${(century.toLowerCase() === 'nineteen' ? 1900 : 2000) + parsed.value}`;
    });
}

// ---------------------------------------------------------------------------
// Transform: Decimals  (run after years, before cardinals)
// ---------------------------------------------------------------------------

/**
 * "<number> point <digits>" → a decimal, whatever mix of words and digits the
 * model chose: "10 point six" (verbatim from real dictation, 2026-08-31),
 * "ten point six", "ten point 6" all → "10.6"; "three point one four" →
 * "3.14"; "nine point oh five" → "9.05"; "ten point sixty five" → "10.65".
 *
 * Conservative: a NUMBER must sit immediately before "point" ("at that point
 * six people left" has "that" there and never matches) and a digit value
 * immediately after ("the ten point plan" has "plan" there and never
 * matches). Runs after applyYears so "nineteen ninety point five" reads the
 * year first.
 */
function applyDecimals(text: string): string {
    const onesW = Object.keys(ONES).filter(w => ONES[w] <= 9);        // zero..nine
    const teensW = Object.keys(ONES).filter(w => ONES[w] >= 10);      // ten..nineteen
    const tensW = Object.keys(TENS);
    const digitAlt = `(?:${onesW.join('|')}|oh|\\d)`;
    const intAlt = `\\d+|(?:${tensW.join('|')})(?:[ -](?:${onesW.join('|')}))?|${teensW.join('|')}|${onesW.join('|')}`;
    const fracAlt = `(?:${tensW.join('|')})[ -](?:${onesW.join('|')})|(?:${tensW.join('|')})|${teensW.join('|')}|${digitAlt}(?:[ ]${digitAlt})*`;
    const re = new RegExp(`\\b(${intAlt}) point (${fracAlt})\\b`, 'gi');

    const partValue = (w: string): number | null => {
        if (w === 'oh') return 0;
        if (/^\d+$/.test(w)) return parseInt(w, 10);
        if (has(ONES, w)) return ONES[w];
        if (has(TENS, w)) return TENS[w];
        return null;
    };

    return text.replace(re, (match, intRaw: string, fracRaw: string) => {
        // Integer part: digits verbatim, or spelled 0..99.
        let intPart: string;
        if (/^\d+$/.test(intRaw)) {
            intPart = intRaw;
        } else {
            const words = intRaw.toLowerCase().split(/[ -]+/);
            const v0 = partValue(words[0]);
            if (v0 === null) return match;
            if (words.length === 1) intPart = String(v0);
            else {
                const v1 = partValue(words[1]);
                if (v1 === null || !has(TENS, words[0])) return match;
                intPart = String(v0 + v1);
            }
        }

        // Fraction part: a compound value ("sixty five" → 65, "twelve" → 12)
        // or a run of single digits read out ("one four" → 14, "oh five" → 05).
        const fw = fracRaw.toLowerCase().split(/[ -]+/);
        let fracPart: string;
        if (fw.length === 2 && has(TENS, fw[0]) && partValue(fw[1]) !== null && partValue(fw[1])! <= 9) {
            fracPart = String(TENS[fw[0]] + partValue(fw[1])!);
        } else if (fw.length === 1 && partValue(fw[0]) !== null && partValue(fw[0])! >= 10) {
            fracPart = String(partValue(fw[0]));
        } else {
            const digits = fw.map(w => (w === 'oh' ? 0 : /^\d$/.test(w) ? parseInt(w, 10) : has(ONES, w) && ONES[w] <= 9 ? ONES[w] : null));
            if (digits.some(d => d === null)) return match;
            fracPart = digits.join('');
        }

        return `${intPart}.${fracPart}`;
    });
}

// ---------------------------------------------------------------------------
// Transform 5: Ordinals  (standalone)
// ---------------------------------------------------------------------------

/**
 * Below this, a spoken ordinal stays a WORD: "first", not "1st".
 *
 * This mirrors the rule this file already applies to cardinals — a standalone
 * "five" stays spelled out, only "fifteen" and up become digits — and it is
 * the ordinary English convention (spell out below ten in running prose).
 * Ordinals were the inconsistent one: every ordinal converted, so ordinary
 * sentences came out wrong, most visibly the enumerating adverb that opens a
 * sentence:
 *   "First, let's make sure it's done"  →  "1st, let's make sure it's done"
 *   "it should write out first"         →  "it should write out 1st"
 * Both verbatim from real dictation, 2026-08-10. Idioms were hit just as
 * hard — "first of all", "at first", "second to none", "third party",
 * "first name" — and no list of idioms would have covered them, because the
 * word is fine and it is the NUMERAL that is wrong in prose.
 *
 * Dates are unaffected: applyDates runs first and consumes "january fifth"
 * → "January 5" before this transform sees it.
 */
const ORDINAL_NUMERAL_MIN = 10;

/**
 * Nouns that make even a small ordinal numeric — addresses and numbered
 * series, where "3rd floor" and "5th Avenue" are the normal written forms.
 * Deliberately short: per design principle #1 a missed conversion is cheaper
 * than a wrong one, so genuinely ambiguous nouns ("place", "quarter",
 * "period", "century") are left off and stay spelled out.
 */
const ORDINAL_NUMERIC_CONTEXT = new Set([
    'avenue', 'street', 'boulevard', 'floor',
    'anniversary', 'birthday', 'edition', 'grade', 'amendment',
]);

/**
 * Before an ordinal these force the FRACTION reading, where a numeral is
 * wrong: "a tenth of the budget" is not "a 10th of the budget". Only matters
 * at or above ORDINAL_NUMERAL_MIN — smaller ordinals ("a fifth", "one third")
 * already stay spelled out. "the tenth time" is unaffected.
 */
const ORDINAL_FRACTION_PRECEDERS = new Set(['a', 'an', 'one']);

/**
 * Fixed phrases where the ordinal is idiom, not position, and must stay a
 * word at ANY value: "at the eleventh hour" means at the last moment, so
 * "the 11th hour" is wrong. Keyed by the word that follows the ordinal.
 *
 * This is not an attempt at general idiom coverage — spelling out below ten
 * already handles almost all of them ("first of all", "second to none",
 * "third party"). This set exists only for the few that survive that rule by
 * being ten or above, and today that is one.
 */
const ORDINAL_IDIOM_FOLLOWERS: Record<string, Set<string>> = {
    hour: new Set(['eleventh']),
};

/**
 * "twenty-second" → "22nd", "thirtieth" → "30th"; "first" stays "first".
 * Compound ordinals are matched as a unit. Conservative: only known ordinals,
 * and only where a numeral is the normal written form (ORDINAL_NUMERAL_MIN).
 */
function applyOrdinals(text: string): string {
    const ordAlt = Object.keys(ORDINAL_WORDS).join('|');
    const tensAlt = Object.keys(TENS_PREFIX_FOR_ORDINAL).join('|');

    // Compound first: "twenty second", "thirty-first".
    const reCompound = new RegExp(`\\b(${tensAlt})[- ](${ordAlt})\\b`, 'gi');
    let out = text.replace(reCompound, (match, tens: string, ord: string) => {
        const t = TENS_PREFIX_FOR_ORDINAL[tens.toLowerCase()];
        const o = ORDINAL_WORDS[ord.toLowerCase()];
        if (o >= 1 && o <= 9) {
            const n = t + o;
            return `${n}${ordinalSuffix(n)}`;
        }
        return match;
    });

    // Simple ordinals.
    // "second" is the one ordinal that doubles as a TIME UNIT. Leave it alone
    // in duration contexts — "tokens per second", "give me a second", "one
    // second" — where "2nd" would be wrong. Ordinal readings ("the second
    // option", "second place") still convert. Per design principle #1
    // (CONSERVATIVE), the ambiguous "a second X" stays unconverted.
    // A COUNT before "second" makes it a unit of time, not a position: "five
    // second recording" is a duration, and turning it into "five 2nd recording"
    // is nonsense. This missed real dictations ("a quick five second
    // recording", "a fifteen second recording") because the guard was a short
    // literal list. Any cardinal — spelled or already digitised by an earlier
    // ITN pass — now counts.
    const SECOND_DURATION_PRECEDERS = new Set(['per', 'a', 'an', 'every', 'each']);
    const isCount = (w: string): boolean =>
        /^\d+$/.test(w) || w in ONES || w in TENS || w in SCALES;
    const reSimple = new RegExp(`\\b(${ordAlt})\\b`, 'gi');
    out = out.replace(reSimple, (match, ord: string, offset: number, whole: string) => {
        const n = ORDINAL_WORDS[ord.toLowerCase()];
        if (n === undefined) return match;

        const before = whole.slice(0, offset).trimEnd();
        const prevWord = before.slice(before.lastIndexOf(' ') + 1).toLowerCase()
            .replace(/^[^\w]+|[^\w]+$/g, '');

        if (ord.toLowerCase() === 'second') {
            // Kept even though 2 is below ORDINAL_NUMERAL_MIN so this path can
            // no longer fire: it records a real bug ("five second recording"
            // → "five 2nd recording") and must survive any future lowering of
            // the threshold.
            if (SECOND_DURATION_PRECEDERS.has(prevWord) || isCount(prevWord)) return match;
        }

        const after = whole.slice(offset + match.length).trimStart();
        const nextWord = after.split(/[^\w]+/, 1)[0].toLowerCase();

        if (ORDINAL_IDIOM_FOLLOWERS[nextWord]?.has(ord.toLowerCase())) return match;

        if (n < ORDINAL_NUMERAL_MIN) {
            // Spelled out in prose — unless an address/series noun follows,
            // where the numeral IS the written form ("3rd floor").
            if (!ORDINAL_NUMERIC_CONTEXT.has(nextWord)) return match;
        } else if (ORDINAL_FRACTION_PRECEDERS.has(prevWord)) {
            return match; // "a tenth of the budget", not "a 10th"
        }

        return `${n}${ordinalSuffix(n)}`;
    });

    return out;
}

// ---------------------------------------------------------------------------
// Transform 6: Cardinal numbers  (run last among numerics)
// ---------------------------------------------------------------------------

/**
 * Multi-word cardinals → digits. Single ambiguous words ("one", "a") are left
 * alone to avoid corrupting prose ("one of the"). Conversion happens for spans
 * of 2+ number words, OR a single unambiguously-numeric word (ten..nineteen,
 * twenty..ninety).
 */
function applyCardinals(text: string): string {
    const tokens = tokenize(text);
    const out: Token[] = [];
    let i = 0;

    const standaloneOk = (w: string) => (isOnes(w) && ONES[w] >= 10) || isTens(w);

    while (i < tokens.length) {
        const tok = tokens[i];
        if (tok.type !== 'word') { out.push(tok); i++; continue; }

        const words = collectWords(tokens, i);
        const parsed = parseCardinal(words.list, 0);

        if (parsed) {
            const wordsConsumed = parsed.next;
            const isMultiWord = wordsConsumed >= 2;
            const single = words.list[0];
            const allowed = isMultiWord || (wordsConsumed === 1 && standaloneOk(single));

            if (allowed) {
                const lastTokenIdx = words.map[parsed.next - 1];
                out.push({ type: 'word', value: `${parsed.value}` });
                i = lastTokenIdx + 1;
                continue;
            }
        }

        out.push(tok);
        i++;
    }

    return detokenize(out);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ITNOptions {
    /**
     * Convert spoken punctuation commands ("comma" → ",", "new line", quotes,
     * parentheses). DEFAULT FALSE, and that default is the point.
     *
     * These commands belong to the Spoken Punctuation feature, which has its
     * own setting and its own better implementation (src/utils/spokenPunctuation.ts:
     * a token walk that REPLACES punctuation the model already wrote). The
     * version here is naive regex substitution that does not, so with smart
     * formatting on and spoken punctuation off, a user who merely SAID the
     * word "period" got the model's punctuation and ours, both:
     *   "…about that time period?"  →  "…about that time.?"
     *   "…is off comma, it's still" →  "…is off,, it's still"
     * Reported from real dictation 2026-08-10. Smart formatting must mean
     * numbers, currency, times, and dates — nothing else.
     *
     * Pass true only when the Spoken Punctuation setting is on; it then adds
     * the forms the token walk lacks (parentheses, quotes, "dash").
     */
    punctuation?: boolean;
}

/**
 * Apply Inverse Text Normalization to a transcript.
 *
 * Order matters:
 *   1. Punctuation commands — ONLY with opts.punctuation (see ITNOptions).
 *   2. Acronyms  (collapses "C F O" before anything else reads the letters).
 *   3. Currency  (consumes "<n> dollars" before cardinals touch "<n>").
 *   4. Times     (consumes "<n> <n> am" before cardinals).
 *   5. Dates     (consumes "<month> <ordinal>" before ordinals/cardinals).
 *   6. Years     (consumes "twenty twenty six" before cardinals split it).
 *   7. Ordinals  ("first" → "1st").
 *   8. Cardinals ("twenty three" → "23").
 *
 * Idempotent and conservative: already-written text returns unchanged, and
 * applying twice equals applying once.
 */
export function applyITN(text: string, opts: ITNOptions = {}): string {
    if (!text || text.trim().length === 0) return text;

    let out = text;
    // Punctuation commands belong to the SPOKEN PUNCTUATION feature, not to
    // smart formatting — see ITNOptions. Off unless the caller opts in.
    if (opts.punctuation) out = applyPunctuation(out);
    out = applyAcronyms(out);
    out = applyLetterNumbers(out);
    out = applyCurrency(out);
    out = applyTimes(out);
    out = applyTruncatedMeridiem(out);
    out = applyDates(out);
    out = applyYears(out);
    out = applyDecimals(out);
    out = applyOrdinals(out);
    out = applyCardinals(out);
    out = applyPercent(out);
    out = applyMultiplierX(out);
    out = applyDigitGrouping(out);

    // Final light spacing tidy (mirrors only spaces ITN may have introduced).
    out = out.replace(/[ \t]+([,.;:!?])/g, '$1');
    out = out.replace(/[ \t]{2,}/g, ' ');

    return out;
}

// ---------------------------------------------------------------------------
// Transform: Percent  (runs after cardinals, so the number is already digits)
// ---------------------------------------------------------------------------

/**
 * "80 percent" → "80%", "eighty point six percent" → "80.6%", "five percent"
 * → "5%". Runs after the cardinal and decimal passes, so any spelled number
 * ten and up is already digits; the spelled 0–9 that the under-ten rule
 * leaves as words are converted here, because a percentage is always
 * written numerically. Surrounding punctuation is untouched: "80 percent."
 * → "80%.", "80 percent, and" → "80%, and". "percentage" never matches
 * (word boundary), and a bare "percent" with no number before it stays.
 */
function applyPercent(text: string): string {
    const smallAlt = Object.keys(ONES).filter(w => ONES[w] <= 9).join('|');
    const re = new RegExp(`\\b(\\d[\\d,]*(?:\\.\\d+)?|${smallAlt}) per ?cent\\b`, 'gi');
    return text.replace(re, (_m, num: string) => {
        const n = /^\d/.test(num) ? num : String(ONES[num.toLowerCase()]);
        return `${n}%`;
    });
}

// ---------------------------------------------------------------------------
// Transform 7: Thousands separators  (runs LAST — covers both digits the
// transforms above emitted AND digits the ASR model wrote directly)
// ---------------------------------------------------------------------------

/** "50000000" → "50,000,000" */
function groupDigits(digits: string): string {
    return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Insert thousands separators into large plain integers:
 *   "$50000000"  → "$50,000,000"   (currency: grouped from 4 digits up — the
 *                                    symbol makes "quantity" unambiguous)
 *   "5000000"    → "5,000,000"     (bare: grouped from 6 digits up — 4-5 digit
 *                                    runs stay untouched because they're often
 *                                    years, PINs, ZIP codes, or spoken digit
 *                                    strings like "12345")
 *   "3.1415926"  → unchanged        (never groups a fraction)
 *   "$50000.25"  → "$50,000.25"     (integer part only)
 * Idempotent: a grouped number contains commas, so neither pattern rematches.
 */
function applyDigitGrouping(text: string): string {
    let out = text;
    // Currency-prefixed: $/€/£ then 4+ digits (not already separated, not a
    // fraction part). Lookbehind excludes digit/dot/comma so "1.5000" stays.
    out = out.replace(/([$€£])(\d{4,})(?![\d])(?!,\d)/g, (_m, sym: string, num: string) => sym + groupDigits(num));
    // Bare integers of 6+ digits standing alone.
    out = out.replace(/(?<![\d.,€£$])(\d{6,})(?![\d])(?!,\d)/g, (_m, num: string) => groupDigits(num));
    return out;
}

// Exported for unit testing of individual transforms.
export const __itnInternals = {
    applyPunctuation,
    applyAcronyms,
    applyLetterNumbers,
    applyCurrency,
    applyTimes,
    applyTruncatedMeridiem,
    applyDates,
    applyYears,
    applyDecimals,
    applyOrdinals,
    applyCardinals,
    applyPercent,
    applyMultiplierX,
    applyDigitGrouping,
    parseCardinal,
    ordinalSuffix,
};
