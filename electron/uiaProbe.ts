/**
 * uiaProbe — resident UI Automation reader (native/uia-probe/uia-probe.exe).
 *
 * The screen agent's PRIMARY perception: the OS accessibility tree gives every
 * standard control's real name and exact screen rectangle in ~100ms, no GPU.
 * (Vision/OmniParser is the fallback for surfaces with no UIA data — games,
 * canvas apps.) Architecture follows Microsoft UFO²'s inspector: one bulk
 * FindAll with a CacheRequest inside the probe; here we just speak its
 * line-delimited JSON stdio protocol.
 *
 * The probe runs OUT of process so a UIA call wedged on a frozen app can be
 * killed and restarted without touching Electron: any request timeout kills
 * the child; the next request respawns it (watchdog-by-construction).
 */

import { spawn, ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

export interface UiaElement {
    id: number;
    name: string;
    type: string;
    /** [left, top, right, bottom] physical screen pixels. */
    rect: [number, number, number, number];
    invoke: boolean;
    select: boolean;
    value: boolean;
    focusable: boolean;
}

export interface UiaWindow {
    title: string;
    hwnd: number;
    pid: number;
    rect: [number, number, number, number];
}

export interface UiaDump {
    ok: boolean;
    error?: string;
    window?: UiaWindow;
    elements?: UiaElement[];
}

const REQUEST_TIMEOUT_MS = 4000; // probe's own dump timeout is 2s

let proc: ChildProcess | null = null;
let buffer = '';
let pending: Array<{ resolve: (line: string) => void; timer: NodeJS.Timeout }> = [];

function probePath(): string | null {
    const candidates = [
        process.env.SCRIBE_UIA_PROBE,
        join(__dirname, '..', 'native', 'uia-probe', 'uia-probe.exe'),          // dev
        join(process.resourcesPath ?? '', 'uia-probe.exe'),                     // packaged
    ].filter(Boolean) as string[];
    return candidates.find(existsSync) || null;
}

export function isAvailable(): boolean {
    return process.platform === 'win32' && probePath() !== null;
}

function killProc(): void {
    if (proc) {
        try { proc.kill(); } catch { /* ignore */ }
        proc = null;
    }
    // Fail anything still in flight so callers never hang.
    for (const p of pending) {
        clearTimeout(p.timer);
        p.resolve(JSON.stringify({ ok: false, error: 'probe restarted' }));
    }
    pending = [];
    buffer = '';
}

function ensureProc(): boolean {
    if (proc) return true;
    const path = probePath();
    if (!path) return false;
    const child = spawn(path, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    child.stdout!.setEncoding('utf-8');
    child.stdout!.on('data', (d: string) => {
        buffer += d;
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            const waiter = pending.shift();
            if (waiter) {
                clearTimeout(waiter.timer);
                waiter.resolve(line);
            }
        }
    });
    child.on('exit', () => {
        if (proc === child) killProc();
    });
    proc = child;
    console.log('[UIA] Probe started');
    return true;
}

/** One request → one JSON line back. Timeout kills + respawns the probe. */
function request(cmd: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<any> {
    if (!ensureProc()) {
        return Promise.resolve({ ok: false, error: 'uia-probe not available' });
    }
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            console.warn('[UIA] Request timed out — recycling probe');
            killProc(); // resolves this waiter via the pending sweep
        }, timeoutMs);
        pending.push({
            resolve: (line) => {
                try { resolve(JSON.parse(line)); } catch { resolve({ ok: false, error: 'bad probe response' }); }
            },
            timer,
        });
        proc!.stdin!.write(JSON.stringify(cmd) + '\n');
    });
}

/** Interactive controls of the foreground window (or a pinned hwnd). */
export function dump(hwnd?: number | null): Promise<UiaDump> {
    return request(hwnd && hwnd > 0 ? { cmd: 'dump', hwnd } : { cmd: 'dump' });
}

export interface TopWindow {
    hwnd: number;
    pid: number;
    title: string;
    /** Executable name — an app's title is often not its name (chat apps). */
    proc: string;
}

/** Visible top-level app windows — the fallback when there's no foreground. */
export async function listWindows(): Promise<TopWindow[]> {
    const r = await request({ cmd: 'windows' });
    return (r?.windows ?? []) as TopWindow[];
}

/** Programmatic activation: Invoke → Toggle → Select (no cursor movement). */
export function invoke(id: number): Promise<{ ok: boolean; via?: string; error?: string }> {
    return request({ cmd: 'invoke', id });
}

/** Focus an element and set its text atomically (ValuePattern). */
export function setValue(id: number, text: string): Promise<{ ok: boolean; error?: string }> {
    return request({ cmd: 'setvalue', id, text });
}

/** Keyboard-focus an element (before physical typing). */
export function focus(id: number): Promise<{ ok: boolean; error?: string }> {
    return request({ cmd: 'focus', id });
}

export function stop(): void {
    killProc();
}
