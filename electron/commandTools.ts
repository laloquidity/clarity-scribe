/**
 * Command tools — the actions a spoken command can trigger.
 *
 * Each tool declares an OpenAI-format schema (what the router model sees),
 * describe() (the human-readable line shown in the capsule), execute()
 * (written against injected OS primitives so the registry is unit-testable
 * without Electron), and assessRisk() — the RULEBOOK entry below applied to
 * the tool's actual arguments.
 *
 * ── THE RISK RULEBOOK ──────────────────────────────────────────────────────
 * Default is DO IT. A spoken command is itself an explicit instruction, so
 * ceremony is only added when the ACTION's consequences warrant it:
 *
 *   AUTO (execute immediately) — reversible, local, benign:
 *     typing/copying text, reading history, opening folders/apps/files/URLs,
 *     web searches. Undo = close the window / delete the text.
 *
 *   CONFIRM (proposal card, ↵/Esc, auto-cancel) — hard to reverse, executes
 *     code, leaves the machine, or touches money/credentials/system state:
 *     · launching executable/script FILES (.exe .bat .cmd .ps1 .msi .vbs
 *       .scr .reg .lnk .jar — opening one runs it, and downloaded binaries
 *       are the classic footgun)
 *     · future tools: sending messages/email, deleting/moving files,
 *       modifying settings, anything with an external recipient
 *
 *   REFUSE (explain, never execute) — severe & irreversible:
 *     · future tools: purchases/transfers, credential entry, bulk deletion,
 *       disabling security features
 *
 * Risk is assessed on the ARGUMENTS, not just the tool name — "open my
 * downloads folder" is AUTO while "open crack.exe" is CONFIRM through the
 * same tool. New tools must declare assessRisk() and land in a tier
 * deliberately; the confirmation/refusal UX already exists for them.
 */

export type RiskLevel = 'auto' | 'confirm' | 'refuse';

export interface RiskDecision {
    level: RiskLevel;
    /** Shown to the user for confirm/refuse — WHY the guardrail applies. */
    reason?: string;
}

/** File extensions that EXECUTE when "opened" — the rulebook's confirm trigger. */
const EXECUTABLE_EXT_RE = /\.(exe|bat|cmd|ps1|msi|vbs|scr|reg|lnk|jar|com|app|sh|command)\s*$/i;

/** Rulebook helper: risk of opening a given target string. */
export function riskOfOpening(target: string): RiskDecision {
    const t = target.trim();
    // Web URLs open in the browser — never executed locally. Checked first so
    // the DOS-era ".com" extension doesn't collide with the .com TLD.
    if (/^https?:\/\//i.test(t)) return { level: 'auto' };
    if (EXECUTABLE_EXT_RE.test(t)) {
        return { level: 'confirm', reason: 'This would run an executable file' };
    }
    return { level: 'auto' };
}

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
    /** Apply the rulebook to the actual arguments (see header). */
    assessRisk: (args: Record<string, any>) => RiskDecision;
    describe: (args: Record<string, any>) => string;
    execute: (args: Record<string, any>, deps: CommandDeps) => Promise<ToolOutcome>;
}

const AUTO: RiskDecision = { level: 'auto' };

function str(v: unknown): string {
    return typeof v === 'string' ? v : '';
}

export const COMMAND_TOOLS: CommandTool[] = [
    {
        name: 'dictation',
        description: 'The input is NOT a command — it is ordinary prose the user wants typed into their current app, verbatim.',
        parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        assessRisk: () => AUTO, // typing text the user just spoke is reversible
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
        assessRisk: () => AUTO,
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
        assessRisk: () => AUTO,
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
        assessRisk: () => AUTO, // read-only
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
        // Rulebook: opening folders/apps/URLs is AUTO; executable files CONFIRM.
        assessRisk: (a) => riskOfOpening(str(a.target)),
        describe: (a) => `Open ${str(a.target)}`,
        execute: async (a, deps) => {
            const target = str(a.target).trim();
            if (!target) return { message: 'No target given' };
            if (/^https?:\/\//i.test(target)) {
                await deps.openExternal(target);
                return { message: `Opened ${target} ✓` };
            }
            // Concrete paths FIRST: "C:\Downloads\setup.exe" must never be
            // folder-name-matched into opening the Downloads folder instead.
            if (/^[a-z]:\\|^\//i.test(target)) {
                const err = await deps.openPath(target);
                return { message: err ? `Could not open: ${err}` : `Opened ${target} ✓` };
            }
            const folder = deps.resolveKnownFolder(target);
            if (folder) {
                const err = await deps.openPath(folder);
                return { message: err ? `Could not open: ${err}` : `Opened ${folder} ✓` };
            }
            await deps.launchApp(target);
            return { message: `Launching ${target}…` };
        },
    },
    {
        name: 'search_web',
        description: 'Search the web for something (user says "search for ..." / "google ...").',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        assessRisk: () => AUTO, // a search tab is trivially reversible
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
        assessRisk: () => AUTO, // conversational only
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
