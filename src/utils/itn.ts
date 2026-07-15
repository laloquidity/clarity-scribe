/**
 * Inverse Text Normalization (ITN) — spoken-form → written-form
 *
 * Converts dictated spoken-form text to its written representation:
 *   - "comma"               → ","
 *   - "twenty three"        → "23"
 *   - "first"               → "1st"
 *   - "five dollars"        → "$5"
 *   - "two thirty pm"       → "2:30 PM"
 *   - "january fifth"       → "January 5"
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
                // Need a multiplier (1..99) directly before "hundred".
                if (tensOnes === 0 || hundreds !== 0) break;
                hundreds = tensOnes * 100;
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
 * connecting space. Returns the list and a map from list-index → token index.
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
            if (t.type === 'space') {
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

const MINUTE_PHRASES: Record<string, number> = {
    "o'clock": 0, oclock: 0, thirty: 30, fifteen: 15, 'forty five': 45,
};

/**
 * "two thirty pm" → "2:30 PM", "nine am" → "9 AM", "twelve fifteen pm" → "12:15 PM".
 * Only fires when a recognizable am/pm marker follows, which disambiguates a
 * time from a plain number. The hour may be a word or a digit.
 */
function applyTimes(text: string): string {
    const hourAlt = Object.keys(HOUR_WORDS).join('|');
    const re = new RegExp(
        `\\b(\\d{1,2}|${hourAlt})` +
        `(?:[ -]+(o'?clock|thirty|fifteen|forty[ -]?five|[0-5]?\\d))?` +
        `[ ]+(a\\.?m\\.?|p\\.?m\\.?)(?=$|[^a-zA-Z])`,
        'gi'
    );

    return text.replace(re, (match, hourRaw: string, minRaw: string | undefined, mer: string) => {
        const hourLower = hourRaw.toLowerCase();
        let hour: number;
        if (/^\d+$/.test(hourLower)) hour = parseInt(hourLower, 10);
        else if (HOUR_WORDS[hourLower] !== undefined) hour = HOUR_WORDS[hourLower];
        else return match;
        if (hour < 1 || hour > 12) return match;

        const meridiem = mer.replace(/\./g, '').toUpperCase(); // AM / PM

        let minute: number | null = null;
        if (minRaw) {
            const m = minRaw.toLowerCase().replace(/[ -]+/g, ' ').trim();
            if (/^\d{1,2}$/.test(m)) {
                const v = parseInt(m, 10);
                if (v >= 0 && v <= 59) minute = v;
                else return match;
            } else if (m === "o'clock" || m === 'oclock') {
                minute = 0;
            } else if (MINUTE_PHRASES[m] !== undefined) {
                minute = MINUTE_PHRASES[m];
            } else {
                return match;
            }
        }

        if (minute === null || minute === 0) return `${hour} ${meridiem}`;
        return `${hour}:${String(minute).padStart(2, '0')} ${meridiem}`;
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
// Transform 5: Ordinals  (standalone)
// ---------------------------------------------------------------------------

/**
 * "first" → "1st", "twenty-second" → "22nd", "thirtieth" → "30th".
 * Compound ordinals are matched as a unit. Conservative: only known ordinals.
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
    const reSimple = new RegExp(`\\b(${ordAlt})\\b`, 'gi');
    out = out.replace(reSimple, (match, ord: string) => {
        const n = ORDINAL_WORDS[ord.toLowerCase()];
        if (n === undefined) return match;
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

/**
 * Apply Inverse Text Normalization to a transcript.
 *
 * Order matters:
 *   1. Punctuation commands.
 *   2. Currency  (consumes "<n> dollars" before cardinals touch "<n>").
 *   3. Times     (consumes "<n> <n> am" before cardinals).
 *   4. Dates     (consumes "<month> <ordinal>" before ordinals/cardinals).
 *   5. Ordinals  ("first" → "1st").
 *   6. Cardinals ("twenty three" → "23").
 *
 * Idempotent and conservative: already-written text returns unchanged, and
 * applying twice equals applying once.
 */
export function applyITN(text: string): string {
    if (!text || text.trim().length === 0) return text;

    let out = text;
    out = applyPunctuation(out);
    out = applyCurrency(out);
    out = applyTimes(out);
    out = applyDates(out);
    out = applyOrdinals(out);
    out = applyCardinals(out);
    out = applyDigitGrouping(out);

    // Final light spacing tidy (mirrors only spaces ITN may have introduced).
    out = out.replace(/[ \t]+([,.;:!?])/g, '$1');
    out = out.replace(/[ \t]{2,}/g, ' ');

    return out;
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
    applyCurrency,
    applyTimes,
    applyDates,
    applyOrdinals,
    applyCardinals,
    applyDigitGrouping,
    parseCardinal,
    ordinalSuffix,
};
