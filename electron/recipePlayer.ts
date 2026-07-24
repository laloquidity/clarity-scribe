/**
 * recipePlayer — replay a Recipe, and cope with the app having changed.
 *
 * ── WHAT HAPPENS WHEN AN APP UPDATES ─────────────────────────────────────
 * Recipes address controls by label against the live accessibility tree
 * (recipes.ts, invariant #2), so a renamed, moved, or removed control
 * produces a CLEAN MISS rather than a wrong click. Ambiguity counts as a miss
 * too. That turns "the UI changed" from a correctness hazard into a routine,
 * detectable event, handled in three stages:
 *
 *   1. ABORT, don't improvise. The moment a step can't be resolved
 *      unambiguously, replay stops. Nothing half-done is left behind that the
 *      user didn't ask for.
 *   2. FALL BACK to the agent, which can actually look at the screen and
 *      reason about the new layout. The user still gets their outcome — just
 *      at agent speed instead of replay speed.
 *   3. SELF-HEAL. A failing recipe is counted; after repeated failures it is
 *      quarantined so it stops costing time. When the agent succeeds on the
 *      same intent, its run is recorded as a fresh recipe that supersedes the
 *      stale one. The system repairs itself instead of rotting.
 *
 * Safety note: replay is NOT a trust bypass. Every click is re-assessed
 * against the risk rulebook at replay time (agentPolicy.assessClick), because
 * a control that was benign when recorded may be a "Send"/"Delete" today.
 */

import { assessClick } from './agentPolicy';
import {
    Recipe, RecipeStep, ResolvableElement, resolveSelector, interpolate,
} from './recipes';

export interface ReplayDeps {
    /** Read the target app's controls (accessibility tree). */
    perceive: () => Promise<{ elements: ResolvableElement[]; windowTitle: string } | null>;
    launchApp: (name: string) => Promise<void>;
    openUri: (uri: string) => Promise<void>;
    invokeElement: (id: number) => Promise<{ ok: boolean }>;
    setValue: (id: number, text: string) => Promise<{ ok: boolean }>;
    typeText: (text: string) => Promise<boolean>;
    pressKeys: (keys: string[]) => Promise<boolean>;
    /** Rulebook gate for a control that needs confirmation. */
    requestConfirm: (description: string, reason: string) => Promise<boolean>;
    onStep?: (e: { index: number; total: number; description: string }) => void;
    delay: (ms: number) => Promise<void>;
    signal?: AbortSignal;
}

export type ReplayOutcome =
    | { status: 'done'; steps: string[] }
    /** Recipe no longer fits the app — caller should fall back to the agent. */
    | { status: 'stale'; reason: string; atStep: number; steps: string[] }
    | { status: 'refused'; reason: string }
    | { status: 'cancelled'; reason: string }
    | { status: 'aborted' };

const DEFAULT_WAIT_TIMEOUT = 12_000;
/** Poll gaps while waiting for a control (lazy accessibility trees need time). */
const WAIT_GAPS = [400, 700, 1000, 1500, 2000, 2500, 3000];

function describeStep(step: RecipeStep, slots: Record<string, string>): string {
    switch (step.action) {
        case 'launch': return `Open ${step.app}`;
        case 'deeplink': return `Open ${interpolate(step.uri, slots).split(':')[0]} link`;
        case 'waitFor': return `Wait for ${step.target.name ?? step.target.nameFromSlot ?? 'the screen'}`;
        case 'click': return `Click ${step.target.name ?? slots[step.target.nameFromSlot ?? ''] ?? 'control'}`;
        case 'type': return `Type into ${step.target?.name ?? 'the field'}${step.submit ? ' and submit' : ''}`;
        case 'key': return `Press ${step.keys.join('+')}`;
        case 'pause': return 'Wait';
    }
}

/**
 * Run a recipe. Never throws; a 'stale' outcome is the signal to hand the
 * intent to the agent.
 */
export async function replayRecipe(
    recipe: Recipe,
    slots: Record<string, string>,
    deps: ReplayDeps,
): Promise<ReplayOutcome> {
    const done: string[] = [];
    const aborted = () => deps.signal?.aborted === true;

    for (let i = 0; i < recipe.steps.length; i++) {
        if (aborted()) return { status: 'aborted' };
        const step = recipe.steps[i];
        const description = describeStep(step, slots);
        deps.onStep?.({ index: i + 1, total: recipe.steps.length, description });

        // Steps that don't need the tree.
        if (step.action === 'launch') {
            await deps.launchApp(interpolate(step.app, slots));
            done.push(description);
            continue;
        }
        if (step.action === 'deeplink') {
            await deps.openUri(interpolate(step.uri, slots));
            done.push(description);
            continue;
        }
        if (step.action === 'pause') {
            await deps.delay(step.ms);
            continue;
        }
        if (step.action === 'key') {
            if (!(await deps.pressKeys(step.keys))) {
                return { status: 'stale', reason: `could not press ${step.keys.join('+')}`, atStep: i + 1, steps: done };
            }
            done.push(description);
            continue;
        }

        // Everything below needs a resolved control. Poll, because app UIs
        // load asynchronously and accessibility trees populate lazily.
        const timeout = (step.action === 'waitFor' && step.timeoutMs) || DEFAULT_WAIT_TIMEOUT;
        const started = Date.now();
        let elementId: number | null = null;
        let lastReason = 'control never appeared';
        let gapIdx = 0;

        while (Date.now() - started < timeout) {
            if (aborted()) return { status: 'aborted' };
            const seen = await deps.perceive();
            if (seen) {
                const target = step.action === 'type' ? step.target : step.target;
                if (!target) { elementId = -1; break; } // type into whatever has focus
                const r = resolveSelector(target, seen.elements, slots);
                if (r.ok) {
                    // Rulebook re-check: what this control means may have
                    // changed since the recipe was recorded.
                    if (step.action === 'click') {
                        const el = seen.elements.find(e => e.id === r.id);
                        const risk = assessClick({ content: el?.name ?? '' });
                        if (risk.level === 'refuse') {
                            return { status: 'refused', reason: risk.reason ?? 'blocked by policy' };
                        }
                        if (risk.level === 'confirm') {
                            const ok = await deps.requestConfirm(description, risk.reason ?? 'This needs your approval');
                            if (!ok) return { status: 'cancelled', reason: description };
                        }
                    }
                    elementId = r.id;
                    break;
                }
                lastReason = r.reason;
            }
            await deps.delay(WAIT_GAPS[Math.min(gapIdx++, WAIT_GAPS.length - 1)]);
        }

        if (elementId === null) {
            // THE UI-CHANGED PATH: stop cleanly and let the agent take over.
            return { status: 'stale', reason: lastReason, atStep: i + 1, steps: done };
        }

        if (step.action === 'waitFor') { done.push(description); continue; }

        if (step.action === 'click') {
            const r = await deps.invokeElement(elementId);
            if (!r.ok) {
                return { status: 'stale', reason: 'control would not activate', atStep: i + 1, steps: done };
            }
            done.push(description);
            continue;
        }

        if (step.action === 'type') {
            const text = interpolate(step.text, slots);
            let wrote = false;
            if (elementId >= 0) wrote = (await deps.setValue(elementId, text)).ok;
            if (!wrote) wrote = await deps.typeText(text);
            if (!wrote) {
                return { status: 'stale', reason: 'could not enter text', atStep: i + 1, steps: done };
            }
            if (step.submit) await deps.pressKeys(['enter']);
            done.push(description);
        }
    }

    return { status: 'done', steps: done };
}
