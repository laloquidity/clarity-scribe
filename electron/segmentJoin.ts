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
 *      our own segmentation, not the speaker.
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
    // coordinating conjunctions
    'and', 'but', 'or', 'nor',
    // prepositions
    'of', 'to', 'with', 'from', 'by', 'at', 'into', 'onto', 'upon',
    'among', 'amongst', 'between', 'beyond', 'during', 'except',
    'toward', 'towards', 'within', 'without', 'via', 'versus',
    // relativizers / comparatives
    'which', 'whom', 'whose', 'than',
]);

/** Terminal punctuation, allowing a trailing quote or bracket. */
const ENDS_SENTENCE = /[.!?…]["'”’)\]]*$/;

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
        // Evidence the sentence is still in flight across this seam.
        const midSentence = forced || !leftEnds;

        if (midSentence) {
            const fw = firstWord(right);
            if (fw && !isAcronym(fw.word)) {
                const lower = fw.word.toLowerCase();
                const isCapitalized = fw.word[0] !== lower[0];
                if (isCapitalized && CONTINUATION_WORDS.has(lower)) {
                    right = lower + right.slice(fw.end);
                    // A period we inserted by cutting mid-speech is bogus too.
                    if (forced && leftEnds) out = out.replace(/[.]["'”’)\]]*$/, '');
                    onRepair?.(); // diagnostics: how often does this actually fire?
                }
            }
        }

        out += ' ' + right;
    }

    return out.replace(/\s+/g, ' ').trim();
}
