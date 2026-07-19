/**
 * Agent mode v2 (accessibility-first) — policy rulebook tiers, the
 * perceive→decide→act loop's guardrails (confirm/refuse gates, foreground
 * scoping, loop detection, step cap, abort, launch-once), and the
 * computer_use registry tool. Everything runs against injected fakes: no
 * UIA, no GPU, no screen, no LLM.
 */
import { describe, it, expect } from 'vitest';
import { assessGoal, assessClick } from '../electron/agentPolicy';
import { runAgentTask, formatElements, AgentDeps, AgentAction, AgentElement, Perception } from '../electron/agentLoop';
import { getTool } from '../electron/commandTools';

const el = (id: number, name: string, extra: Partial<AgentElement> = {}): AgentElement =>
    ({ id, name, type: 'Button', rect: [100, 100, 200, 140], invoke: false, value: false, ...extra });

describe('agentPolicy — goal tier', () => {
    it('benign in-app tasks are AUTO', () => {
        for (const g of [
            'open spotify and play we will rock you',
            'search youtube for lofi and play the first result',
            'open notepad and write a haiku about rain',
        ]) expect(assessGoal(g).level, g).toBe('auto');
    });
    it('contacting people is CONFIRM', () => {
        for (const g of [
            'open telegram and message Daniel hey I told my computer to do this lol',
            'reply to the last email saying sounds good',
            'send this to mom on whatsapp',
        ]) expect(assessGoal(g).level, g).toBe('confirm');
    });
    it('money, credentials, sign-in, and bulk deletion are REFUSE', () => {
        for (const g of [
            'buy the item in my amazon cart',
            'send $50 to john on venmo',
            'type my password into this box',
            'log into my bank account',
            'delete everything in my downloads folder',
        ]) expect(assessGoal(g).level, g).toBe('refuse');
    });
});

describe('agentPolicy — click tier', () => {
    it('ordinary controls are AUTO', () => {
        for (const label of ['Play', 'Search', 'We Will Rock You - Queen', 'Open', 'Next']) {
            expect(assessClick({ content: label }).level, label).toBe('auto');
        }
    });
    it('commit buttons (purchase/send/delete) are CONFIRM', () => {
        for (const label of ['Place order', 'Buy now', 'Send', 'Delete', 'Uninstall', 'Post']) {
            expect(assessClick({ content: label }).level, label).toBe('confirm');
        }
    });
    it('credential fields are REFUSE', () => {
        expect(assessClick({ content: 'Password' }).level).toBe('refuse');
        expect(assessClick({ content: 'Card number' }).level).toBe('refuse');
    });
});

const SPOTIFY_WINDOW = { title: 'Spotify Premium', hwnd: 777, pid: 42, rect: [0, 0, 1600, 900] as [number, number, number, number] };

/** Scripted-fake harness: decide() pops the next action off a queue. */
function makeDeps(script: AgentAction[], opts: Partial<AgentDeps> & { perception?: Perception } = {}) {
    const acted: string[] = [];
    const stepped: string[] = [];
    const perception: Perception = opts.perception ?? {
        source: 'uia',
        window: SPOTIFY_WINDOW,
        elements: [
            el(0, 'Spotify'),
            el(3, 'Search', { value: true, type: 'Edit' }),
            el(7, 'We Will Rock You', { invoke: true, type: 'ListItem' }),
            el(9, 'Send', { invoke: true }),
            el(11, 'Password', { value: true, type: 'Edit' }),
        ],
    };
    const deps: AgentDeps & { acted: string[]; stepped: string[] } = {
        acted,
        stepped,
        perceive: async () => perception,
        decide: async () => {
            const next = script.shift();
            if (!next) throw new Error('script exhausted');
            return next;
        },
        act: {
            invokeElement: async (id) => { acted.push(`invoke:${id}`); return { ok: true }; },
            setValue: async (id, text) => { acted.push(`setvalue:${id}:${text}`); return { ok: true }; },
            focusElement: async (id) => { acted.push(`focus:${id}`); return { ok: true }; },
            clickAtScreen: async (x, y) => { acted.push(`click@${Math.round(x)},${Math.round(y)}`); return true; },
            typeText: async (t) => { acted.push(`type:${t}`); return true; },
            pressKeys: async (k) => { acted.push(`keys:${k.join('+')}`); return true; },
            scrollWheel: async (c) => { acted.push(`scroll:${c}`); return true; },
            launchApp: async (n) => { acted.push(`launch:${n}`); },
            getForegroundPid: () => 42, // matches the pinned window by default
            focusWindow: async (h) => { acted.push(`focuswin:${h}`); return true; },
            findAppWindow: async (n) => { acted.push(`findwin:${n}`); return 777; },
        },
        requestConfirm: async () => true,
        onStep: (e) => stepped.push(e.description),
        settleScale: 0,
        ...opts,
    };
    return deps;
}

describe('agentLoop v2 (accessibility-first)', () => {
    it('uses NATIVE activation and atomic text set on UIA elements', async () => {
        const deps = makeDeps([
            { tool: 'type_into', args: { id: 3, text: 'we will rock you', submit: true } },
            { tool: 'click', args: { id: 7 } },
            { tool: 'done', args: { summary: 'Playing We Will Rock You' } },
        ]);
        const r = await runAgentTask('open spotify and play we will rock you', deps);
        expect(r.ok).toBe(true);
        expect(deps.acted).toEqual([
            'setvalue:3:we will rock you',  // ValuePattern, no clicking
            'keys:enter',
            'invoke:7',                     // InvokePattern — cannot misclick
        ]);
        expect(r.steps.every(s => s.includes('→ ok'))).toBe(true);
        expect(r.steps[0]).toContain('(native)');
    });

    it('falls back to a physical click only when no pattern exists — and only while the window is foreground', async () => {
        const deps = makeDeps([
            { tool: 'click', args: { id: 0 } },  // el 0 has no invoke pattern
            { tool: 'done', args: { summary: 'ok' } },
        ]);
        const r = await runAgentTask('x', deps);
        expect(r.ok).toBe(true);
        expect(deps.acted).toEqual(['click@150,120']);
    });

    it('BLOCKS physical input when the window lost focus and refocus fails (the CS2 bug)', async () => {
        const deps = makeDeps(
            [{ tool: 'click', args: { id: 0 } }, { tool: 'give_up', args: { reason: 'window gone' } }],
            {},
        );
        deps.act.getForegroundPid = () => 999; // some other app is foreground
        deps.act.focusWindow = async () => false;
        const r = await runAgentTask('x', deps);
        expect(r.ok).toBe(false);
        expect(deps.acted.filter(a => a.startsWith('click@'))).toEqual([]); // never clicked blind
        expect(r.steps[0]).toContain('window lost focus');
    });

    it('launch_app finds+focuses the app window and refuses to relaunch the same app', async () => {
        const spotify: Perception = { source: 'uia', window: SPOTIFY_WINDOW, elements: [el(0, 'Search', { value: true })] };
        const deps = makeDeps(
            [
                { tool: 'launch_app', args: { name: 'spotify' } },
                { tool: 'launch_app', args: { name: 'spotify' } },  // must NOT relaunch
                { tool: 'done', args: { summary: 'ok' } },
            ],
            { perceive: async () => spotify, settleScale: 0 },
        );
        const r = await runAgentTask('x', deps);
        expect(r.ok).toBe(true);
        expect(deps.acted.filter(a => a.startsWith('launch:'))).toEqual(['launch:spotify']); // exactly once
        expect(deps.acted).toContain('findwin:spotify'); // located the window
        expect(deps.acted).toContain('focuswin:777');    // focused it
        expect(r.steps[0]).toContain('app window found');
        expect(r.steps[1]).toContain('already launched');
    });

    it('confirm-tier click pauses; approval executes, decline cancels', async () => {
        const approve = makeDeps([{ tool: 'click', args: { id: 9 } }, { tool: 'done', args: { summary: 'Sent' } }]);
        const r1 = await runAgentTask('x', approve);
        expect(r1.ok).toBe(true);
        expect(approve.acted).toEqual(['invoke:9']);

        const declined = makeDeps([{ tool: 'click', args: { id: 9 } }], { requestConfirm: async () => false });
        const r2 = await runAgentTask('x', declined);
        expect(r2.ok).toBe(false);
        expect(r2.summary).toContain('Cancelled');
        expect(declined.acted).toEqual([]);
    });

    it('refuse-tier click (credential field) aborts the task', async () => {
        const deps = makeDeps([{ tool: 'click', args: { id: 11 } }]);
        const r = await runAgentTask('x', deps);
        expect(r.ok).toBe(false);
        expect(r.summary).toContain('Refused');
        expect(deps.acted).toEqual([]);
    });

    it('identical action repeated 3× is a stuck agent — gives up', async () => {
        const same: AgentAction = { tool: 'click', args: { id: 7 } };
        const deps = makeDeps([same, same, same, same]);
        const r = await runAgentTask('x', deps);
        expect(r.ok).toBe(false);
        expect(r.summary).toContain('repeating');
        expect(deps.acted.length).toBe(2);
    });

    it('hard step cap stops a wandering agent', async () => {
        const deps = makeDeps(
            Array.from({ length: 10 }, (_, i) => ({ tool: i % 2 ? 'wait' : 'scroll', args: i % 2 ? {} : { direction: 'down' } })),
            { maxSteps: 4 },
        );
        const r = await runAgentTask('x', deps);
        expect(r.ok).toBe(false);
        expect(r.stepsTaken).toBe(4);
    });

    it('abort signal stops before the next action', async () => {
        const ac = new AbortController();
        ac.abort();
        const deps = makeDeps([{ tool: 'click', args: { id: 7 } }], { signal: ac.signal });
        const r = await runAgentTask('x', deps);
        expect(r.ok).toBe(false);
        expect(r.summary).toBe('Stopped by you');
        expect(deps.acted).toEqual([]);
    });

    it('a hallucinated element id fails the step and lets the model repair', async () => {
        const deps = makeDeps([
            { tool: 'click', args: { id: 999 } },
            { tool: 'done', args: { summary: 'ok' } },
        ]);
        const r = await runAgentTask('x', deps);
        expect(r.ok).toBe(true);
        expect(r.steps[0]).toContain('no such control');
        expect(deps.acted).toEqual([]);
    });

    it('a broken perception pipeline resolves honestly, never throws', async () => {
        const deps = makeDeps([], { perceive: async () => { throw new Error('probe dead'); } });
        const r = await runAgentTask('x', deps);
        expect(r.ok).toBe(false);
        expect(r.summary).toContain('Could not read the screen');
    });

    it('vision perceptions never use native activation (physical clicks only)', async () => {
        const vision: Perception = {
            source: 'vision',
            window: SPOTIFY_WINDOW,
            elements: [el(0, 'Play button', { invoke: true })], // even if flagged
        };
        const deps = makeDeps(
            [{ tool: 'click', args: { id: 0 } }, { tool: 'done', args: { summary: 'ok' } }],
            { perception: vision },
        );
        await runAgentTask('x', deps);
        expect(deps.acted).toEqual(['click@150,120']); // no invoke: attempt
    });
});

describe('formatElements', () => {
    it('labels inputs, truncates names, and caps the list', () => {
        const many = Array.from({ length: 200 }, (_, i) => el(i, `item ${i}`));
        const out = formatElements([el(500, 'Search box', { value: true }), ...many]);
        expect(out).toContain('[500] "Search box" (input)');
        expect(out).toContain('more (scroll to reveal)');
    });
});

describe('computer_use registry tool', () => {
    const tool = getTool('computer_use')!;
    it('applies the goal-tier rulebook as its risk assessment', () => {
        expect(tool.assessRisk({ goal: 'open spotify and play something' }).level).toBe('auto');
        expect(tool.assessRisk({ goal: 'message daniel on telegram' }).level).toBe('confirm');
        expect(tool.assessRisk({ goal: 'buy this for me' }).level).toBe('refuse');
    });
    it('degrades honestly when the agent stack is absent', async () => {
        const out = await tool.execute({ goal: 'do a thing' }, {} as any);
        expect(out.message).toContain('not available');
    });
    it('reports the loop result with a numbered step trail', async () => {
        const out = await tool.execute({ goal: 'play music' }, {
            runAgentTask: async () => ({ ok: true, summary: 'Playing', steps: ['Type "queen" into "Search", press Enter → ok (native)'], stepsTaken: 1 }),
        } as any);
        expect(out.message).toBe('Playing ✓');
        expect(out.detail).toContain('1. Type');
    });
});
