/**
 * Command-mode orchestrator — transcript in, staged execution out.
 *
 * Drives one spoken command through: routing (local LLM) → optional
 * confirmation gate → execution → result. Every transition is emitted as a
 * stage event so the capsule UI narrates exactly what is happening, and every
 * failure path emits an honest 'error'/'cancelled' stage — this function
 * never throws.
 *
 * Confirmation contract: for tools with `confirm: true`, a 'proposal' stage is
 * emitted and execution waits until resolveConfirmation() is called (wired to
 * the capsule's Confirm/Cancel via IPC) or the timeout lapses (auto-cancel —
 * an unanswered proposal must never execute).
 */

import type { RouteResult } from './llmRouter';
import { getTool, toOpenAiTools, CommandDeps, ToolOutcome } from './commandTools';
import { matchFastPath } from './fastPath';

export type CommandStage =
    | { stage: 'listening' }
    | { stage: 'routing'; transcript: string }
    | { stage: 'proposal'; transcript: string; tool: string; description: string; reason?: string }
    | { stage: 'executing'; description: string }
    // Screen-agent narration (computer_use): one event per action taken, plus
    // mid-flight confirmation when a click hits the rulebook's confirm tier.
    | { stage: 'agent_step'; step: number; maxSteps: number; description: string }
    | { stage: 'agent_confirm'; description: string; reason: string }
    | { stage: 'done'; message: string; detail?: string; transcript: string; tool: string }
    | { stage: 'clarify'; question: string; transcript: string }
    | { stage: 'cancelled'; description: string }
    | { stage: 'refused'; description: string; reason: string }
    | { stage: 'error'; message: string; transcript?: string };

export interface CommandRuntime {
    route: (utterance: string, tools: unknown[]) => Promise<RouteResult>;
    deps: CommandDeps;
    emit: (s: CommandStage) => void;
    confirmTimeoutMs?: number;
    /** Set false to force LLM routing (tests that exercise the router). */
    fastPath?: boolean;
    /**
     * "Learn once, replay fast" — try a known recipe before spending an LLM
     * call. Resolves handled:false when no recipe matched OR when one matched
     * but went stale (the app changed), in which case we fall through to the
     * agent, which can look at the new UI and work it out.
     */
    tryRecipe?: (utterance: string) => Promise<{
        handled: boolean;
        message?: string;
        detail?: string;
        note?: string;
    }>;
}

let pendingConfirmation: ((approved: boolean) => void) | null = null;

/** Resolve the outstanding proposal (from the capsule buttons / keys). */
export function resolveConfirmation(approved: boolean): boolean {
    if (!pendingConfirmation) return false;
    const resolve = pendingConfirmation;
    pendingConfirmation = null;
    resolve(approved);
    return true;
}

export function hasPendingConfirmation(): boolean {
    return pendingConfirmation !== null;
}

/**
 * Wait for the user's Confirm/Cancel — shared by the proposal gate below and
 * the screen agent's mid-task click gates (both resolve via the same
 * command-confirm IPC → resolveConfirmation).
 */
export function awaitUserConfirmation(timeoutMs: number): Promise<boolean> {
    return awaitConfirmation(timeoutMs);
}

function awaitConfirmation(timeoutMs: number): Promise<boolean> {
    // A newer proposal supersedes any stale one (auto-decline the old).
    if (pendingConfirmation) resolveConfirmation(false);
    return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
            if (pendingConfirmation === wrapped) {
                pendingConfirmation = null;
                resolve(false);
            }
        }, timeoutMs);
        const wrapped = (approved: boolean) => {
            clearTimeout(timer);
            resolve(approved);
        };
        pendingConfirmation = wrapped;
    });
}

/**
 * Run one command end to end. Returns the terminal stage (also emitted).
 */
export async function runCommand(transcript: string, rt: CommandRuntime): Promise<CommandStage> {
    const finish = (s: CommandStage): CommandStage => { rt.emit(s); return s; };
    const text = transcript.trim();
    if (!text) return finish({ stage: 'error', message: 'Nothing was heard' });

    // FAST PATH: the commands people repeat all day ("open X", "play Y on
    // spotify", "search for Z") are unambiguous — match them with patterns in
    // <1ms instead of paying 600-4000ms for an LLM round-trip. Everything
    // downstream (rulebook, confirmation, history) is identical; only the
    // decision is faster. Anything ambiguous returns null and routes normally.
    // A known recipe is both faster and more capable than a single tool call
    // (it can be several steps), so try it before anything else. If the app
    // has changed under it, it reports stale and we continue as if it never
    // matched — the agent below can still get the job done.
    if (rt.tryRecipe) {
        try {
            const r = await rt.tryRecipe(text);
            if (r.handled) {
                return finish({
                    stage: 'done',
                    message: r.note ? `${r.message} — ${r.note}` : (r.message ?? 'Done'),
                    detail: r.detail,
                    transcript: text,
                    tool: 'recipe',
                });
            }
        } catch (e: any) {
            console.warn('[Command] recipe attempt failed, falling through:', e?.message || e);
        }
    }

    const fast = rt.fastPath === false ? null : matchFastPath(text);

    let routed: RouteResult;
    if (fast) {
        routed = { tool: fast.tool, args: fast.args, ms: 0 };
        console.log(`[Command] fast path (${fast.via}) → ${fast.tool} — no LLM`);
    } else {
        rt.emit({ stage: 'routing', transcript: text });
        try {
            routed = await rt.route(text, toOpenAiTools());
        } catch (e: any) {
            return finish({ stage: 'error', message: e?.message || 'Routing failed', transcript: text });
        }
    }

    const tool = getTool(routed.tool);
    if (!tool) {
        return finish({ stage: 'error', message: `Unknown action "${routed.tool}"`, transcript: text });
    }

    // The clarify tool is a conversation, not an action.
    if (tool.name === 'clarify') {
        const q = String(routed.args.question ?? 'Could you rephrase that?');
        return finish({ stage: 'clarify', question: q, transcript: text });
    }

    const description = tool.describe(routed.args);

    // Apply the risk rulebook to the ACTUAL arguments (see commandTools.ts):
    // auto → just do it; confirm → proposal card; refuse → explain, never run.
    const risk = tool.assessRisk(routed.args);
    if (risk.level === 'refuse') {
        return finish({ stage: 'refused', description, reason: risk.reason ?? 'This action is not allowed' });
    }
    if (risk.level === 'confirm') {
        rt.emit({ stage: 'proposal', transcript: text, tool: tool.name, description, reason: risk.reason });
        const approved = await awaitConfirmation(rt.confirmTimeoutMs ?? 15_000);
        if (!approved) {
            return finish({ stage: 'cancelled', description });
        }
    }

    rt.emit({ stage: 'executing', description });
    let outcome: ToolOutcome;
    try {
        outcome = await tool.execute(routed.args, rt.deps);
    } catch (e: any) {
        return finish({ stage: 'error', message: e?.message || 'Action failed', transcript: text });
    }

    return finish({ stage: 'done', message: outcome.message, detail: outcome.detail, transcript: text, tool: tool.name });
}
