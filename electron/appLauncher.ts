/**
 * appLauncher — resolve a spoken app name to something the OS can actually
 * launch. `start "" "spotify"` does NOT work: Spotify lives in
 * %APPDATA%\Spotify and isn't on PATH, so that pops the "Windows cannot find
 * 'Spotify'" dialog the agent then flails against. Launchers solve this by
 * resolving the Start Menu shortcut, which every real app creates — that's the
 * primary strategy here, with the App Paths registry and PATH as fallbacks.
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { join, basename, extname } from 'path';
import { homedir } from 'os';
import { execFile } from 'child_process';

/** Normalize for fuzzy matching: lowercase, strip non-alphanumerics. */
function norm(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Spoken names → a launch token that actually works. Covers Windows built-ins
 * that ship no Start Menu .lnk and aren't found under their spoken name
 * (mostly UWP/system apps invoked by their classic exe stub).
 */
const ALIASES: Record<string, string> = {
    calculator: 'calc',
    calc: 'calc',
    paint: 'mspaint',
    'paint 3d': 'mspaint',
    notepad: 'notepad',
    wordpad: 'wordpad',
    cmd: 'cmd',
    'command prompt': 'cmd',
    terminal: 'wt',
    powershell: 'powershell',
    explorer: 'explorer',
    'file explorer': 'explorer',
    'task manager': 'taskmgr',
    'control panel': 'control',
    registry: 'regedit',
    'registry editor': 'regedit',
};

function startMenuDirs(): string[] {
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    const programData = process.env.ProgramData || 'C:\\ProgramData';
    return [
        join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
        join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    ];
}

/** Recursively collect .lnk shortcuts (bounded depth — Start Menu is shallow). */
function collectShortcuts(dir: string, depth: number, out: string[]): void {
    if (depth < 0) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
        const full = join(dir, name);
        let isDir = false;
        try { isDir = statSync(full).isDirectory(); } catch { continue; }
        if (isDir) collectShortcuts(full, depth - 1, out);
        else if (extname(name).toLowerCase() === '.lnk') out.push(full);
    }
}

/**
 * Best Start Menu shortcut for `query`: exact normalized filename match wins,
 * else a shortcut whose name starts with / contains the query. Prefers the
 * shortest name among contains-matches (avoids "Spotify Web Helper" over
 * "Spotify"). Returns the .lnk path or null.
 */
export function findStartMenuShortcut(query: string): string | null {
    const q = norm(query);
    if (!q) return null;
    const shortcuts: string[] = [];
    for (const dir of startMenuDirs()) collectShortcuts(dir, 4, shortcuts);

    let exact: string | null = null;
    let prefix: string | null = null;
    let contains: string | null = null;
    for (const lnk of shortcuts) {
        const n = norm(basename(lnk, '.lnk'));
        if (n === q) { exact = lnk; break; }
        if (n.startsWith(q) && (!prefix || basename(lnk).length < basename(prefix).length)) prefix = lnk;
        else if (n.includes(q) && (!contains || basename(lnk).length < basename(contains).length)) contains = lnk;
    }
    return exact || prefix || contains;
}

/** App Paths registry lookup (HKCU then HKLM) → resolved exe path or null. */
function queryAppPaths(query: string): Promise<string | null> {
    const key = `SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${query}.exe`;
    const hives = ['HKCU', 'HKLM'];
    return new Promise((resolve) => {
        let i = 0;
        const tryNext = () => {
            if (i >= hives.length) return resolve(null);
            const hive = hives[i++];
            execFile('reg', ['query', `${hive}\\${key}`, '/ve'], { windowsHide: true }, (err, stdout) => {
                if (!err && stdout) {
                    const m = stdout.match(/REG_SZ\s+(.+?)\s*$/m);
                    const p = m?.[1]?.trim().replace(/^"|"$/g, '');
                    if (p && existsSync(p)) return resolve(p);
                }
                tryNext();
            });
        };
        tryNext();
    });
}

export interface LaunchTarget {
    /** Path to open (a .lnk, .exe, or the raw name for the shell fallback). */
    target: string;
    /** How it was resolved — for logging/telemetry. */
    via: 'startmenu' | 'apppaths' | 'path' | 'shell';
}

/**
 * Resolve a spoken app name to a launch target. Never throws; falls back to
 * the raw name (shell will try, and if it fails the agent sees no new window
 * and gives up honestly rather than fighting an error dialog).
 */
export async function resolveApp(name: string): Promise<LaunchTarget> {
    // Strip spoken filler the router may keep ("the calculator", "open paint").
    const clean = name.trim().replace(/^(open|launch|start|the|a|my)\s+/i, '').trim() || name.trim();
    // Already a concrete path / executable.
    if (/^[a-z]:\\/i.test(clean) && existsSync(clean)) return { target: clean, via: 'path' };

    // Known built-in aliases (calculator→calc, etc.) go straight to the shell
    // token, which resolves on PATH — Start Menu often has no .lnk for these.
    const alias = ALIASES[clean.toLowerCase()];
    if (alias) return { target: alias, via: 'shell' };

    const lnk = findStartMenuShortcut(clean);
    if (lnk) return { target: lnk, via: 'startmenu' };

    // App Paths: try the raw spoken token and its normalized form.
    const appPath = (await queryAppPaths(clean.replace(/\s+/g, ''))) || (await queryAppPaths(norm(clean)));
    if (appPath) return { target: appPath, via: 'apppaths' };

    return { target: clean, via: 'shell' };
}
