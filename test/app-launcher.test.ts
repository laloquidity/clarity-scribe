/**
 * App resolver — the fix for "Windows cannot find 'Spotify'". Verifies the
 * Start Menu shortcut matching (exact / prefix / shortest-contains) against a
 * temp fixture pointed at via APPDATA.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let dir: string;
let origAppData: string | undefined;
let findStartMenuShortcut: (q: string) => string | null;
let resolveApp: (name: string) => Promise<{ target: string; via: string }>;

beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'scribe-sm-'));
    const programs = join(dir, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    mkdirSync(programs, { recursive: true });
    for (const name of ['Spotify.lnk', 'Spotify Web Helper.lnk', 'Visual Studio Code.lnk', 'Discord.lnk']) {
        writeFileSync(join(programs, name), '');
    }
    origAppData = process.env.APPDATA;
    process.env.APPDATA = dir;
    process.env.ProgramData = dir; // point both hives at the fixture
    ({ findStartMenuShortcut, resolveApp } = await import('../electron/appLauncher'));
});

afterAll(() => {
    if (origAppData !== undefined) process.env.APPDATA = origAppData;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('findStartMenuShortcut', () => {
    it('resolves an exact app name to its shortcut', () => {
        expect(findStartMenuShortcut('spotify')).toMatch(/Spotify\.lnk$/);
    });
    it('prefers the exact/shortest match over a longer contains-match', () => {
        // "Spotify" must beat "Spotify Web Helper"
        expect(findStartMenuShortcut('spotify')).toMatch(/[\\/]Spotify\.lnk$/);
    });
    it('is case- and punctuation-insensitive', () => {
        expect(findStartMenuShortcut('Visual Studio Code')).toMatch(/Visual Studio Code\.lnk$/);
        expect(findStartMenuShortcut('DISCORD')).toMatch(/Discord\.lnk$/);
    });
    it('matches on a partial name the way people speak', () => {
        // "visual studio" is a prefix of "visual studio code"
        expect(findStartMenuShortcut('visual studio')).toMatch(/Visual Studio Code\.lnk$/);
    });
    it('returns null when nothing matches', () => {
        expect(findStartMenuShortcut('nonexistent-app-xyz')).toBeNull();
        expect(findStartMenuShortcut('')).toBeNull();
    });
});

describe('resolveApp', () => {
    it('maps built-in aliases (incl. spoken filler) to a working shell token', async () => {
        expect(await resolveApp('calculator')).toEqual({ target: 'calc', via: 'shell' });
        expect(await resolveApp('the calculator')).toEqual({ target: 'calc', via: 'shell' });
        expect(await resolveApp('open task manager')).toEqual({ target: 'taskmgr', via: 'shell' });
    });
    it('prefers a Start Menu shortcut over the shell fallback', async () => {
        const r = await resolveApp('spotify');
        expect(r.via).toBe('startmenu');
        expect(r.target).toMatch(/Spotify\.lnk$/);
    });
});
