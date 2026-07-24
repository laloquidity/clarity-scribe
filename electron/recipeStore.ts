/**
 * recipeStore — where recipes live, age, and get retired.
 *
 * Two sources, deliberately separate:
 *   · BUILTIN  (recipes/builtin.json, ships with Scribe) — curated, structure
 *     only, hand-authored. Never contains anything about a particular user.
 *   · LEARNED  (userData/recipes.json) — recorded locally from successful
 *     agent runs. Private by default; nothing is uploaded, and export runs
 *     the same isShareable() gate that guards the builtin pack.
 *
 * Learned recipes take precedence over builtin ones with the same id: when an
 * app update breaks a shipped recipe and the agent works out the new flow,
 * the local version supersedes it. That is the self-healing path.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { Recipe, isShareable, matchRecipe, RecipeMatch } from './recipes';

/** Consecutive failures before a recipe stops being tried. */
const QUARANTINE_AFTER = 3;

let builtins: Recipe[] = [];
let learned: Recipe[] = [];
let userPath: string | null = null;

function builtinPath(): string | null {
    const candidates = [
        join(__dirname, '..', 'recipes', 'builtin.json'),                 // dev
        join(process.resourcesPath ?? '', 'recipes', 'builtin.json'),     // packaged
    ];
    return candidates.find(existsSync) ?? null;
}

function readJson<T>(path: string, fallback: T): T {
    try {
        return JSON.parse(readFileSync(path, 'utf-8')) as T;
    } catch {
        return fallback;
    }
}

/**
 * Load both packs. `userDataDir` comes from Electron's app.getPath('userData')
 * — passed in so this module stays testable without Electron.
 */
export function loadRecipes(userDataDir: string | null): void {
    const bp = builtinPath();
    builtins = bp ? readJson<Recipe[]>(bp, []).map(r => ({ ...r, source: 'builtin' as const })) : [];
    if (userDataDir) {
        userPath = join(userDataDir, 'recipes.json');
        learned = readJson<Recipe[]>(userPath, []).map(r => ({ ...r, source: 'learned' as const }));
    }
    console.log(`[Recipes] ${builtins.length} builtin, ${learned.length} learned`);
}

/** Learned first so a locally-repaired recipe supersedes a stale shipped one. */
export function allRecipes(): Recipe[] {
    const byId = new Map<string, Recipe>();
    for (const r of builtins) byId.set(r.id, r);
    for (const r of learned) byId.set(r.id, r);
    return [...byId.values()];
}

export function findRecipe(utterance: string): RecipeMatch | null {
    return matchRecipe(utterance, allRecipes());
}

function persist(): void {
    if (!userPath) return;
    try {
        mkdirSync(dirname(userPath), { recursive: true });
        writeFileSync(userPath, JSON.stringify(learned, null, 2), 'utf-8');
    } catch (e) {
        console.warn('[Recipes] could not save learned recipes:', e);
    }
}

function upsertLearned(recipe: Recipe): void {
    const i = learned.findIndex(r => r.id === recipe.id);
    if (i >= 0) learned[i] = recipe; else learned.push(recipe);
    persist();
}

/** Stats live on the learned copy; a builtin gets shadowed on first update. */
function mutateStats(id: string, fn: (s: NonNullable<Recipe['stats']>) => void): void {
    let target = learned.find(r => r.id === id);
    if (!target) {
        const b = builtins.find(r => r.id === id);
        if (!b) return;
        target = { ...b, source: 'learned', stats: { successes: 0, failures: 0 } };
        learned.push(target);
    }
    target.stats = target.stats ?? { successes: 0, failures: 0 };
    fn(target.stats);
    persist();
}

export function recordSuccess(id: string): void {
    mutateStats(id, s => {
        s.successes++;
        s.failures = 0;            // consecutive counter
        s.quarantined = false;     // a win rehabilitates it
    });
}

/**
 * Count a failure. After enough consecutive misses the recipe is quarantined
 * so it stops wasting time before every fallback — the agent handles that
 * intent until a fresh recording replaces it.
 */
export function recordFailure(id: string): void {
    mutateStats(id, s => {
        s.failures++;
        if (s.failures >= QUARANTINE_AFTER) s.quarantined = true;
    });
}

export function isQuarantined(id: string): boolean {
    const r = allRecipes().find(x => x.id === id);
    return r?.stats?.quarantined === true;
}

/**
 * Save a recipe learned from a successful agent run. Refuses anything that
 * would persist personal data — a leak becomes a rejected save, not a file
 * full of someone's messages.
 */
export function learn(recipe: Recipe): { saved: boolean; reason?: string } {
    const verdict = isShareable(recipe);
    if (!verdict.ok) {
        console.warn(`[Recipes] refused to save "${recipe.id}": ${verdict.reason}`);
        return { saved: false, reason: verdict.reason };
    }
    upsertLearned({ ...recipe, source: 'learned', stats: { successes: 0, failures: 0 } });
    console.log(`[Recipes] learned "${recipe.id}" (${recipe.steps.length} steps)`);
    return { saved: true };
}

/** Recipes safe to share/export — re-checked, never assumed. */
export function exportable(): Recipe[] {
    return allRecipes().filter(r => isShareable(r).ok);
}

export function forget(id: string): void {
    learned = learned.filter(r => r.id !== id);
    persist();
}

/** Test seam. */
export function __setForTest(b: Recipe[], l: Recipe[]): void {
    builtins = b;
    learned = l;
    userPath = null;
}
