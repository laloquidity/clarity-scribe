/**
 * fastPath — deterministic intent matching, no LLM in the loop.
 *
 * The local router (Gemma) takes 600–4000 ms to pick a tool. But the commands
 * people actually repeat all day — "open X", "search for Y", "play Z on
 * spotify" — are unambiguous enough to recognize with patterns in well under a
 * millisecond. This module matches those and returns the SAME shape the LLM
 * router returns, so everything downstream (risk rulebook, confirmation UI,
 * history) is identical; only the decision got ~1000× faster.
 *
 * Design rules:
 *  - Only match when CONFIDENT. Anything ambiguous returns null and falls
 *    through to the LLM — a wrong instant answer is worse than a slow right
 *    one.
 *  - Order matters: compound intents ("open spotify and play X") must be
 *    tested before the simple ones they contain ("open X").
 *  - Never bypass safety: the caller still runs assessRisk() on the result.
 */

export interface FastMatch {
    tool: string;
    args: Record<string, unknown>;
    /** Which pattern fired — surfaced in logs/tests, not user-facing. */
    via: string;
}

/** Strip filler that speech recognition and polite phrasing leave behind. */
function clean(s: string): string {
    return s
        .trim()
        // Leading filler, each optionally followed by a comma ("hey, play …").
        .replace(/^(?:(?:hey|ok|okay|please|could you|can you|would you|scribe)[,\s]+)+/i, '')
        .replace(/[.!?]+$/, '')
        .trim();
}

/** Trailing "for me", "please" etc. that would otherwise pollute a query. */
function tidyQuery(s: string): string {
    return s
        .replace(/\s+(for me|please|thanks|thank you)$/i, '')
        .replace(/^(the|a|an)\s+/i, '')
        .replace(/[.!?]+$/, '')
        .trim();
}

/**
 * Streaming/media services reachable by a registered URI scheme or a search
 * URL — playing a song shouldn't require an agent clicking around an app.
 */
interface MediaService {
    /** Spoken names that select this service — also matches its window title. */
    match: RegExp;
    /** Deep link for a search query (preferred — no browser, no clicking). */
    uri?: (q: string) => string;
    /** Web fallback when the desktop app isn't installed. */
    url: (q: string) => string;
    /** Desktop app exposes an accessibility tree we can press Play in. */
    playable?: boolean;
    label: string;
}

export const MEDIA_SERVICES: MediaService[] = [
    {
        match: /\bspotify\b/i,
        uri: (q) => `spotify:search:${encodeURIComponent(q)}`,
        url: (q) => `https://open.spotify.com/search/${encodeURIComponent(q)}`,
        playable: true,
        label: 'Spotify',
    },
    {
        match: /\byou\s?tube\b/i,
        url: (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
        label: 'YouTube',
    },
    {
        match: /\bapple music\b/i,
        url: (q) => `https://music.apple.com/search?term=${encodeURIComponent(q)}`,
        label: 'Apple Music',
    },
];

/** Web searches that are just a URL — no reason to consult a model. */
const SEARCH_ENGINES: Array<[RegExp, (q: string) => string]> = [
    [/^(?:search (?:the )?web for|google|search google for)\s+(.+)$/i,
        (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`],
    [/^(?:search|look up|find)\s+(?:for\s+)?(.+?)\s+on\s+google$/i,
        (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`],
];

/**
 * Match a transcript to a tool call without invoking the LLM.
 * Returns null when nothing matches confidently (caller falls back to routing).
 */
export function matchFastPath(transcript: string): FastMatch | null {
    const text = clean(transcript);
    if (!text) return null;

    // ---- 1. Media playback (compound: names a service AND a thing to play) --
    // "play we will rock you on spotify" / "open spotify and play we will rock you"
    for (const svc of MEDIA_SERVICES) {
        if (!svc.match.test(text)) continue;
        const patterns = [
            // "play X on <service>"
            new RegExp(`^play\\s+(.+?)\\s+(?:on|in|with|using)\\s+.*$`, 'i'),
            // "open <service> and play X" / "<service>, play X" / "on <service> play X"
            new RegExp(`^(?:open|launch|start)?\\s*\\w*\\s*(?:and\\s+)?play\\s+(.+)$`, 'i'),
        ];
        // Only the first form is safe when the service name trails the query;
        // for the second, strip the service name out of the captured query.
        for (const re of patterns) {
            const m = text.match(re);
            if (!m) continue;
            let q = tidyQuery(m[1] ?? '');
            q = tidyQuery(q.replace(svc.match, '').replace(/\s+(on|in|with|using)\s*$/i, ''));
            if (!q) continue;
            return { tool: 'play_media', args: { query: q, service: svc.label }, via: 'media' };
        }
    }

    // ---- 2. Web search ------------------------------------------------------
    for (const [re, toUrl] of SEARCH_ENGINES) {
        const m = text.match(re);
        if (m) {
            const q = tidyQuery(m[1]);
            if (q) return { tool: 'search_web', args: { query: q }, via: 'search' };
        }
    }
    // "search youtube for X" / "search for X on youtube"
    const ytSearch = text.match(/^search\s+(?:for\s+)?(.+?)\s+on\s+you\s?tube$/i)
        || text.match(/^search\s+you\s?tube\s+for\s+(.+)$/i);
    if (ytSearch) {
        const q = tidyQuery(ytSearch[1]);
        if (q) return { tool: 'play_media', args: { query: q, service: 'YouTube' }, via: 'youtube-search' };
    }

    // ---- 3. Open something --------------------------------------------------
    // Deliberately LAST: "open spotify and play X" must not land here.
    // Also refuse anything with a conjunction — that's a multi-step task.
    const open = text.match(/^(?:open|launch|start|go to)\s+(.+)$/i);
    if (open) {
        const target = tidyQuery(open[1]);
        if (target && !/\b(and|then|,)\b/i.test(target)) {
            return { tool: 'open_target', args: { target }, via: 'open' };
        }
    }

    return null;
}
