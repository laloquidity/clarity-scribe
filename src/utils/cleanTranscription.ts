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

import type { DictionaryEntry } from '../types';

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

// Restarted phrases: "would you would you like a coffee" — the speaker paused
// mid-thought and began the phrase again, and both attempts were transcribed.
//
// Two words minimum, which is what makes this safe: the doubles English uses
// legitimately are single words ("had had", "that that", "very very"), so a
// two-word floor excludes that entire class without needing to enumerate it.
//
// No punctuation may sit between the copies. That is not incidental — the model
// punctuates deliberate repetition ("It was very, very good") and leaves a
// disfluent restart unpunctuated, so the comma does the separating for us.
//
// Measured over 200 real dictations this fires 12 times: 11 genuine restarts
// and one idiom, "banger after banger after banger". Chains like that are the
// only false positive found, and they have a tell — a restart is exactly two
// copies followed by something else, while a chain keeps going. So a repeat
// whose next word starts the phrase again is left alone.
const PHRASE_RESTART_PATTERN = /\b((?:[A-Za-z0-9']+ ){1,5}[A-Za-z0-9']+) \1\b/gi;

function dropRestartedPhrases(text: string): string {
    return text.replace(PHRASE_RESTART_PATTERN, (match, phrase: string, offset: number, whole: string) => {
        const next = whole.slice(offset + match.length).match(/^\s+([A-Za-z0-9']+)/);
        const firstWord = phrase.split(/\s+/)[0];
        // "banger after banger after banger" — still going, so not a restart.
        if (next && next[1].toLowerCase() === firstWord.toLowerCase()) return match;
        return phrase;
    });
}

// False-start fragments: short syllable before the full word it starts ("tr truncated" → "truncated")
// Minimum 2-char fragment to avoid matching contractions ("let's say" → "'s" + "say" was a false positive)
const FALSE_START_PATTERN = /\b([a-zA-Z]{2,3})\s+(\1[a-zA-Z]+)\b/gi;

// …but only when the fragment is not itself a word. The rule targets truncated
// syllables ("tr truncated"), and a short real word that happens to prefix the
// next one is ordinary English, not a stutter: "We went", "The theory", "He
// held", "So sorry" were all being rewritten to drop the first word. No
// dictation in a 55k-character sample tripped this, so it was latent rather
// than active — but "the theory of relativity" losing its article is the kind
// of quiet corruption that is very hard to trace back to its cause.
const NOT_A_FRAGMENT = new Set([
    'a', 'an', 'as', 'at', 'be', 'by', 'do', 'go', 'he', 'i', 'if', 'in', 'is', 'it',
    'me', 'my', 'no', 'of', 'on', 'or', 'so', 'to', 'up', 'us', 'we',
    'all', 'and', 'any', 'are', 'but', 'can', 'for', 'get', 'had', 'has', 'her',
    'him', 'his', 'how', 'its', 'let', 'may', 'new', 'not', 'now', 'off', 'old',
    'one', 'our', 'out', 'own', 'put', 'say', 'see', 'she', 'the', 'too', 'top',
    'try', 'two', 'use', 'was', 'way', 'who', 'why', 'yes', 'yet', 'you',
]);

// Repeated words: "the the", "I I", "and and".
//
// Allowlisted, not blanket. Collapsing ANY doubled word looks safe and is not:
// English doubles words legitimately far more often than it seems — "he had had
// enough", "the thing that that person said", "what it is is a problem", "very
// very good", "no no no". The old blanket rule silently rewrote every one of
// those. Since a missed stutter is invisible and a corrupted word is a new bug,
// only function words that essentially never double in valid English qualify.
//
// Deliberately EXCLUDED even though they stutter often: "that", "is", "was",
// "do", "has", "had" (all legitimate in cleft or perfect constructions), and
// intensifiers/interjections like "very", "so", "really", "no", "yes".
// Multi-word restarts ("would you would you") are not this rule's job — they
// need the pause evidence only the segment seam has; see segmentJoin.
const DOUBLE_SAFE_WORDS = [
    'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at',
    'for', 'with', 'from', 'into', 'onto', 'i', 'my', 'your', 'our', 'their',
];
const REPEATED_WORD_PATTERN = new RegExp(`\\b(${DOUBLE_SAFE_WORDS.join('|')})\\s+\\1\\b`, 'gi');

/**
 * Clean up a transcription by removing filler words, stutters,
 * and fixing resulting punctuation/spacing artifacts.
 * Optionally applies personal dictionary corrections.
 */
export function cleanTranscription(text: string, personalDictionary?: DictionaryEntry[]): string {
    if (!text || text.trim().length === 0) return text;

    let cleaned = text;

    // 1. Remove filler words
    cleaned = cleaned.replace(FILLER_PATTERN, '');

    // 2. Remove stutters (t-t-the → the)
    cleaned = cleaned.replace(STUTTER_PATTERN, '$1');

    // 2b. Remove false-start fragments (tr truncated → truncated)
    cleaned = cleaned.replace(FALSE_START_PATTERN, (match, frag: string, full: string) =>
        NOT_A_FRAGMENT.has(frag.toLowerCase()) ? match : full);

    // 2c. Collapse restarted phrases ("would you would you" → "would you").
    // Before the single-word rule: this needs the two copies still adjacent.
    cleaned = dropRestartedPhrases(cleaned);

    // 3. Remove repeated words (the the → the)
    cleaned = cleaned.replace(REPEATED_WORD_PATTERN, '$1');

    // 4. Clean up punctuation artifacts
    cleaned = cleaned.replace(/\.{3,}/g, '…');          // Protect ellipses: convert to unicode ellipsis
    cleaned = cleaned.replace(/\s*,\s*,/g, ',');       // Double commas
    cleaned = cleaned.replace(/\s*\.\s*\./g, '.');     // Double periods (ellipses already protected)
    cleaned = cleaned.replace(/,\s*\./g, '.');          // Comma before period
    cleaned = cleaned.replace(/\.\s*,/g, '.');          // Period before comma
    cleaned = cleaned.replace(/\s+([.,;:!?…])/g, '$1');  // Space before punctuation
    cleaned = cleaned.replace(/([.,;:!?…])\s*(?=[A-Z])/g, '$1 '); // Ensure space after punctuation before capital
    cleaned = cleaned.replace(/…/g, '...');             // Convert unicode ellipsis back to three dots

    // 5. Apply personal dictionary corrections (original + variants → replacement)
    if (personalDictionary && personalDictionary.length > 0) {
        for (const entry of personalDictionary) {
            if (entry.replacement && entry.replacement.trim()) {
                // Create list of all patterns to match (original + all variants)
                const patterns = [entry.original, ...(entry.variants || [])];
                for (const pattern of patterns) {
                    if (pattern && pattern.trim()) {
                        // Escape regex special characters
                        const escapedPattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        // Match with word boundaries, case-insensitive
                        const wordRegex = new RegExp(`\\b${escapedPattern}\\b`, 'gi');
                        cleaned = cleaned.replace(wordRegex, entry.replacement);
                    }
                }
            }
        }
    }

    // 6. Clean up whitespace
    cleaned = cleaned.replace(/\s{2,}/g, ' ');          // Collapse multiple spaces
    cleaned = cleaned.trim();

    // 7. Ensure first letter is capitalized (may have been a filler)
    if (cleaned.length > 0) {
        cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
    }

    return cleaned;
}

