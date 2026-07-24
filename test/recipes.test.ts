/**
 * Recipes — "learn once, replay fast".
 *
 * Three properties are load-bearing and tested hardest:
 *   1. PRIVACY: a recipe stores structure, never the user's words. The
 *      recorder must slot away anything derived from the utterance and REFUSE
 *      to save anything else it can't prove is a UI label.
 *   2. STALENESS: when an app's UI changes, replay must MISS CLEANLY (and hand
 *      off to the agent) rather than press whatever is nearby.
 *   3. SAFETY: replay is not a trust bypass — the risk rulebook is re-applied
 *      at replay time, because a control's meaning can change.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
    compilePattern, matchRecipe, interpolate, checkLiteral, isShareable,
    resolveSelector, recordRecipe, Recipe, ResolvableElement,
} from '../electron/recipes';
import { replayRecipe, ReplayDeps } from '../electron/recipePlayer';
import * as store from '../electron/recipeStore';

const el = (id: number, name: string, type = 'Button', invoke = true, value = false): ResolvableElement =>
    ({ id, name, type, invoke, value });

const SPOTIFY: Recipe = {
    id: 'spotify.play',
    describe: 'Play on Spotify',
    patterns: ['play {query} on spotify', 'open spotify and play {query}'],
    slots: ['query'],
    source: 'builtin',
    steps: [
        { action: 'deeplink', uri: 'spotify:search:{{query}}' },
        { action: 'click', target: { name: 'Play', type: 'Button', invokable: true } },
    ],
};

describe('intent matching', () => {
    it('captures slots from natural phrasings', () => {
        const m = matchRecipe('play we will rock you on spotify', [SPOTIFY])!;
        expect(m.recipe.id).toBe('spotify.play');
        expect(m.slots.query).toBe('we will rock you');
        expect(matchRecipe('open spotify and play bohemian rhapsody', [SPOTIFY])!.slots.query)
            .toBe('bohemian rhapsody');
    });
    it('ignores unrelated utterances and empty slots', () => {
        expect(matchRecipe('what is the weather', [SPOTIFY])).toBeNull();
        expect(matchRecipe('play  on spotify', [SPOTIFY])).toBeNull();
    });
    it('skips quarantined recipes', () => {
        const sick = { ...SPOTIFY, stats: { successes: 0, failures: 3, quarantined: true } };
        expect(matchRecipe('play x on spotify', [sick])).toBeNull();
    });
    it('prefers the more specific pattern', () => {
        const generic: Recipe = { ...SPOTIFY, id: 'generic', patterns: ['play {query}'] };
        expect(matchRecipe('play abbey road on spotify', [generic, SPOTIFY])!.recipe.id).toBe('spotify.play');
    });
    it('compilePattern tolerates spacing', () => {
        expect(compilePattern('play {q} on spotify').test('play   x   on spotify')).toBe(true);
    });
    it('interpolates slots', () => {
        expect(interpolate('spotify:search:{{query}}', { query: 'queen' })).toBe('spotify:search:queen');
    });
});

describe('PRIVACY — recipes store structure, never the user’s words', () => {
    it('slots away a message rather than storing it', () => {
        const r = recordRecipe({
            id: 'telegram.compose',
            describe: 'Message on Telegram',
            utterance: 'message Daniel on telegram are you good for lunch on Tuesday',
            actions: [
                { kind: 'launch', app: 'telegram' },
                { kind: 'click', label: 'Search' },
                { kind: 'type', text: 'Daniel' },
                { kind: 'type', label: 'Write a message', text: 'are you good for lunch on Tuesday' },
            ],
        });
        expect(r.ok).toBe(true);
        const json = JSON.stringify((r as any).recipe);
        // The actual words must appear NOWHERE in what gets persisted.
        expect(json).not.toMatch(/lunch/i);
        expect(json).not.toMatch(/Daniel/);
        expect(json).toMatch(/\{\{/); // they became slot references
    });

    it('refuses to record typed text it cannot prove is impersonal', () => {
        const r = recordRecipe({
            id: 'x', describe: 'x',
            utterance: 'do the thing',                       // text is NOT from the utterance
            actions: [{ kind: 'type', text: 'my password is hunter2 and my email is a@b.com' }],
        });
        expect(r.ok).toBe(false);
    });

    it('checkLiteral catches personal data', () => {
        expect(checkLiteral('C:\\Users\\Hilal\\Documents').ok).toBe(false);
        expect(checkLiteral('someone@example.com').ok).toBe(false);
        expect(checkLiteral('+1 555 123 4567').ok).toBe(false);
        expect(checkLiteral('my password').ok).toBe(false);
        expect(checkLiteral('a'.repeat(200)).ok).toBe(false);
        // Ordinary UI labels stay fine.
        expect(checkLiteral('Play').ok).toBe(true);
        expect(checkLiteral('Write a message').ok).toBe(true);
    });

    it('isShareable gates the whole recipe, not just typed text', () => {
        const leaky: Recipe = {
            ...SPOTIFY,
            steps: [{ action: 'click', target: { name: 'C:\\Users\\Hilal\\secret.txt' } }],
        };
        expect(isShareable(leaky).ok).toBe(false);
        expect(isShareable(SPOTIFY).ok).toBe(true);
    });

    it('the shipped builtin pack is clean AND every recipe records how it was verified', async () => {
        const { readFileSync } = await import('fs');
        const { join } = await import('path');
        const pack: Recipe[] = JSON.parse(
            readFileSync(join(process.cwd(), 'recipes', 'builtin.json'), 'utf-8'));
        expect(pack.length).toBeGreaterThan(0);
        for (const r of pack) {
            expect(isShareable(r), `${r.id}: ${isShareable(r).reason}`).toEqual({ ok: true });
            // `verified` must cite an actual observed run — a date and what
            // was seen. Reasoning about why a recipe *should* work ("URL
            // only", "looks safe") is not evidence and must not ship.
            expect(r.verified, `${r.id} has no verification note`).toBeTruthy();
            expect(r.verified, `${r.id}: verified must cite a dated, observed run`)
                .toMatch(/\d{4}-\d{2}-\d{2}/);
        }
    });
});

describe('STALENESS — selectors resolve live, never positionally', () => {
    const tree = [el(1, 'Search'), el(5, 'Play'), el(9, 'Shuffle')];

    it('resolves a control by its label', () => {
        expect(resolveSelector({ name: 'Play' }, tree, {})).toEqual({ ok: true, id: 5 });
    });
    it('misses cleanly when the label is gone (app updated)', () => {
        const r = resolveSelector({ name: 'Play' }, [el(1, 'Search'), el(9, 'Shuffle')], {});
        expect(r.ok).toBe(false);
    });
    it('treats ambiguity as failure rather than guessing', () => {
        const r = resolveSelector({ name: 'Play' }, [el(1, 'Play'), el(2, 'Play')], {});
        expect(r.ok).toBe(false);
        expect((r as any).reason).toMatch(/matches 2/);
    });
    it('resolves a label supplied at runtime by a slot', () => {
        const r = resolveSelector({ nameFromSlot: 'query' },
            [el(3, 'We Will Rock You - Remastered 2011', 'ListItem')], { query: 'we will rock you' });
        expect(r).toEqual({ ok: true, id: 3 });
    });
    it('honours type and capability filters', () => {
        const mixed = [el(1, 'Send', 'Button', false), el(2, 'Send', 'Edit', true, true)];
        expect(resolveSelector({ name: 'Send', editable: true }, mixed, {})).toEqual({ ok: true, id: 2 });
    });
});

// --- replay -----------------------------------------------------------------

function makeDeps(elements: ResolvableElement[], over: Partial<ReplayDeps> = {}) {
    const acted: string[] = [];
    const deps: ReplayDeps & { acted: string[] } = {
        acted,
        perceive: async () => ({ elements, windowTitle: 'App' }),
        launchApp: async (a) => { acted.push(`launch:${a}`); },
        openUri: async (u) => { acted.push(`uri:${u}`); },
        invokeElement: async (id) => { acted.push(`invoke:${id}`); return { ok: true }; },
        setValue: async (id, t) => { acted.push(`set:${id}:${t}`); return { ok: true }; },
        typeText: async (t) => { acted.push(`type:${t}`); return true; },
        pressKeys: async (k) => { acted.push(`keys:${k.join('+')}`); return true; },
        requestConfirm: async () => true,
        delay: async () => {},
        ...over,
    };
    return deps;
}

describe('replay', () => {
    it('runs a recipe end to end', async () => {
        const deps = makeDeps([el(5, 'Play')]);
        const out = await replayRecipe(SPOTIFY, { query: 'queen' }, deps);
        expect(out.status).toBe('done');
        expect(deps.acted).toEqual(['uri:spotify:search:queen', 'invoke:5']);
    });

    it('reports STALE (not a wrong click) when the UI changed', async () => {
        const deps = makeDeps([el(5, 'Start Playback')]); // "Play" was renamed
        const out = await replayRecipe(SPOTIFY, { query: 'queen' }, deps) as any;
        expect(out.status).toBe('stale');
        expect(out.atStep).toBe(2);
        // Crucially: nothing was clicked.
        expect(deps.acted.filter(a => a.startsWith('invoke:'))).toEqual([]);
    });

    it('re-applies the risk rulebook at replay time', async () => {
        // A control that is now a "Send" must still prompt, even though the
        // recipe was recorded when pressing it was unremarkable.
        const recipe: Recipe = {
            ...SPOTIFY, id: 'x', steps: [{ action: 'click', target: { name: 'Send' } }],
        };
        let asked = false;
        const deps = makeDeps([el(1, 'Send')], {
            requestConfirm: async () => { asked = true; return false; },
        });
        const out = await replayRecipe(recipe, {}, deps);
        expect(asked).toBe(true);
        expect(out.status).toBe('cancelled');
        expect(deps.acted).toEqual([]);
    });

    it('refuses outright on a credential field', async () => {
        const recipe: Recipe = { ...SPOTIFY, id: 'x', steps: [{ action: 'click', target: { name: 'Password' } }] };
        const out = await replayRecipe(recipe, {}, makeDeps([el(1, 'Password')])) as any;
        expect(out.status).toBe('refused');
    });

    it('stops immediately when aborted', async () => {
        const ac = new AbortController();
        ac.abort();
        const deps = makeDeps([el(5, 'Play')], { signal: ac.signal });
        expect((await replayRecipe(SPOTIFY, { query: 'q' }, deps)).status).toBe('aborted');
        expect(deps.acted).toEqual([]);
    });

    it('fills text via a slot without the value ever being in the recipe', async () => {
        const compose: Recipe = {
            id: 'telegram.compose', describe: 'compose', patterns: ['message {contact} {message}'],
            slots: ['contact', 'message'], source: 'builtin',
            steps: [{ action: 'type', target: { name: 'Write a message', editable: true }, text: '{{message}}' }],
        };
        const deps = makeDeps([el(7, 'Write a message', 'Edit', false, true)]);
        const out = await replayRecipe(compose, { contact: 'Daniel', message: 'lunch tuesday?' }, deps);
        expect(out.status).toBe('done');
        expect(deps.acted).toEqual(['set:7:lunch tuesday?']);
        expect(JSON.stringify(compose)).not.toMatch(/lunch/i);
    });
});

describe('store — quarantine and self-healing', () => {
    beforeEach(() => store.__setForTest([SPOTIFY], []));

    it('quarantines a recipe after repeated failures', () => {
        expect(store.isQuarantined('spotify.play')).toBe(false);
        store.recordFailure('spotify.play');
        store.recordFailure('spotify.play');
        expect(store.isQuarantined('spotify.play')).toBe(false);
        store.recordFailure('spotify.play');
        expect(store.isQuarantined('spotify.play')).toBe(true);
        // …and stops being matched, so it no longer wastes time.
        expect(store.findRecipe('play x on spotify')).toBeNull();
    });

    it('a later success rehabilitates it', () => {
        store.recordFailure('spotify.play');
        store.recordFailure('spotify.play');
        store.recordFailure('spotify.play');
        store.recordSuccess('spotify.play');
        expect(store.isQuarantined('spotify.play')).toBe(false);
        expect(store.findRecipe('play x on spotify')).not.toBeNull();
    });

    it('a learned recipe supersedes a stale builtin of the same id', () => {
        const repaired: Recipe = { ...SPOTIFY, source: 'learned', describe: 'repaired', steps: [{ action: 'key', keys: ['enter'] }] };
        expect(store.learn(repaired).saved).toBe(true);
        const all = store.allRecipes().filter(r => r.id === 'spotify.play');
        expect(all).toHaveLength(1);
        expect(all[0].describe).toBe('repaired');
    });

    it('refuses to persist a recipe carrying personal data', () => {
        const leaky: Recipe = { ...SPOTIFY, id: 'leaky', steps: [{ action: 'type', text: 'call me at +1 555 123 4567' }] };
        const r = store.learn(leaky);
        expect(r.saved).toBe(false);
        expect(store.allRecipes().find(x => x.id === 'leaky')).toBeUndefined();
    });

    it('only exports recipes that pass the privacy gate', () => {
        store.__setForTest([SPOTIFY], [{ ...SPOTIFY, id: 'bad', steps: [{ action: 'click', target: { name: 'a@b.com' } }] }]);
        expect(store.exportable().map(r => r.id)).toEqual(['spotify.play']);
    });
});
