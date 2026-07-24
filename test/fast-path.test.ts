/**
 * Fast path — deterministic intent matching that bypasses the LLM.
 *
 * Two properties matter equally: it must FIRE on the common commands (that's
 * the speed win), and it must NOT fire on anything ambiguous (a wrong instant
 * answer is worse than a slow correct one — those must fall through to the
 * router, which returns null here).
 */
import { describe, it, expect } from 'vitest';
import { matchFastPath } from '../electron/fastPath';
import { getTool } from '../electron/commandTools';

describe('matchFastPath — media', () => {
    it('routes "play X on spotify" to a deep link without the LLM', () => {
        const m = matchFastPath('play we will rock you on spotify')!;
        expect(m.tool).toBe('play_media');
        expect(m.args).toEqual({ query: 'we will rock you', service: 'Spotify' });
    });
    it('handles the compound phrasing "open spotify and play X"', () => {
        const m = matchFastPath('open spotify and play we will rock you')!;
        expect(m.tool).toBe('play_media');
        expect(m.args.query).toBe('we will rock you');
        expect(m.args.service).toBe('Spotify');
    });
    it('strips speech filler and politeness', () => {
        const m = matchFastPath('hey, play bohemian rhapsody on spotify please')!;
        expect(m.args.query).toBe('bohemian rhapsody');
    });
    it('recognizes YouTube searches', () => {
        expect(matchFastPath('search youtube for lofi beats')!.args).toEqual({ query: 'lofi beats', service: 'YouTube' });
        expect(matchFastPath('play mr blue sky on youtube')!.args.service).toBe('YouTube');
    });
});

describe('matchFastPath — search & open', () => {
    it('turns web searches into a URL with no model call', () => {
        const m = matchFastPath('search the web for flights to tokyo')!;
        expect(m.tool).toBe('search_web');
        expect(m.args.query).toBe('flights to tokyo');
        expect(matchFastPath('google best ramen nyc')!.args.query).toBe('best ramen nyc');
    });
    it('matches simple opens', () => {
        expect(matchFastPath('open my downloads folder')!.args.target).toBe('my downloads folder');
        expect(matchFastPath('launch notepad')!.args).toEqual({ target: 'notepad' });
    });
    it('does NOT swallow a compound command as a simple open', () => {
        // "open spotify and play X" must become play_media, never open_target
        expect(matchFastPath('open spotify and play thunderstruck')!.tool).toBe('play_media');
        // an unknown compound must fall through to the LLM entirely
        expect(matchFastPath('open notepad and write a haiku')).toBeNull();
    });
});

describe('matchFastPath — refuses to guess', () => {
    it('returns null for anything ambiguous or unsupported', () => {
        for (const t of [
            'remind me to call mom at 5',
            'what is the weather',
            'type hello world',                 // typing is the LLM's call (dictation vs command)
            'delete all my files',
            'message daniel on telegram',
            '',
            'play',                             // no query
        ]) {
            expect(matchFastPath(t), t).toBeNull();
        }
    });
});

describe('play_media tool', () => {
    const tool = getTool('play_media')!;
    it('is AUTO tier — opening a search is reversible', () => {
        expect(tool.assessRisk({ query: 'x' }).level).toBe('auto');
    });
    it('prefers the desktop deep link over the web URL', async () => {
        const opened: string[] = [];
        const out = await tool.execute({ query: 'we will rock you', service: 'Spotify' },
            { openExternal: async (u: string) => { opened.push(u); } } as any);
        expect(opened[0]).toBe('spotify:search:we%20will%20rock%20you');
        expect(out.message).toContain('Spotify');
    });
    it('falls back to the web when the scheme is not registered', async () => {
        const opened: string[] = [];
        let first = true;
        await tool.execute({ query: 'queen', service: 'Spotify' }, {
            openExternal: async (u: string) => {
                if (first) { first = false; throw new Error('no handler'); }
                opened.push(u);
            },
        } as any);
        expect(opened[0]).toContain('open.spotify.com/search/queen');
    });
    it('uses a web search for services without a URI scheme', async () => {
        const opened: string[] = [];
        await tool.execute({ query: 'lofi', service: 'YouTube' },
            { openExternal: async (u: string) => { opened.push(u); } } as any);
        expect(opened[0]).toContain('youtube.com/results?search_query=lofi');
    });
});
