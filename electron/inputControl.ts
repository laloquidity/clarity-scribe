/**
 * inputControl.ts — native mouse + keyboard primitives for agent mode (Win32).
 *
 * Extends the winPaste SendInput approach to the full input surface an agent
 * needs: absolute-position clicks, Unicode typing, key combos, wheel scroll.
 * All coordinates come in as pixels of a reference frame (the screenshot the
 * agent looked at) and are rescaled against GetSystemMetrics so clicks land
 * even if capture and metric resolutions disagree.
 *
 * Windows-only for now; every entry point no-ops with `false` elsewhere so the
 * agent loop can degrade honestly (macOS driver is a future parallel module).
 */

let user32: any = null;
let SendInput: any = null;
let GetSystemMetrics: any = null;
let SetForegroundWindowByHwnd: any = null;
let initialized = false;

const INPUT_SIZE = 40;

// INPUT.type
const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;

// MOUSEINPUT flags
const MOUSEEVENTF_MOVE = 0x0001;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const MOUSEEVENTF_WHEEL = 0x0800;
const MOUSEEVENTF_VIRTUALDESK = 0x4000;
const MOUSEEVENTF_ABSOLUTE = 0x8000;

// KEYBDINPUT flags
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_UNICODE = 0x0004;

const SM_CXSCREEN = 0;
const SM_CYSCREEN = 1;
const SM_XVIRTUALSCREEN = 76;
const SM_YVIRTUALSCREEN = 77;
const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;

/** Spoken/step key names → virtual-key codes. */
const VK: Record<string, number> = {
    ctrl: 0x11, control: 0x11, alt: 0x12, shift: 0x10, win: 0x5b, meta: 0x5b, cmd: 0x5b,
    enter: 0x0d, return: 0x0d, esc: 0x1b, escape: 0x1b, tab: 0x09, space: 0x20,
    backspace: 0x08, delete: 0x2e, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
    up: 0x26, down: 0x28, left: 0x25, right: 0x27,
};
for (let i = 0; i < 26; i++) VK[String.fromCharCode(97 + i)] = 0x41 + i;   // a-z
for (let i = 0; i <= 9; i++) VK[String(i)] = 0x30 + i;                      // 0-9
for (let i = 1; i <= 12; i++) VK[`f${i}`] = 0x70 + (i - 1);                 // f1-f12

export function initInputControl(): boolean {
    if (initialized) return true;
    if (process.platform !== 'win32') return false;
    try {
        const koffi = require('koffi');
        user32 = koffi.load('user32.dll');
        SendInput = user32.func('uint32 __stdcall SendInput(uint32 nInputs, void *pInputs, int cbSize)');
        GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int nIndex)');
        // intptr signature lets us pass hwnd as a plain number (uiaProbe dumps).
        SetForegroundWindowByHwnd = user32.func('bool __stdcall SetForegroundWindow(intptr_t hWnd)');
        initialized = true;
        console.log('[Input] Initialized native input control (user32.dll)');
        return true;
    } catch (e) {
        console.error('[Input] Failed to initialize koffi FFI:', e);
        return false;
    }
}

export function isInputControlAvailable(): boolean {
    return initialized || initInputControl();
}

function delay(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

// --- struct writers (x64 layouts, see winPaste.ts for the KEYBD derivation) ---

function writeMouse(buf: Buffer, offset: number, dx: number, dy: number, mouseData: number, flags: number): void {
    buf.fill(0, offset, offset + INPUT_SIZE);
    buf.writeUInt32LE(INPUT_MOUSE, offset);
    buf.writeInt32LE(dx, offset + 8);
    buf.writeInt32LE(dy, offset + 12);
    buf.writeInt32LE(mouseData, offset + 16);
    buf.writeUInt32LE(flags, offset + 20);
}

function writeKey(buf: Buffer, offset: number, vk: number, scan: number, flags: number): void {
    buf.fill(0, offset, offset + INPUT_SIZE);
    buf.writeUInt32LE(INPUT_KEYBOARD, offset);
    buf.writeUInt16LE(vk, offset + 8);
    buf.writeUInt16LE(scan, offset + 10);
    buf.writeUInt32LE(flags, offset + 12);
}

function send(buf: Buffer, count: number): boolean {
    const sent = SendInput(count, buf, INPUT_SIZE);
    if (sent !== count) console.error(`[Input] SendInput sent ${sent}/${count} events`);
    return sent === count;
}

/** Map a point in reference-frame pixels to normalized 0..65535 absolute coords. */
function toAbsolute(x: number, y: number, refW: number, refH: number): { ax: number; ay: number } {
    const screenW = GetSystemMetrics(SM_CXSCREEN);
    const screenH = GetSystemMetrics(SM_CYSCREEN);
    const px = (x / refW) * screenW;
    const py = (y / refH) * screenH;
    return {
        ax: Math.max(0, Math.min(65535, Math.round((px * 65535) / (screenW - 1)))),
        ay: Math.max(0, Math.min(65535, Math.round((py * 65535) / (screenH - 1)))),
    };
}

/** Map PHYSICAL screen pixels (UIA rects) to 0..65535 virtual-desktop coords. */
function screenToAbsolute(x: number, y: number): { ax: number; ay: number } {
    const vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
    const vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
    const vw = GetSystemMetrics(SM_CXVIRTUALSCREEN) || GetSystemMetrics(SM_CXSCREEN);
    const vh = GetSystemMetrics(SM_CYVIRTUALSCREEN) || GetSystemMetrics(SM_CYSCREEN);
    return {
        ax: Math.max(0, Math.min(65535, Math.round(((x - vx) * 65535) / (vw - 1)))),
        ay: Math.max(0, Math.min(65535, Math.round(((y - vy) * 65535) / (vh - 1)))),
    };
}

/**
 * Move to physical screen pixel (x, y) — the coordinate space of UIA
 * BoundingRectangles — and left-click. Multi-monitor safe (virtual desktop).
 */
export async function clickAtScreen(x: number, y: number): Promise<boolean> {
    if (!isInputControlAvailable()) return false;
    const { ax, ay } = screenToAbsolute(x, y);
    const abs = MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
    const move = Buffer.alloc(INPUT_SIZE);
    writeMouse(move, 0, ax, ay, 0, MOUSEEVENTF_MOVE | abs);
    if (!send(move, 1)) return false;
    await delay(40);
    const buf = Buffer.alloc(INPUT_SIZE * 2);
    writeMouse(buf, 0, ax, ay, 0, MOUSEEVENTF_LEFTDOWN | abs);
    writeMouse(buf, INPUT_SIZE, ax, ay, 0, MOUSEEVENTF_LEFTUP | abs);
    return send(buf, 2);
}

/** Bring a window (hwnd from uiaProbe) to the foreground. */
export async function focusWindow(hwnd: number): Promise<boolean> {
    if (!isInputControlAvailable()) return false;
    try { return !!SetForegroundWindowByHwnd(hwnd); } catch { return false; }
}

/**
 * Move to (x, y) — pixels within a refW×refH frame (the screenshot) — and
 * left-click. `double` sends two click pairs (Windows uses timing, so both
 * pairs inside one SendInput batch register as a double-click).
 */
export async function clickAt(
    x: number, y: number, refW: number, refH: number,
    opts: { button?: 'left' | 'right'; double?: boolean } = {},
): Promise<boolean> {
    if (!isInputControlAvailable()) return false;
    const { ax, ay } = toAbsolute(x, y, refW, refH);

    // Move first, settle briefly so hover states/menus react, then click.
    const move = Buffer.alloc(INPUT_SIZE);
    writeMouse(move, 0, ax, ay, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE);
    if (!send(move, 1)) return false;
    await delay(40);

    const [down, up] = opts.button === 'right'
        ? [MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP]
        : [MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP];
    const pairs = opts.double ? 2 : 1;
    const buf = Buffer.alloc(INPUT_SIZE * 2 * pairs);
    for (let i = 0; i < pairs; i++) {
        writeMouse(buf, INPUT_SIZE * (i * 2), ax, ay, 0, down | MOUSEEVENTF_ABSOLUTE);
        writeMouse(buf, INPUT_SIZE * (i * 2 + 1), ax, ay, 0, up | MOUSEEVENTF_ABSOLUTE);
    }
    return send(buf, 2 * pairs);
}

/**
 * Type text into the focused control via KEYEVENTF_UNICODE (layout-independent,
 * emoji-safe — surrogate pairs go through as consecutive code units). Newlines
 * and tabs are sent as real Enter/Tab keystrokes.
 */
export async function typeText(text: string): Promise<boolean> {
    if (!isInputControlAvailable()) return false;
    const CHUNK = 120; // code units per SendInput batch — keeps buffers small
    for (let start = 0; start < text.length; start += CHUNK) {
        const slice = text.slice(start, start + CHUNK);
        const buf = Buffer.alloc(INPUT_SIZE * slice.length * 2);
        let n = 0;
        for (const unit of slice) {
            for (const codeUnit of [...Array(unit.length).keys()].map(i => unit.charCodeAt(i))) {
                if (codeUnit === 10 || codeUnit === 13) {
                    writeKey(buf, INPUT_SIZE * n++, VK.enter, 0, 0);
                    writeKey(buf, INPUT_SIZE * n++, VK.enter, 0, KEYEVENTF_KEYUP);
                } else if (codeUnit === 9) {
                    writeKey(buf, INPUT_SIZE * n++, VK.tab, 0, 0);
                    writeKey(buf, INPUT_SIZE * n++, VK.tab, 0, KEYEVENTF_KEYUP);
                } else {
                    writeKey(buf, INPUT_SIZE * n++, 0, codeUnit, KEYEVENTF_UNICODE);
                    writeKey(buf, INPUT_SIZE * n++, 0, codeUnit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
                }
            }
        }
        if (!send(buf, n)) return false;
        if (start + CHUNK < text.length) await delay(15); // let slow apps drain the queue
    }
    return true;
}

/**
 * Press a key combo, e.g. ['ctrl','k'] or ['enter']. Unknown names fail
 * loudly (return false) instead of silently pressing nothing.
 */
export async function pressKeys(keys: string[]): Promise<boolean> {
    if (!isInputControlAvailable()) return false;
    const vks = keys.map(k => VK[k.trim().toLowerCase()]);
    if (vks.length === 0 || vks.some(v => v === undefined)) {
        console.error(`[Input] Unknown key in combo: ${JSON.stringify(keys)}`);
        return false;
    }
    const buf = Buffer.alloc(INPUT_SIZE * vks.length * 2);
    let n = 0;
    for (const vk of vks) writeKey(buf, INPUT_SIZE * n++, vk, 0, 0);                       // downs in order
    for (const vk of [...vks].reverse()) writeKey(buf, INPUT_SIZE * n++, vk, 0, KEYEVENTF_KEYUP); // ups reversed
    return send(buf, n);
}

/** Scroll the wheel at the current cursor position. Positive = up. */
export async function scrollWheel(clicks: number): Promise<boolean> {
    if (!isInputControlAvailable()) return false;
    const buf = Buffer.alloc(INPUT_SIZE);
    writeMouse(buf, 0, 0, 0, Math.round(clicks * 120), MOUSEEVENTF_WHEEL);
    return send(buf, 1);
}
