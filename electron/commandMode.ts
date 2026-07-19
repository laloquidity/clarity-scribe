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

export type CommandStage =
    | { stage: 'listening' }
    | { stage: 'routing'; transcript: string }
    | { stage: 'proposal'; transcript: string; tool: string; description: string; reason?: string }
    | { stage: 'executing'; description: string }
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

    rt.emit({ stage: 'routing', transcript: text });

    let routed: RouteResult;
    try {
        routed = await rt.route(text, toOpenAiTools());
    } catch (e: any) {
        return finish({ stage: 'error', message: e?.message || 'Routing failed', transcript: text });
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
