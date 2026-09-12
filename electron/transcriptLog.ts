/**
 * How the engines mention a transcript in their logs.
 *
 * The engines print the start of each result to the console, which is what
 * makes a misrecognized dictation diagnosable. That is fine for the owner's own
 * dictation. It is not fine for an uploaded recording of somebody else's
 * conversation — a client call — where the words are not the owner's to spill
 * into a log that other tools, bug reports and screen shares can pick up.
 *
 * So every transcript mention goes through here, and a caller that passes
 * `logTranscript: false` gets a length instead of words.
 */

/** Characters of transcript shown when logging is allowed. */
const EXCERPT_CHARS = 80;

export function transcriptExcerpt(text: string | null | undefined, logTranscript: boolean | undefined): string {
    const value = text ?? '';
    if (logTranscript === false) return `[${value.length} chars, text withheld]`;
    return `"${value.substring(0, EXCERPT_CHARS)}"`;
}
