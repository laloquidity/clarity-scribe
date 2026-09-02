/**
 * segmentJoin — repair sentence boundaries when stitching segments together.
 *
 * THE PROBLEM. Both transcription paths chop audio at pauses (Silero VAD for
 * batch, energy segmentation for streaming) and transcribe each piece in
 * COMPLETE ISOLATION. Parakeet emits its own punctuation and capitalization,
 * so handed a lone clip it does the only sensible thing — treats it as a whole
 * utterance and capitalizes the first word. Joining those pieces with a bare
 * space then produces:
 *
 *     "I went to the store"  +  "And bought some milk"
 *     → "I went to the store And bought some milk"
 *
 * The model isn't wrong; each segment is correct in isolation. The fact that a
 * sentence was still in flight was destroyed by segmentation before the model
 * ever saw the audio. Only the joiner can put it back.
 *
 * THE FIX, and its guiding rule: NEVER MAKE OUTPUT WORSE. Real capitalization
 * is unrecoverable once lost (a wrongly-lowercased name is a new bug, and a
 * worse one than the bug being fixed), so repairs happen only where the
 * evidence is strong:
 *
 *   1. The left segment does not end a sentence — it has no terminal
 *      punctuation, so whatever follows is a continuation of it; or
 *   2. The split was FORCED — we cut mid-speech at a length cap rather than at
 *      a pause, so both the capital and any trailing period are artifacts of
 *      our own segmentation, not the speaker; or
 *   3. A PAUSE closed the left segment, the model ended it with a period, and
 *      the right one opens with a continuation word. The model puts a period
 *      on the end of EVERY isolated clip, so at a pause seam that period is
 *      near-zero evidence of a sentence ending, while "And/But/Which" is
 *      strong evidence it didn't. The pause itself was real — the speaker
 *      thinking — so it is rendered as a comma before a conjunction or
 *      relativizer ("…preserved, and then…") and as nothing before a
 *      preposition ("…a copy of the file"). Chosen by the user (2026-09-01),
 *      accepting that a sentence genuinely begun with "And" now joins too.
 *      A "?" or "!" is left alone: those the model only writes on evidence.
 *
 * …and even then only for a closed set of words that essentially never begin a
 * dictated sentence. Anything outside that set is left exactly as the model
 * produced it. A single-segment transcript passes through untouched.
 */

export interface JoinPart {
    text: string;
    /**
     * True when the segment AFTER this one was cut from it mid-speech (a
     * length-cap or quietest-window split) rather than closed at a natural
     * pause. Certain evidence the sentence continues across the seam.
     */
    forcedSplit?: boolean;
    /**
     * A STRADDLE decode across the seam BEFORE this part: the last couple of
     * seconds of the previous segment plus the first couple of this one,
     * decoded together. The model's casing of this part's first word, seen
     * with context, is the one signal that separates a common noun from a
     * name — "…an incredible | Product." (real dictation, 2026-09-01) reads
     * "incredible product" in the straddle. Best-effort: absent or unhelpful,
     * the word lists below apply.
     */
    seamText?: string;
}

/**
 * Words that effectively never start a dictated sentence, so a capital on them
 * right after an unfinished segment is our segmentation artifact, not speech.
 *
 * Deliberately excludes words that legitimately open sentences — "if", "when",
 * "after", "before", "since", "while", "that", "this", "there", "then",
 * "because", "the", "a" — even though they often continue one too. Missing a
 * repair is invisible; a wrong one is a new bug.
 */
const CONTINUATION_WORDS = new Set([
    // coordinating conjunctions ("so" chosen by the user, 2026-09-01: "…a
    // very important design decision, so we need to get this right"; a
    // discourse-opener "So, …" is exempted below by its comma)
    'and', 'but', 'or', 'nor', 'so',
    // prepositions
    'of', 'to', 'with', 'from', 'by', 'at', 'into', 'onto', 'upon',
    'among', 'amongst', 'between', 'beyond', 'during', 'except',
    'toward', 'towards', 'within', 'without', 'via', 'versus',
    // relativizers / comparatives
    'which', 'whom', 'whose', 'than',
]);

/**
 * Words safe to lowercase at a FORCED seam only. Our own knife cut the
 * sentence mid-flight there, so the capital is certainly an artifact — the
 * only remaining risk is a proper noun, and none of these function words is
 * one. At a pause seam they stay on the narrow list above ("In 1974, …" can
 * open a sentence; after a length-cap cut it cannot have). Real dictation
 * 2026-09-01: "…Did you know that | In 1974, there was an act…".
 */
const FORCED_SEAM_WORDS = new Set([
    // articles / determiners / possessives
    'the', 'a', 'an', 'this', 'that', 'these', 'those', 'some', 'any', 'each', 'every',
    'my', 'your', 'his', 'her', 'its', 'our', 'their',
    // pronouns (never "I")
    'he', 'she', 'it', 'we', 'they', 'you', 'me', 'him', 'them', 'us',
    // prepositions not on the narrow list
    'in', 'on', 'for', 'as', 'about', 'over', 'under', 'after', 'before',
    'through', 'across', 'around', 'against', 'along', 'near', 'off', 'out', 'up', 'down', 'per', 'like',
    // subordinators / connectives / question words
    'if', 'when', 'while', 'since', 'because', 'so', 'then', 'until', 'unless',
    'though', 'although', 'whether', 'where', 'whereas', 'once',
    'what', 'how', 'why', 'who',
    // auxiliaries
    'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
    'do', 'does', 'did', 'have', 'has', 'had',
    'can', 'could', 'will', 'would', 'should', 'may', 'might', 'must', 'shall', 'not',
    // negated auxiliaries and pronoun contractions — never "I'm"/"I've"
    // (the pronoun stays capital), never a name. "…do this | Wouldn't we
    // need intra bar data?" real dictation, 2026-09-01.
    "wouldn't", "couldn't", "shouldn't", "isn't", "aren't", "wasn't", "weren't",
    "don't", "doesn't", "didn't", "can't", "won't", "haven't", "hasn't", "hadn't",
    "it's", "that's", "there's", "he's", "she's", "we're", "they're", "you're",
    "we've", "they've", "you've", "we'll", "they'll", "you'll", "it'll", "that'll",
    // common adverbs
    'also', 'just', 'really', 'very', 'only', 'still', 'already', 'now', 'here', 'there',
]);

/** Terminal punctuation, allowing a trailing quote or bracket. */
const ENDS_SENTENCE = /[.!?…]["'”’)\]]*$/;

/**
 * A bare period as the very last character — the model's default close for
 * an isolated clip. A period inside a closing quote or bracket is excluded:
 * that one belongs to quoted speech and is left as the speaker's.
 */
const ENDS_WITH_BARE_PERIOD = /[.]$/;

/**
 * Continuation words that read naturally with a COMMA after a pause
 * ("…preserved, and then…", "…the file, which…"). The rest of
 * CONTINUATION_WORDS are prepositions, where a pause is just hesitation and
 * a comma would be wrong ("a copy, of the file").
 */
const COMMA_CONTINUATIONS = new Set(['and', 'but', 'or', 'nor', 'so', 'which', 'whom', 'whose']);

// --- Restarted phrases ---
//
// A speaker who pauses mid-thought and starts the phrase again ("would you —
// would you like a coffee") gets both attempts transcribed, because each
// segment is decoded in isolation and neither one is wrong.
//
// Text alone cannot tell that apart from an intentional repeat: "had had" and
// "would you would you" are the same shape on the page. The PAUSE is what
// distinguishes them, and at a seam we still have it — a segment closed by a
// pause has forcedSplit false, while a length-cap cut has it true. So this trims
// only at pause seams, where a repeat really is evidence of a restart. A repeat
// spanning a forced cut is just where our own knife landed and is left alone.
//
// Two words minimum, deliberately. Single-word overlap at a pause is far more
// often real speech ("I said no." / "No, I didn't") than disfluency, and the
// module's rule is that a missed repair is invisible while a wrong one is a new
// bug. Single-word stutters are cleanTranscription's job.
const MIN_RESTART_WORDS = 2;
const MAX_RESTART_WORDS = 6;

const WORD_RE = /[A-Za-z0-9'’-]+/g;

/** Comparable word tokens plus where each starts, for slicing the original. */
function wordSpans(s: string): Array<{ w: string; start: number }> {
    const out: Array<{ w: string; start: number }> = [];
    WORD_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WORD_RE.exec(s)) !== null) {
        out.push({ w: m[0].toLowerCase().replace(/[’]/g, "'"), start: m.index });
    }
    return out;
}

/**
 * How many words `left` ends with that `right` also begins with — the size of
 * a restarted phrase, or 0 if there is no such overlap. Longest match wins, so
 * a repeat is measured whole rather than leaving a fragment behind.
 */
export function restartOverlap(left: string, right: string): number {
    const L = wordSpans(left);
    const R = wordSpans(right);
    const max = Math.min(MAX_RESTART_WORDS, L.length, R.length);
    for (let k = max; k >= MIN_RESTART_WORDS; k--) {
        let same = true;
        for (let i = 0; i < k; i++) {
            if (L[L.length - k + i].w !== R[i].w) { same = false; break; }
        }
        if (same) return k;
    }
    return 0;
}

/** Leading token of a string, plus where it ends. */
function firstWord(s: string): { word: string; end: number } | null {
    const m = s.match(/^([A-Za-z][A-Za-z'’-]*)/);
    return m ? { word: m[1], end: m[1].length } : null;
}

/** ALL-CAPS tokens are acronyms (US, NASA, API) — never re-case them. */
function isAcronym(word: string): boolean {
    return word.length > 1 && word === word.toUpperCase();
}

/**
 * How the straddle decode wrote `word` in context — the occurrence nearest
 * the middle of the straddle, which is where the seam sits:
 *   'lower'    — lowercase: a common word, our cut invented the capital
 *   'proper'   — capitalized mid-sentence: a name, keep the capital
 *   'sentence' — capitalized after terminal punctuation: a real sentence break
 *   null       — not found, or only as the straddle's own first word (which is
 *                capitalized for the same reason as the seam: no information)
 */
function seamCasing(seamText: string, word: string): 'lower' | 'proper' | 'sentence' | null {
    const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[^A-Za-z0-9'’])(${esc})(?=$|[^A-Za-z0-9'’])`, 'gi');
    const mid = seamText.length / 2;
    let best: { found: string; at: number } | null = null;
    let m: RegExpExecArray | null;
    while ((m = re.exec(seamText)) !== null) {
        const at = m.index + m[1].length;
        if (!best || Math.abs(at - mid) < Math.abs(best.at - mid)) best = { found: m[2], at };
    }
    if (!best) return null;
    const before = seamText.slice(0, best.at).trimEnd();
    if (before === '') return null;
    const cap = best.found[0] !== best.found[0].toLowerCase();
    if (!cap) return 'lower';
    return ENDS_SENTENCE.test(before) ? 'sentence' : 'proper';
}

/**
 * Stitch segment texts into one transcript, repairing seams that our own
 * segmentation broke. Pure and order-preserving; empty segments are dropped.
 */
export function joinSegments(
    parts: Array<JoinPart | string>,
    onRepair?: () => void,
    onRestartTrimmed?: () => void,
): string {
    const norm: JoinPart[] = parts
        .map(p => (typeof p === 'string' ? { text: p } : p))
        .map(p => ({ ...p, text: (p.text ?? '').trim() }))
        .filter(p => p.text.length > 0);

    if (norm.length === 0) return '';

    let out = norm[0].text;
    for (let i = 1; i < norm.length; i++) {
        const forced = norm[i - 1].forcedSplit === true;
        let right = norm[i].text;

        // Only at a pause seam: a repeat across a forced cut is our knife, not
        // a restart. Runs BEFORE the capitalization repair below, which reads
        // whether the left ends a sentence — trimming changes that.
        //
        // The duplicate comes off the RIGHT, keeping the left's copy. Both hold
        // the same words, but the left's casing is already correct for where it
        // sits, so nothing has to be re-cased — and re-casing is exactly how
        // this repair could invent a new bug (a lowercased name is worse than
        // the duplicate it fixed).
        if (!forced) {
            const k = restartOverlap(out, right);
            if (k > 0) {
                const R = wordSpans(right);
                const rest = k < R.length ? right.slice(R[k].start).trimStart() : '';
                onRestartTrimmed?.();
                // The right segment was nothing but the repeat — drop it whole
                // and leave the left exactly as it was, punctuation included.
                if (rest === '') continue;
                // The left's terminal punctuation marked the pause the speaker
                // restarted from, not the end of a sentence.
                out = out.replace(/[.!?…]["'”’)\]]*$/, '');
                right = rest;
            }
        }

        const leftEnds = ENDS_SENTENCE.test(out);

        // A straddle decode across a FORCED seam beats any word list: it is
        // the model's own reading of the cut with context on both sides.
        const seamText = norm[i].seamText;
        if (forced && seamText) {
            const fw = firstWord(right);
            const verdict = fw && !isAcronym(fw.word) ? seamCasing(seamText, fw.word) : null;
            if (verdict) {
                if (verdict === 'lower') {
                    right = fw!.word.toLowerCase() + right.slice(fw!.end);
                    if (leftEnds) out = out.replace(/[.]["'”’)\]]*$/, '');
                    onRepair?.();
                } else if (verdict === 'proper') {
                    // A name: keep the capital, drop the period our cut invented.
                    if (leftEnds) out = out.replace(/[.]["'”’)\]]*$/, '');
                }
                // 'sentence': the model breaks here even with context — leave it.
                out += ' ' + right;
                continue;
            }
        }

        // Evidence the sentence is still in flight across this seam.
        const midSentence = forced || !leftEnds;
        // Rule 3: a pause seam the model closed with its default period.
        const pauseSeamAfterPeriod = !forced && ENDS_WITH_BARE_PERIOD.test(out);

        if (midSentence || pauseSeamAfterPeriod) {
            const fw = firstWord(right);
            if (fw && !isAcronym(fw.word)) {
                const lower = fw.word.toLowerCase();
                // Lookup key only — the text keeps the model's own apostrophe.
                const key = lower.replace(/[’]/g, "'");
                const isCapitalized = fw.word[0] !== lower[0];
                // The wide list applies wherever the sentence is CERTAINLY in
                // flight: a forced cut, or a left segment with no terminal
                // punctuation at all ("…adapt those as well. Like | What
                // should the cap be…", real dictation 2026-09-01). Only the
                // period-closed pause seam (rule 3) keeps the narrow list.
                const repairable = CONTINUATION_WORDS.has(key)
                    || ((forced || !leftEnds) && FORCED_SEAM_WORDS.has(key));
                // A comma right after the word marks a discourse opener
                // ("So, what do you think?"), which does begin a sentence.
                const opensAside = right.slice(fw.end).startsWith(',');
                if (isCapitalized && repairable && !opensAside) {
                    right = lower + right.slice(fw.end);
                    if (forced && leftEnds) {
                        // A period we inserted by cutting mid-speech is bogus too.
                        out = out.replace(/[.]["'”’)\]]*$/, '');
                    } else if (pauseSeamAfterPeriod) {
                        // The speaker's pause becomes a comma before a
                        // conjunction/relativizer, nothing before a preposition.
                        out = out.replace(ENDS_WITH_BARE_PERIOD, COMMA_CONTINUATIONS.has(key) ? ',' : '');
                    }
                    onRepair?.(); // diagnostics: how often does this actually fire?
                }
            }
        }

        out += ' ' + right;
    }

    return out.replace(/\s+/g, ' ').trim();
}
