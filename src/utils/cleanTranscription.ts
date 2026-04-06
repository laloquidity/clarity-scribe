/**
 * Transcription Post-Processing — Filler word removal and text cleanup
 *
 * Removes common speech disfluencies (um, uh, ah, erm, hmm, etc.),
 * stutters (w-w-what), and cleans up resulting punctuation artifacts.
 *
 * Based on research from:
 *   - kais-grati/Filler-Words-Remover (comprehensive filler list)
 *   - onnx-asr text normalization patterns
 *   - Standard English filler word taxonomy (Corley & Stewart, 2008)
 *
 * Uses word-boundary anchored regex to avoid false positives
 * (e.g. "human" contains "um", "plumbing" contains "um").
 */

// Filler words to remove — ordered by frequency in natural speech
// Word-boundary (\b) anchored to prevent partial matches
const FILLER_WORDS = [
    // Common filled pauses
    'um', 'uh', 'uhh', 'umm', 'ummm',
    'ah', 'ahh', 'er', 'erm', 'em',
    'hmm', 'hm', 'huh', 'mhm', 'mm',
];

// Build a single regex from the filler word list
// Matches: standalone filler, filler with trailing comma, filler at start of sentence
const FILLER_PATTERN = new RegExp(
    // Match filler word optionally followed by comma/space
    `\\b(${FILLER_WORDS.join('|')})\\b[,;]?\\s*`,
    'gi'
);

// Stutters: repeated syllable with optional hyphen (t-t-the, w-w-what, I I I)
const STUTTER_PATTERN = /\b(\w{1,3})-(?:\1-)*\1\b/gi;

// Repeated words: "the the", "I I", "and and"
const REPEATED_WORD_PATTERN = /\b(\w+)\s+\1\b/gi;

/**
 * Clean up a transcription by removing filler words, stutters,
 * and fixing resulting punctuation/spacing artifacts.
 */
export function cleanTranscription(text: string): string {
    if (!text || text.trim().length === 0) return text;

    let cleaned = text;

    // 1. Remove filler words
    cleaned = cleaned.replace(FILLER_PATTERN, '');

    // 2. Remove stutters (t-t-the → the)
    cleaned = cleaned.replace(STUTTER_PATTERN, '$1');

    // 3. Remove repeated words (the the → the)
    cleaned = cleaned.replace(REPEATED_WORD_PATTERN, '$1');

    // 4. Clean up punctuation artifacts
    cleaned = cleaned.replace(/\s*,\s*,/g, ',');       // Double commas
    cleaned = cleaned.replace(/\s*\.\s*\./g, '.');     // Double periods
    cleaned = cleaned.replace(/,\s*\./g, '.');          // Comma before period
    cleaned = cleaned.replace(/\.\s*,/g, '.');          // Period before comma
    cleaned = cleaned.replace(/\s+([.,;:!?])/g, '$1');  // Space before punctuation
    cleaned = cleaned.replace(/([.,;:!?])\s*(?=[A-Z])/g, '$1 '); // Ensure space after punctuation before capital

    // 5. Clean up whitespace
    cleaned = cleaned.replace(/\s{2,}/g, ' ');          // Collapse multiple spaces
    cleaned = cleaned.trim();

    // 6. Ensure first letter is capitalized (may have been a filler)
    if (cleaned.length > 0) {
        cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
    }

    return cleaned;
}
