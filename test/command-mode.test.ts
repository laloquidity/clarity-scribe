/**
 * Command-mode orchestrator + tool registry — full stage-machine coverage with
 * injected router/deps (no LLM, no Electron), plus llmRouter.route() parsing
 * against a real in-process mock of llama-server's chat endpoint.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import http from 'http';
import { runCommand, resolveConfirmation, hasPendingConfirmation, CommandStage } from '../electron/commandMode';
import { COMMAND_TOOLS, getTool, toOpenAiTools, CommandDeps } from '../electron/commandTools';
import * as llmRouter from '../electron/llmRouter';

function makeDeps(overrides: Partial<CommandDeps> = {}): CommandDeps & { calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        typeText: async (t) => { calls.push(`type:${t}`); return { success: true, app: 'TestApp' }; },
        copyToClipboard: (t) => { calls.push(`copy:${t}`); },
        openExternal: async (u) => { calls.push(`url:${u}`); },
        openPath: async (p) => { calls.push(`path:${p}`); return ''; },
        launchApp: async (n) => { calls.push(`app:${n}`); },
        resolveKnownFolder: (n) => (/downloads/i.test(n) ? 'C:\\Users\\me\\Downloads' : null),
        getHistory: (limit) => [{ text: 'first transcript', timestamp: 1 }, { text: 'second transcript', timestamp: 2 }].slice(0, limit),
        ...overrides,
    };
}

function collectRuntime(routeTo: { tool: string; args: any } | Error, deps = makeDeps(), confirmTimeoutMs = 200) {
    const stages: CommandStage[] = [];
    return {
        stages,
        deps,
        rt: {
            route: async () => {
                if (routeTo instanceof Error) throw routeTo;
                return { ...routeTo, ms: 5 };
            },
            deps,
            emit: (s: CommandStage) => stages.push(s),
            confirmTimeoutMs,
        },
    };
}

beforeEach(() => {
    // Drain any stale confirmation between tests.
    resolveConfirmation(false);
});

describe('runCommand stage machine', () => {
    it('safe tool executes without confirmation', async () => {
        const { stages, rt, deps } = collectRuntime({ tool: 'type_text', args: { text: 'hello' } });
        const end = await runCommand('type hello', rt);
        expect(stages.map(s => s.stage)).toEqual(['routing', 'executing', 'done']);
        expect(end.stage).toBe('done');
        expect((end as any).message).toContain('TestApp');
        expect(deps.calls).toEqual(['type:hello']);
    });

    it('confirm tool waits for approval, then executes', async () => {
        const { stages, rt, deps } = collectRuntime({ tool: 'open_target', args: { target: 'downloads folder' } }, makeDeps(), 2000);
        const run = runCommand('open my downloads', rt);
        // Wait for the proposal to be emitted
        await new Promise(r => setTimeout(r, 20));
        expect(stages.at(-1)?.stage).toBe('proposal');
        expect(hasPendingConfirmation()).toBe(true);
        expect(resolveConfirmation(true)).toBe(true);
        const end = await run;
        expect(end.stage).toBe('done');
        expect(rt.deps === deps).toBe(true);
        expect(deps.calls[0]).toBe('path:C:\\Users\\me\\Downloads');
    });

    it('declined proposal cancels without executing', async () => {
        const { rt, deps } = collectRuntime({ tool: 'search_web', args: { query: 'cats' } }, makeDeps(), 2000);
        const run = runCommand('search for cats', rt);
        await new Promise(r => setTimeout(r, 20));
        resolveConfirmation(false);
        const end = await run;
        expect(end.stage).toBe('cancelled');
        expect(deps.calls).toEqual([]); // nothing executed
    });

    it('unanswered proposal times out to cancelled (never auto-executes)', async () => {
        const { rt, deps } = collectRuntime({ tool: 'open_target', args: { target: 'downloads' } }, makeDeps(), 50);
        const end = await runCommand('open downloads', rt);
        expect(end.stage).toBe('cancelled');
        expect(deps.calls).toEqual([]);
    });

    it('clarify short-circuits without execution', async () => {
        const { rt, deps } = collectRuntime({ tool: 'clarify', args: { question: 'Which file?' } });
        const end = await runCommand('move this file', rt);
        expect(end.stage).toBe('clarify');
        expect((end as any).question).toBe('Which file?');
        expect(deps.calls).toEqual([]);
    });

    it('router failure emits an error stage, never throws', async () => {
        const { rt } = collectRuntime(new Error('server down'));
        const end = await runCommand('do something', rt);
        expect(end.stage).toBe('error');
        expect((end as any).message).toBe('server down');
    });

    it('unknown tool from the router is an error', async () => {
        const { rt } = collectRuntime({ tool: 'rm_rf', args: {} });
        const end = await runCommand('nuke it', rt);
        expect(end.stage).toBe('error');
        expect((end as any).message).toContain('rm_rf');
    });

    it('empty transcript errors immediately', async () => {
        const { rt } = collectRuntime({ tool: 'type_text', args: { text: 'x' } });
        const end = await runCommand('   ', rt);
        expect(end.stage).toBe('error');
    });

    it('a tool exception becomes an error stage', async () => {
        const deps = makeDeps({ typeText: async () => { throw new Error('paste blew up'); } });
        const { rt } = collectRuntime({ tool: 'type_text', args: { text: 'x' } }, deps);
        const end = await runCommand('type x', rt);
        expect(end.stage).toBe('error');
        expect((end as any).message).toBe('paste blew up');
    });
});

describe('command tool registry', () => {
    it('every tool has a valid OpenAI schema and describe()', () => {
        const schemas = toOpenAiTools() as any[];
        expect(schemas).toHaveLength(COMMAND_TOOLS.length);
        for (const t of COMMAND_TOOLS) {
            expect(t.describe({ text: 'x', target: 'y', query: 'z', question: 'q', limit: 2 })).toBeTypeOf('string');
        }
    });
    it('outward/context-changing tools are confirm-gated; benign ones are not', () => {
        expect(getTool('open_target')!.confirm).toBe(true);
        expect(getTool('search_web')!.confirm).toBe(true);
        expect(getTool('type_text')!.confirm).toBe(false);
        expect(getTool('dictation')!.confirm).toBe(false);
        expect(getTool('clarify')!.confirm).toBe(false);
    });
    it('open_target routes URLs, known folders, paths, and app names correctly', async () => {
        const deps = makeDeps();
        const open = getTool('open_target')!;
        await open.execute({ target: 'https://example.com' }, deps);
        await open.execute({ target: 'downloads folder' }, deps);
        await open.execute({ target: 'C:\\temp\\x.txt' }, deps);
        await open.execute({ target: 'notepad' }, deps);
        expect(deps.calls).toEqual([
            'url:https://example.com',
            'path:C:\\Users\\me\\Downloads',
            'path:C:\\temp\\x.txt',
            'app:notepad',
        ]);
    });
    it('get_recent_transcripts clamps its limit and formats details', async () => {
        const deps = makeDeps();
        const out = await getTool('get_recent_transcripts')!.execute({ limit: 999 }, deps);
        expect(out.detail).toContain('first transcript');
    });
});

describe('llmRouter.route against a mock llama-server', () => {
    let server: http.Server;
    let port: number;

    afterAll(() => { server?.close(); llmRouter.__setForTest({ running: false, port: null }); });

    function startMock(handler: (body: any) => any): Promise<void> {
        return new Promise((resolve) => {
            server = http.createServer((req, res) => {
                let data = '';
                req.on('data', c => (data += c));
                req.on('end', () => {
                    const out = handler(JSON.parse(data));
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(out));
                });
            });
            server.listen(0, '127.0.0.1', () => {
                port = (server.address() as any).port;
                llmRouter.__setForTest({ running: true, port });
                resolve();
            });
        });
    }

    it('parses a tool call and passes cache_prompt + required tool_choice', async () => {
        let seen: any = null;
        await startMock((body) => {
            seen = body;
            return { choices: [{ message: { tool_calls: [{ function: { name: 'open_target', arguments: '{"target":"downloads"}' } }] } }] };
        });
        const r = await llmRouter.route('open downloads', toOpenAiTools());
        expect(r.tool).toBe('open_target');
        expect(r.args).toEqual({ target: 'downloads' });
        expect(seen.cache_prompt).toBe(true);
        expect(seen.tool_choice).toBe('required');
        expect(seen.messages[1].content).toBe('open downloads');
    });

    it('throws a useful error when no tool call comes back', async () => {
        server.close();
        await startMock(() => ({ choices: [{ message: { content: 'I cannot do that' } }] }));
        await expect(llmRouter.route('x', [])).rejects.toThrow(/no tool call/);
    });
});
