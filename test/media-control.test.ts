/**
 * mediaControl — picking the RIGHT Play button.
 *
 * Spotify exposes several buttons literally named "Play": the top-result card,
 * every playlist row, and the player bar. Pressing the wrong one resumes an
 * unrelated track, so the safety property here is as important as the happy
 * path: when we can't identify the requested track's button, we return null
 * rather than press something.
 *
 * The fixture below is trimmed from a real Spotify search dump for
 * "we will rock you" (218 controls).
 */
import { describe, it, expect } from 'vitest';
import { findPlayButton, titleMatches, titleConfirmsPlayback, MediaElement } from '../electron/mediaControl';

const el = (id: number, name: string, type = 'Button', invoke = true): MediaElement => ({ id, name, type, invoke });

// Real ordering: sidebar playlists, then the top-result card, then the player bar.
const SPOTIFY_SEARCH: MediaElement[] = [
    el(4, 'What do you want to play?', 'ComboBox', false),
    el(24, 'Play Your Top Songs 2023'),
    el(28, 'Play Release Radar'),
    el(36, 'Play Chill Jazz Mix'),
    el(50, 'Now playing view'),
    el(51, 'We Will Rock You - Remastered 2011', 'Hyperlink'),
    el(52, 'Queen', 'Hyperlink'),
    el(54, 'Enable Shuffle for We Will Rock You - Remastered 2011'),
    el(56, 'Play'),                                    // ← the one we want
    el(67, 'Open Miniplayer'),
    el(83, 'We Will Rock You - Remastered 2011', 'DataItem'),
];

describe('findPlayButton', () => {
    it('picks the Play button belonging to the matched result card', () => {
        expect(findPlayButton(SPOTIFY_SEARCH, 'we will rock you')).toBe(56);
    });

    it('never grabs an unrelated "Play" when the track is not present', () => {
        // Sidebar playlist play buttons and the player bar must not be pressed —
        // that would resume some other song the user did not ask for.
        expect(findPlayButton(SPOTIFY_SEARCH, 'stairway to heaven')).toBeNull();
    });

    it('prefers a self-labelled play button for the track', () => {
        const els = [el(1, 'Play'), el(2, 'Play Bohemian Rhapsody'), el(3, 'Bohemian Rhapsody', 'Hyperlink')];
        expect(findPlayButton(els, 'bohemian rhapsody')).toBe(2);
    });

    it('ignores non-invokable elements', () => {
        const els = [el(1, 'Thunderstruck', 'Hyperlink'), el(2, 'Play', 'Button', false)];
        expect(findPlayButton(els, 'thunderstruck')).toBeNull();
    });

    it('does not reach past the result card for a distant Play button', () => {
        const els: MediaElement[] = [
            el(1, 'Thunderstruck', 'Hyperlink'),
            ...Array.from({ length: 20 }, (_, i) => el(100 + i, `Filler ${i}`)),
            el(200, 'Play'), // far away — belongs to something else
        ];
        expect(findPlayButton(els, 'thunderstruck')).toBeNull();
    });

    it('handles an empty tree', () => {
        expect(findPlayButton([], 'anything')).toBeNull();
    });
});

describe('titleMatches', () => {
    it('tolerates the decorations services add to titles', () => {
        expect(titleMatches('We Will Rock You - Remastered 2011', 'we will rock you')).toBe(true);
        expect(titleMatches('Bohemian Rhapsody (feat. Someone)', 'bohemian rhapsody')).toBe(true);
        expect(titleMatches('Mr. Blue Sky', 'mr blue sky')).toBe(true);
    });
    it('rejects unrelated titles', () => {
        expect(titleMatches('Stairway to Heaven', 'we will rock you')).toBe(false);
        expect(titleMatches('', 'x')).toBe(false);
    });
});

describe('titleConfirmsPlayback', () => {
    it('treats the idle title as not playing', () => {
        expect(titleConfirmsPlayback('Spotify Premium', 'we will rock you')).toBe(false);
        expect(titleConfirmsPlayback('Spotify', 'x')).toBe(false);
        expect(titleConfirmsPlayback('', 'x')).toBe(false);
    });
    it('confirms when the title becomes the track', () => {
        // Real observed transition after pressing Play.
        expect(titleConfirmsPlayback('Queen - We Will Rock You - Remastered 2011', 'we will rock you')).toBe(true);
    });
});
