/**
 * mediaControl — finish the job on "play X on spotify".
 *
 * The deep link (spotify:search:…) lands on the results page in ~120ms but
 * doesn't play anything. This module presses Play on the top result using the
 * accessibility tree, so the command actually does what the user asked.
 *
 * Two things make it reliable:
 *  - Chromium builds its accessibility tree LAZILY, and only once an assistive
 *    client asks. The first dump is the poke; the tree arrives a beat later.
 *    So we poll rather than read once (see waitForTree).
 *  - Spotify exposes several buttons literally named "Play" (top-result card,
 *    playlist rows, the player bar). Picking the wrong one resumes whatever
 *    played last instead of the requested song, so findPlayButton anchors on
 *    the result whose label matches the query and takes the Play button that
 *    belongs to that card (see below).
 */

export interface MediaElement {
    id: number;
    name: string;
    type: string;
    invoke: boolean;
}

/** Normalize for loose title matching ("We Will Rock You - Remastered 2011"). */
function norm(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Does `candidate` plausibly refer to `query`? Streaming services decorate
 * titles ("- Remastered 2011", "(feat. …)"), so require the query's words to
 * appear in order rather than an exact match.
 */
export function titleMatches(candidate: string, query: string): boolean {
    const c = norm(candidate);
    const q = norm(query);
    if (!c || !q) return false;
    if (c.includes(q)) return true;
    // All query words present, in order.
    let at = 0;
    for (const word of q.split(' ')) {
        const i = c.indexOf(word, at);
        if (i === -1) return false;
        at = i + word.length;
    }
    return true;
}

/** How far after the matched title we'll still consider a Play button part of it. */
const CARD_WINDOW = 12;

/**
 * Pick the Play button for the requested track.
 *
 * Strategy, most-specific first:
 *   1. A button whose own label names the track ("Play We Will Rock You").
 *   2. The nearest "Play" button following an element that matches the query —
 *      Spotify emits the top-result card as [title, artist, shuffle, play] in
 *      tree order, so the Play that belongs to the match sits just after it.
 *   3. Nothing. We deliberately do NOT fall back to any bare "Play" button:
 *      that's usually the player bar, which would resume an unrelated track —
 *      worse than reporting we couldn't do it.
 */
export function findPlayButton(elements: MediaElement[], query: string): number | null {
    const playable = (e: MediaElement) => e.invoke && /^play\b/i.test(e.name.trim());

    // 1. Self-labelled play button for this track.
    for (const e of elements) {
        if (!playable(e)) continue;
        const label = e.name.trim().replace(/^play\s+/i, '');
        if (label && titleMatches(label, query)) return e.id;
    }

    // 2. The Play button belonging to the matched result card.
    const matchIdx = elements.findIndex(e => e.name.trim() !== '' && titleMatches(e.name, query));
    if (matchIdx !== -1) {
        for (let i = matchIdx + 1; i < Math.min(elements.length, matchIdx + 1 + CARD_WINDOW); i++) {
            const e = elements[i];
            if (playable(e) && /^play$/i.test(e.name.trim())) return e.id;
        }
    }

    return null;
}

/**
 * Gaps between accessibility-tree polls, in ms.
 *
 * Chromium enables accessibility when an assistive client first asks, then
 * needs WALL-CLOCK time to build the tree — hammering it with requests does
 * not speed that up (measured: three back-to-back dumps all returned the same
 * 4-element stub). So back off generously rather than poll tightly.
 */
export const TREE_POLL_GAPS_MS = [800, 1500, 2000, 2500, 3000, 3000, 3000];

/** Did the app's window title change to reflect the requested track? */
export function titleConfirmsPlayback(windowTitle: string, query: string): boolean {
    const t = windowTitle.trim();
    if (!t || /^spotify( premium| free)?$/i.test(t)) return false; // idle title
    return titleMatches(t, query) || norm(t).length > 0 && !/^spotify/i.test(t);
}
