/**
 * Spoken punctuation — converts spoken punctuation commands to symbols.
 *
 * Opt-in (Settings → "Spoken punctuation", default OFF) because words like
 * "period" and "comma" are ambiguous in natural speech; users who dictate
 * punctuation explicitly turn it on and speak commands deliberately.
 *
 * Token-walk state machine (not regex soup) so rules stay predictable:
 *   - Sentence enders (period / full stop / question mark / exclamation mark)
 *     attach to the previous word and capitalize the next.
 *   - Joiners (comma, colon, semicolon, at sign, ampersand) attach to the
 *     previous word.
 *   - "new line" / "new paragraph" insert line breaks and capitalize next.
 *   - Context-aware "dot": only joins in domain context ("google dot com",
 *     "api dot my site dot io") — prose "dot" is left alone.
 *   - "hyphen" joins its neighbors ("twenty hyphen one" → "twenty-one").
 */

const TLDS = new Set([
    'com', 'net', 'org', 'io', 'dev', 'ai', 'co', 'edu', 'gov', 'app',
    'me', 'sh', 'us', 'uk', 'de', 'fr', 'ca', 'au', 'jp', 'info', 'xyz',
]);

const WORD_RE = /^[\w'-]+$/;

/** Strip trailing punctuation the ASR may have added to a command word. */
function bare(token: string): string {
    return token.toLowerCase().replace(/[.,!?;:]+$/, '');
}

export function applySpokenPunctuation(input: string): string {
    if (!input || !input.trim()) return input;

    const tokens = input.split(/\s+/).filter(t => t.length > 0);
    const out: string[] = [];
    let capitalizeNext = false;
    let glueNext = false; // next word joins the previous one without a space

    /** Append a punctuation symbol to the previous emitted word. Returns
     *  whether there was a word to attach to (leading commands are dropped). */
    const attach = (sym: string): boolean => {
        if (out.length > 0 && out[out.length - 1] !== '\n' && out[out.length - 1] !== '\n\n') {
            // replace an existing trailing punct (ASR often wrote one already)
            out[out.length - 1] = out[out.length - 1].replace(/[.,!?;:]+$/, '') + sym;
            return true;
        }
        return false;
    };
    const emit = (word: string) => {
        if (capitalizeNext) {
            word = word.charAt(0).toUpperCase() + word.slice(1);
            capitalizeNext = false;
        }
        if (glueNext && out.length > 0) {
            out[out.length - 1] += word;
            glueNext = false;
            return;
        }
        glueNext = false;
        out.push(word);
    };

    for (let i = 0; i < tokens.length; i++) {
        const t = bare(tokens[i]);
        const next = i + 1 < tokens.length ? bare(tokens[i + 1]) : '';
        const next2 = i + 2 < tokens.length ? bare(tokens[i + 2]) : '';

        // ── Two-word commands ────────────────────────────────────────────
        if (t === 'question' && next === 'mark') { capitalizeNext = attach('?'); i++; continue; }
        if (t === 'exclamation' && (next === 'mark' || next === 'point')) { capitalizeNext = attach('!'); i++; continue; }
        if (t === 'full' && next === 'stop') { capitalizeNext = attach('.'); i++; continue; }
        if (t === 'at' && next === 'sign') { glueNext = attach('@'); i++; continue; }
        if (t === 'new' && next === 'line') { attach(''); out.push('\n'); capitalizeNext = true; i++; continue; }
        if (t === 'new' && next === 'paragraph') { attach(''); out.push('\n\n'); capitalizeNext = true; i++; continue; }

        // ── One-word commands ────────────────────────────────────────────
        if (t === 'period') { capitalizeNext = attach('.'); continue; }
        if (t === 'comma') { attach(','); continue; }
        if (t === 'semicolon') { attach(';'); continue; }
        if (t === 'colon') { attach(':'); continue; }
        if (t === 'ampersand') { emit('&'); continue; }

        // "hyphen" joins neighboring words: twenty hyphen one → twenty-one
        if (t === 'hyphen' && out.length > 0 && WORD_RE.test(next) && next !== '') {
            out[out.length - 1] = out[out.length - 1] + '-' + tokens[i + 1];
            i++;
            continue;
        }

        // Context-aware "dot": join only in domain context — the next token is
        // a TLD, or the token after next is another "dot" (multi-label domain).
        if (t === 'dot' && out.length > 0 && WORD_RE.test(next) && next !== '') {
            const prevWord = out[out.length - 1];
            const domainish = TLDS.has(next) || next2 === 'dot';
            if (domainish && /[\w-]$/.test(prevWord)) {
                out[out.length - 1] = prevWord + '.' + bare(tokens[i + 1]);
                i++;
                continue;
            }
        }

        emit(tokens[i]);
    }

    // Join: newline markers bind without surrounding spaces.
    let text = '';
    for (const part of out) {
        if (part === '\n' || part === '\n\n') text = text.replace(/[ \t]+$/, '') + part;
        else text += (text === '' || text.endsWith('\n') ? '' : ' ') + part;
    }
    return text.trim();
}
