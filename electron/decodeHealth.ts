/**
 * decodeHealth — catch a transcription that silently ate the user's speech.
 *
 * REPORTED FAILURE (Windows / DirectML, after ~24h of uptime):
 *
 *   ⚠ Decoder collapse detected at frame 61 (~4.9s). Resetting LSTM state (recovery #1).
 *   Decode: 6 tokens from 85 frames | blanks: 36/42 (85.7%) |
 *           lastToken: frame 38 (3.0s/6.8s) | unusedTail: 47 frames | ⚠ recoveries: 1
 *   Result: "So that way we can get"
 *
 * Read that carefully: the last token landed at 3.0s of a 6.8s segment, so
 * **3.8 seconds of speech produced nothing at all** and the user was handed a
 * confident-looking fragment. Worse, the existing collapse detector fired at
 * frame 61 and reset the LSTM — and emission still never resumed.
 *
 * That is the important clue. If zeroing the decoder state doesn't bring
 * tokens back, the decoder state was not the problem: the ENCODER's output has
 * gone bad, and the joiner will keep ranking blank highest no matter what
 * state we feed it. Consistent with the rest of that run — the encoder took
 * 352ms for 6.8s of audio, an order of magnitude off this machine's normal —
 * and with the fact that restarting the app fixed it. A long-lived DirectML
 * session had degraded.
 *
 * The existing recovery operates INSIDE one decode. This module operates on
 * the decode as a whole, so the caller can do the thing that actually works:
 * rebuild the inference sessions and try again. "Restart the app", performed
 * automatically in about a second, instead of pasting garbage.
 *
 * Bias: silence is the expensive failure. Dropping speech is invisible to the
 * user until they re-read what was pasted, so we would rather pay a rare
 * unnecessary retry than keep a bad transcript.
 */

export interface DecodeStats {
    /** Encoder frame index of the last emitted token. */
    lastTokenFrame: number;
    /** Total encoder frames available for this segment. */
    totalFrames: number;
    /** LSTM resets the in-decode collapse detector performed. */
    collapseRecoveries: number;
    /** Share of decode iterations that emitted blank, 0–1. */
    blankRatio: number;
}

export interface DecodeVerdict {
    degraded: boolean;
    /** Human-readable cause, for logs. Empty when healthy. */
    reason: string;
}

/**
 * Frames after the last token, as a share of the segment. Our segmenter trims
 * trailing silence, so a long dead tail on a voiced segment means dropped
 * speech rather than a quiet ending.
 */
function unusedTailRatio(s: DecodeStats): number {
    if (s.totalFrames <= 0) return 0;
    return Math.max(0, s.totalFrames - s.lastTokenFrame) / s.totalFrames;
}

/** Below this, a segment is too short for the ratios to mean anything (~2s). */
const MIN_FRAMES = 25;
/** A collapse recovery is a smoking gun; pair it with any real tail. */
const TAIL_AFTER_RECOVERY = 0.2;
/** Near-total blanks on a segment that should contain speech. */
const BLANK_RATIO_ALONE = 0.8;

/**
 * Did this decode lose speech? Conservative by construction: a healthy decode
 * on a normal utterance trips none of these, and the caller only retries once.
 */
export function assessDecode(s: DecodeStats): DecodeVerdict {
    if (s.totalFrames < MIN_FRAMES) return { degraded: false, reason: '' };

    const tail = unusedTailRatio(s);
    const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

    // The reported failure: the collapse detector fired AND emission never
    // recovered, leaving a dead tail. Resetting the LSTM didn't help, so the
    // encoder output is the suspect — only a session rebuild fixes that.
    if (s.collapseRecoveries > 0 && tail >= TAIL_AFTER_RECOVERY) {
        return {
            degraded: true,
            reason: `decoder collapsed (${s.collapseRecoveries} reset${s.collapseRecoveries > 1 ? 's' : ''}) and never recovered — ${pct(tail)} of the segment produced no tokens`,
        };
    }

    // NOTE: a large dead tail on its own is NOT evidence of a fault, and used
    // to be treated as such. It fired on a real dictation ending in "Thank
    // you." — 0.5s of speech followed by 1.9s of genuine silence, an 80% tail
    // — and cost the user 3.1 seconds rebuilding sessions to reproduce the
    // same correct transcript. Trailing silence is ordinary; our segmenter
    // does not trim it as tightly as that rule assumed. Only a tail that
    // accompanies a collapse (above) tells us speech was actually lost.

    // Almost everything came back blank.
    if (s.blankRatio >= BLANK_RATIO_ALONE) {
        return { degraded: true, reason: `${pct(s.blankRatio)} of decode steps emitted blank` };
    }

    return { degraded: false, reason: '' };
}

/**
 * PREVENTIVE REFRESH.
 *
 * Recovering from a degraded session is second best: by then the user has
 * already waited through a bad decode. Since the observed failure correlates
 * with session AGE (~24h of uptime), the cheaper answer is to not let sessions
 * get old — rebuild them periodically while nobody is dictating.
 *
 * Rebuilding costs about a second of idle GPU time, so doing it every few
 * hours is free in practice and removes the failure mode entirely if the
 * age hypothesis is right. If it's wrong, we've lost nothing: the reactive
 * detection above still catches it.
 *
 * Two hard rules: never rebuild while a transcription is in flight (sessions
 * are being read concurrently), and never rebuild on the path to producing
 * text — only after, when the user has what they asked for.
 */
export const SESSION_MAX_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours

export function shouldRefreshSessions(opts: {
    /** When the current sessions were created. */
    builtAt: number;
    now: number;
    /** Transcriptions currently using the sessions. Must be 0 to rebuild. */
    inFlight: number;
    maxAgeMs?: number;
}): boolean {
    if (opts.inFlight > 0) return false;
    if (!(opts.builtAt > 0)) return false;
    return opts.now - opts.builtAt >= (opts.maxAgeMs ?? SESSION_MAX_AGE_MS);
}

/**
 * After a retry, keep the better of the two decodes. "Better" = reached
 * further into the audio; ties go to the one that produced more text, and to
 * the original when neither is clearly better (never churn for nothing).
 */
export function preferBetterDecode<T extends DecodeStats & { text: string }>(original: T, retry: T): T {
    if (retry.lastTokenFrame > original.lastTokenFrame) return retry;
    if (retry.lastTokenFrame === original.lastTokenFrame && retry.text.length > original.text.length) return retry;
    return original;
}
