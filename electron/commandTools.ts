/**
 * Command tools — the actions a spoken command can trigger.
 *
 * Each tool declares:
 *   - an OpenAI-format schema (what the router model sees),
 *   - a safety tier: `confirm: true` actions are gated behind an explicit
 *     user confirmation in the capsule before executing (the trust layer —
 *     anything that changes app focus or reaches outward confirms first),
 *   - describe(): the human-readable proposal shown in the confirmation card,
 *   - execute(): the action, written against injected OS primitives (`Deps`)
 *     so the registry is fully unit-testable without Electron.
 *
 * v1 keeps the action surface deliberately mild — no file deletion, no key
 * injection, no messaging. The confirmation framework is built now so more
 * consequential tools can be added without new UX.
 */

export interface CommandDeps {
    /** Type/paste text into the app the user was in (existing paste flow). */
    typeText: (text: string) => Promise<{ success: boolean; app?: string }>;
    copyToClipboard: (text: string) => void;
    /** Open a URL in the default browser. */
    openExternal: (url: string) => Promise<void>;
    /** Open a filesystem path (folder/file) with the OS handler. Returns '' on success, error string otherwise. */
    openPath: (path: string) => Promise<string>;
    /** Launch an application by name via the OS shell (start/open). */
    launchApp: (name: string) => Promise<void>;
    /** Resolve well-known folder names ("downloads" → C:\Users\...\Downloads). */
    resolveKnownFolder: (name: string) => string | null;
    getHistory: (limit: number) => Array<{ text: string; timestamp: number }>;
}

export interface ToolOutcome {
    /** One-line result for the capsule ("Opened Downloads ✓"). */
    message: string;
    /** Optional longer payload shown in the capsule (e.g. transcript list). */
    detail?: string;
}

export interface CommandTool {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
    confirm: boolean;
    describe: (args: Record<string, any>) => string;
    execute: (args: Record<string, any>, deps: CommandDeps) => Promise<ToolOutcome>;
}

function str(v: unknown): string {
    return typeof v === 'string' ? v : '';
}

export const COMMAND_TOOLS: CommandTool[] = [
    {
        name: 'dictation',
        description: 'The input is NOT a command — it is ordinary prose the user wants typed into their current app, verbatim.',
        parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        confirm: false,
        describe: (a) => `Type: "${str(a.text).substring(0, 60)}"`,
        execute: async (a, deps) => {
            const text = str(a.text).trim();
            if (!text) return { message: 'Nothing to type' };
            const r = await deps.typeText(text.endsWith(' ') ? text : text + ' ');
            return { message: r.success ? `Typed into ${r.app ?? 'app'} ✓` : 'Copied to clipboard' };
        },
    },
    {
        name: 'type_text',
        description: 'Type the given literal text into the app the user is currently using. Use when the user says things like "type ..." or "write ...".',
        parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        confirm: false,
        describe: (a) => `Type: "${str(a.text).substring(0, 60)}"`,
        execute: async (a, deps) => {
            const text = str(a.text).trim();
            if (!text) return { message: 'Nothing to type' };
            const r = await deps.typeText(text);
            return { message: r.success ? `Typed into ${r.app ?? 'app'} ✓` : 'Copied to clipboard' };
        },
    },
    {
        name: 'copy_to_clipboard',
        description: 'Put the given text on the clipboard (user says "copy ..." / "put ... on my clipboard").',
        parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        confirm: false,
        describe: (a) => `Copy to clipboard: "${str(a.text).substring(0, 50)}"`,
        execute: async (a, deps) => {
            const text = str(a.text);
            if (!text) return { message: 'Nothing to copy' };
            deps.copyToClipboard(text);
            return { message: 'Copied to clipboard ✓' };
        },
    },
    {
        name: 'get_recent_transcripts',
        description: "Show the user's most recent dictation transcripts.",
        parameters: { type: 'object', properties: { limit: { type: 'number', description: 'How many (default 3)' } } },
        confirm: false,
        describe: (a) => `Show last ${a.limit ?? 3} transcripts`,
        execute: async (a, deps) => {
            const limit = Math.max(1, Math.min(10, Number(a.limit) || 3));
            const entries = deps.getHistory(limit);
            if (entries.length === 0) return { message: 'No transcripts yet' };
            const detail = entries
                .map(e => `• ${e.text.substring(0, 90)}${e.text.length > 90 ? '…' : ''}`)
                .join('\n');
            return { message: `Last ${entries.length} transcript${entries.length > 1 ? 's' : ''}:`, detail };
        },
    },
    {
        name: 'open_target',
        description: 'Open an application, a well-known folder (downloads, documents, desktop, pictures), a file path, or a URL on this computer.',
        parameters: { type: 'object', properties: { target: { type: 'string', description: 'e.g. "downloads folder", "notepad", "https://example.com"' } }, required: ['target'] },
        confirm: true,
        describe: (a) => `Open ${str(a.target)}`,
        execute: async (a, deps) => {
            const target = str(a.target).trim();
            if (!target) return { message: 'No target given' };
            if (/^https?:\/\//i.test(target)) {
                await deps.openExternal(target);
                return { message: `Opened ${target} ✓` };
            }
            const folder = deps.resolveKnownFolder(target);
            if (folder) {
                const err = await deps.openPath(folder);
                return { message: err ? `Could not open: ${err}` : `Opened ${folder} ✓` };
            }
            // Looks like a concrete path?
            if (/^[a-z]:\\|^\//i.test(target)) {
                const err = await deps.openPath(target);
                return { message: err ? `Could not open: ${err}` : `Opened ${target} ✓` };
            }
            await deps.launchApp(target);
            return { message: `Launching ${target}…` };
        },
    },
    {
        name: 'search_web',
        description: 'Search the web for something (user says "search for ..." / "google ...").',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        confirm: true,
        describe: (a) => `Search the web for "${str(a.query).substring(0, 50)}"`,
        execute: async (a, deps) => {
            const q = str(a.query).trim();
            if (!q) return { message: 'Empty search' };
            await deps.openExternal(`https://www.google.com/search?q=${encodeURIComponent(q)}`);
            return { message: `Searching for "${q.substring(0, 40)}" ✓` };
        },
    },
    {
        name: 'clarify',
        description: 'Use when the request does not match any tool, is not possible with the available tools, or is missing required details. Tell the user what you need or cannot do.',
        parameters: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
        confirm: false,
        describe: (a) => str(a.question),
        execute: async (a) => ({ message: str(a.question) || 'Could you rephrase that?' }),
    },
];

export function getTool(name: string): CommandTool | undefined {
    return COMMAND_TOOLS.find(t => t.name === name);
}

/** OpenAI-format tool array for the router model. */
export function toOpenAiTools(): unknown[] {
    return COMMAND_TOOLS.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
}
