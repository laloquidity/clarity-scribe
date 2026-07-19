/**
 * Agent loop — Scribe's screen agent: perceive → decide → act, until done.
 *
 * v2, accessibility-first (modeled on Microsoft UFO²'s hybrid design):
 *   PERCEIVE  the focused window's REAL controls via the UI Automation tree
 *             (uiaProbe, ~100ms, exact names + exact screen rectangles).
 *             Vision (OmniParser) is only the fallback for surfaces that
 *             expose no usable tree — games, canvas apps. The perceive dep
 *             owns that fallback; the loop just consumes elements.
 *   DECIDE    one action per turn from the local LLM (set-of-marks: the model
 *             picks a numbered element, never coordinates).
 *   ACT       programmatically when possible (InvokePattern/ValuePattern —
 *             cannot misclick), physically (SendInput) only as fallback and
 *             only after verifying the target window is still foreground.
 *
 * Safety learned the hard way (v1 misclicked a desktop icon and launched a
 * game): every physical action is WINDOW-SCOPED — the loop pins the window it
 * is driving, re-checks the foreground pid before touching the mouse, and
 * re-perceives instead of clicking stale coordinates. Plus: hard step cap,
 * wall-clock deadline, identical-action loop detection, one launch per app
 * name per task (no relaunch storms), abort signal checked before AND
 * propagated INTO every slow call so Esc stops mid-flight, and rulebook gates
 * (agentPolicy) on every click. The loop never throws.
 */

import { assessClick } from './agentPolicy';

export interface AgentElement {
    id: number;
    name: string;
    type: string;
    /** [left, top, right, bottom] in physical screen pixels. */
    rect: [number, number, number, number];
    /** Supports programmatic activation (Invoke/Toggle/Select). */
    invoke: boolean;
    /** Supports atomic text set (ValuePattern). */
    value: boolean;
}

export interface AgentWindow {
    title: string;
    hwnd: number;
    pid: number;
    rect: [number, number, number, number];
}

export interface Perception {
    source: 'uia' | 'vision';
    window: AgentWindow | null;
    elements: AgentElement[];
}

export interface AgentAction {
    tool: string;
    args: Record<string, any>;
}

export interface AgentDeps {
    /** AT-first perception (vision fallback inside). null hwnd = foreground. */
    perceive: (pinnedHwnd: number | null, signal?: AbortSignal) => Promise<Perception>;
    decide: (messages: Array<{ role: string; content: string }>, tools: unknown[], signal?: AbortSignal) => Promise<AgentAction>;
    act: {
        /** Programmatic activation by element id from the last perception. */
        invokeElement: (id: number) => Promise<{ ok: boolean; error?: string }>;
        /** Atomic text set (focuses the element first). */
        setValue: (id: number, text: string) => Promise<{ ok: boolean; error?: string }>;
        focusElement: (id: number) => Promise<{ ok: boolean }>;
        /** Physical click at PHYSICAL SCREEN pixels. */
        clickAtScreen: (x: number, y: number) => Promise<boolean>;
        typeText: (text: string) => Promise<boolean>;
        pressKeys: (keys: string[]) => Promise<boolean>;
        scrollWheel: (clicks: number) => Promise<boolean>;
        launchApp: (name: string) => Promise<void>;
        /** Foreground guard primitives. */
        getForegroundPid: () => number | null;
        focusWindow: (hwnd: number) => Promise<boolean>;
        /** Find a just-launched app's top-level window by name (hwnd or null). */
        findAppWindow: (name: string) => Promise<number | null>;
    };
    requestConfirm: (description: string, reason: string) => Promise<boolean>;
    onStep: (e: { step: number; maxSteps: number; description: string }) => void;
    signal?: AbortSignal;
    maxSteps?: number;
    deadlineMs?: number;
    /** Test seam: scales settle waits (0 = none). */
    settleScale?: number;
}

export interface AgentResult {
    ok: boolean;
    summary: string;
    steps: string[];
    stepsTaken: number;
}

const SYSTEM_PROMPT = `You control a Windows computer to complete the user's task, one action per turn.
Each turn you see the task, your previous actions, the current window title, and its controls as a numbered list.
Rules:
- Call exactly one tool per turn. Element ids MUST come from the current list.
- If the app you need is not the current window, call launch_app with its name, then wait.
- To search or fill a field: use type_into on the field element (it replaces the field's text; submit=true presses Enter). Do not click the field first — type_into handles focus.
- To activate buttons, links, or list items (e.g. play a search result): click them.
- The control list is your only truth. If what you expect is not there yet, call wait; if it should exist elsewhere, scroll.
- Call done the moment the task is complete. Call give_up if stuck after several tries or the task needs something unavailable.
- Never interact with password or payment fields.`;

export const AGENT_STEP_TOOLS: unknown[] = [
    { type: 'function', function: { name: 'click', description: 'Activate a control by its id (button, link, list item, tab…).', parameters: { type: 'object', properties: { id: { type: 'number' }, why: { type: 'string' } }, required: ['id'] } } },
    { type: 'function', function: { name: 'type_into', description: 'Put text into an input/search field by id, replacing its content. submit=true presses Enter after.', parameters: { type: 'object', properties: { id: { type: 'number' }, text: { type: 'string' }, submit: { type: 'boolean' } }, required: ['id', 'text'] } } },
    { type: 'function', function: { name: 'type', description: 'Type text into whatever currently has keyboard focus (appends).', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } },
    { type: 'function', function: { name: 'press_keys', description: 'Press a key or combo, e.g. ["enter"], ["ctrl","k"].', parameters: { type: 'object', properties: { keys: { type: 'array', items: { type: 'string' } } }, required: ['keys'] } } },
    { type: 'function', function: { name: 'scroll', description: 'Scroll the current window up or down.', parameters: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down'] } }, required: ['direction'] } } },
    { type: 'function', function: { name: 'launch_app', description: 'Launch an application by name when its window is not the current one.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
    { type: 'function', function: { name: 'wait', description: 'Do nothing briefly — the window is still loading or changing.', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'done', description: 'The task is complete.', parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } } },
    { type: 'function', function: { name: 'give_up', description: 'The task cannot be completed.', parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } } },
];

const MAX_ELEMENTS_IN_PROMPT = 110;

/** Compact one perception into the numbered list the model reads. */
export function formatElements(elements: AgentElement[]): string {
    const shown = elements.slice(0, MAX_ELEMENTS_IN_PROMPT);
    const lines = shown.map(e => {
        const label = (e.name || '(no label)').replace(/\s+/g, ' ').substring(0, 80);
        const kind = e.value ? 'input' : e.type.toLowerCase();
        return `[${e.id}] "${label}" (${kind})`;
    });
    if (elements.length > shown.length) lines.push(`…and ${elements.length - shown.length} more (scroll to reveal)`);
    return lines.join('\n');
}

function describeAction(a: AgentAction, elements: AgentElement[]): string {
    const el = (id: any) => {
        const e = elements.find(x => x.id === Number(id));
        return e?.name ? `"${e.name.substring(0, 48)}"` : `element ${id}`;
    };
    switch (a.tool) {
        case 'click': return `Click ${el(a.args.id)}`;
        case 'type_into': return `Type "${String(a.args.text ?? '').substring(0, 40)}" into ${el(a.args.id)}${a.args.submit ? ', press Enter' : ''}`;
        case 'type': return `Type "${String(a.args.text ?? '').substring(0, 48)}"`;
        case 'press_keys': return `Press ${(a.args.keys ?? []).join('+')}`;
        case 'scroll': return `Scroll ${a.args.direction ?? 'down'}`;
        case 'launch_app': return `Launch ${a.args.name}`;
        case 'wait': return 'Wait for the window';
        case 'done': return String(a.args.summary ?? 'Task complete');
        case 'give_up': return String(a.args.reason ?? 'Could not complete the task');
        default: return a.tool;
    }
}

function settleFor(tool: string): number {
    switch (tool) {
        case 'launch_app': return 2000;
        case 'wait': return 1200;
        case 'click': return 700;
        case 'type_into': return 500;
        default: return 400;
    }
}

const center = (r: [number, number, number, number]) =>
    ({ x: (r[0] + r[2]) / 2, y: (r[1] + r[3]) / 2 });

/** Run one goal to completion. Never throws. */
export async function runAgentTask(goal: string, deps: AgentDeps): Promise<AgentResult> {
    const maxSteps = deps.maxSteps ?? 12;
    const deadline = Date.now() + (deps.deadlineMs ?? 180_000);
    const settleScale = deps.settleScale ?? 1;
    const history: string[] = [];
    const finish = (ok: boolean, summary: string): AgentResult =>
        ({ ok, summary, steps: history.slice(), stepsTaken: history.length });
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms * settleScale));
    const aborted = () => deps.signal?.aborted === true;

    let anchorHwnd: number | null = null;   // app window we're driving (launch target)
    let lastActionKey = '';
    let repeats = 0;
    const launched = new Set<string>();     // one launch per app name per task

    /**
     * Physical input is only allowed when the pinned window is foreground —
     * this is the guard that makes "misclick opens another app" impossible.
     * Returns true when it is safe to touch mouse/keyboard.
     */
    async function foregroundGuard(win: AgentWindow | null): Promise<boolean> {
        if (!win) return true; // nothing to scope to (pre-launch desktop state)
        const fg = deps.act.getForegroundPid();
        if (fg === win.pid) return true;
        await deps.act.focusWindow(win.hwnd);
        await sleep(150);
        return deps.act.getForegroundPid() === win.pid;
    }

    for (let step = 1; step <= maxSteps; step++) {
        if (aborted()) return finish(false, 'Stopped by you');
        if (Date.now() > deadline) return finish(false, `Ran out of time after ${history.length} steps`);

        // 1. perceive — the launched app window if we have one (anchor),
        // otherwise the foreground (AT-first; ~100-200ms happy path). The
        // anchor makes the loop robust when GetForegroundWindow is empty
        // (foreground-lock after a background process launches an app).
        const t0 = Date.now();
        let seen: Perception;
        try {
            seen = await deps.perceive(anchorHwnd, deps.signal);
        } catch (e: any) {
            if (aborted()) return finish(false, 'Stopped by you');
            return finish(false, `Could not read the screen: ${e?.message || e}`);
        }
        const perceiveMs = Date.now() - t0;
        if (aborted()) return finish(false, 'Stopped by you');

        // 2. decide
        const context = [
            `TASK: ${goal}`,
            '',
            history.length ? `PREVIOUS ACTIONS:\n${history.map((s, i) => `${i + 1}. ${s}`).join('\n')}` : 'PREVIOUS ACTIONS: none yet',
            '',
            `CURRENT WINDOW: ${seen.window ? `"${seen.window.title}"` : '(none — desktop)'}`,
            `CONTROLS:\n${seen.elements.length ? formatElements(seen.elements) : '(none detected)'}`,
        ].join('\n');
        const t1 = Date.now();
        let action: AgentAction;
        try {
            action = await deps.decide(
                [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: context }],
                AGENT_STEP_TOOLS,
                deps.signal,
            );
        } catch (e: any) {
            if (aborted()) return finish(false, 'Stopped by you');
            return finish(false, `Decision failed: ${e?.message || e}`);
        }
        const decideMs = Date.now() - t1;
        if (aborted()) return finish(false, 'Stopped by you');

        const description = describeAction(action, seen.elements);
        console.log(`[Agent] step ${step}: look ${perceiveMs}ms (${seen.source}, ${seen.elements.length} controls) | think ${decideMs}ms → ${description}`);

        if (action.tool === 'done') return finish(true, description);
        if (action.tool === 'give_up') return finish(false, description);

        // loop detection: same exact action 3× in a row = stuck
        const key = JSON.stringify([action.tool, action.args]);
        repeats = key === lastActionKey ? repeats + 1 : 0;
        lastActionKey = key;
        if (repeats >= 2) return finish(false, `Gave up — kept repeating "${description}"`);

        // rulebook gate on click targets (see agentPolicy)
        const targetOf = (id: any) => seen.elements.find(e => e.id === Number(id));
        if (action.tool === 'click') {
            const target = targetOf(action.args.id);
            if (!target) { history.push(`${description} → failed (no such control)`); continue; }
            const risk = assessClick({ content: target.name });
            if (risk.level === 'refuse') return finish(false, `Refused: ${risk.reason}`);
            if (risk.level === 'confirm') {
                const approved = await deps.requestConfirm(description, risk.reason ?? 'This needs your approval');
                if (!approved) return finish(false, `Cancelled at "${description}"`);
            }
        }

        deps.onStep({ step, maxSteps, description });

        // 3. act
        let ok = true;
        let note = '';
        try {
            switch (action.tool) {
                case 'click': {
                    const target = targetOf(action.args.id)!;
                    // Programmatic first: cannot land anywhere but THIS control.
                    let done = false;
                    if (seen.source === 'uia' && (target.invoke)) {
                        done = (await deps.act.invokeElement(target.id)).ok;
                        if (done) note = ' (native)';
                    }
                    if (!done) {
                        if (!(await foregroundGuard(seen.window))) { ok = false; note = ' (window lost focus)'; break; }
                        const { x, y } = center(target.rect);
                        ok = await deps.act.clickAtScreen(x, y);
                    }
                    break;
                }
                case 'type_into': {
                    const target = targetOf(action.args.id);
                    if (!target) { ok = false; note = ' (no such control)'; break; }
                    const text = String(action.args.text ?? '');
                    let set = false;
                    if (seen.source === 'uia' && target.value) {
                        set = (await deps.act.setValue(target.id, text)).ok;
                        if (set) note = ' (native)';
                    }
                    if (!set) {
                        if (!(await foregroundGuard(seen.window))) { ok = false; note = ' (window lost focus)'; break; }
                        // UIA focus only maps for UIA ids; for vision the
                        // physical click below is what focuses the field.
                        if (seen.source === 'uia') await deps.act.focusElement(target.id).catch(() => ({ ok: false }));
                        const { x, y } = center(target.rect);
                        await deps.act.clickAtScreen(x, y);
                        await sleep(120);
                        await deps.act.pressKeys(['ctrl', 'a']);
                        set = await deps.act.typeText(text);
                    }
                    ok = set;
                    if (ok && action.args.submit) {
                        await sleep(150);
                        ok = await deps.act.pressKeys(['enter']);
                    }
                    break;
                }
                case 'type': {
                    if (!(await foregroundGuard(seen.window))) { ok = false; note = ' (window lost focus)'; break; }
                    ok = await deps.act.typeText(String(action.args.text ?? ''));
                    break;
                }
                case 'press_keys': {
                    if (!(await foregroundGuard(seen.window))) { ok = false; note = ' (window lost focus)'; break; }
                    ok = await deps.act.pressKeys((action.args.keys ?? []).map(String));
                    break;
                }
                case 'scroll': {
                    if (!(await foregroundGuard(seen.window))) { ok = false; note = ' (window lost focus)'; break; }
                    ok = await deps.act.scrollWheel(action.args.direction === 'up' ? 3 : -3);
                    break;
                }
                case 'launch_app': {
                    const name = String(action.args.name ?? '').toLowerCase().trim();
                    if (launched.has(name)) { ok = false; note = ' (already launched — wait for it instead)'; break; }
                    launched.add(name);
                    await deps.act.launchApp(name);
                    // Poll for the app's OWN window (by name), then focus it and
                    // anchor perception to it. Robust even when the app opens
                    // without stealing foreground (Windows foreground-lock).
                    ok = false;
                    for (let i = 0; i < 24 && !aborted(); i++) {
                        await sleep(500);
                        const hwnd = await deps.act.findAppWindow(name).catch(() => null);
                        if (hwnd) {
                            anchorHwnd = hwnd;
                            await deps.act.focusWindow(hwnd);
                            note = ' → app window found';
                            ok = true;
                            break;
                        }
                    }
                    if (!ok) note = ' (app window never appeared)';
                    break;
                }
                case 'wait':
                    break;
                default:
                    history.push(`${action.tool} → failed (unknown action)`);
                    continue;
            }
        } catch (e: any) {
            ok = false;
        }
        history.push(`${description} → ${ok ? 'ok' : 'failed'}${note}`);

        if (aborted()) return finish(false, 'Stopped by you');
        await sleep(settleFor(action.tool));
    }

    return finish(false, `Stopped after ${maxSteps} steps without finishing`);
}
