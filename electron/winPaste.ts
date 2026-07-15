/**
 * winPaste.ts — Native Win32 window focus and keyboard paste via FFI
 *
 * Replaces PowerShell process spawning with direct user32.dll calls.
 * PowerShell approach: ~1,000ms (two process spawns + .NET runtime)
 * Native FFI approach: ~4ms (direct DLL calls in-process)
 */

let user32: any = null;
let koffiLib: any = null;

// Win32 function bindings (loaded lazily)
let SetForegroundWindow: any = null;
let GetForegroundWindow: any = null;
let SendInput: any = null;
let AllowSetForegroundWindow: any = null;
let GetWindowThreadProcessId: any = null;

// Constants
const INPUT_KEYBOARD = 1;
const KEYEVENTF_KEYUP = 0x0002;
const VK_CONTROL = 0x11;
const VK_V = 0x56;

// sizeof(INPUT) on x64 Windows = 40 bytes
// Layout: DWORD type(4) + pad(4) + union(32) = 40
const INPUT_SIZE = 40;
// KEYBDINPUT starts at offset 8 (after type + padding)
const KI_OFFSET = 8;

let isInitialized = false;

// Stored HWND from when the hotkey was pressed (the target window)
let capturedHwnd: any = null;

/**
 * Initialize the Win32 FFI bindings. Call once at app startup.
 * Returns false if not on Windows or if koffi fails to load.
 */
export function initWinPaste(): boolean {
    if (isInitialized) return true;
    if (process.platform !== 'win32') return false;

    try {
        const koffi = require('koffi');
        koffiLib = koffi;
        user32 = koffi.load('user32.dll');

        // Bind Win32 functions — simple signatures, no callbacks needed
        SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(void *hWnd)');
        GetForegroundWindow = user32.func('void* __stdcall GetForegroundWindow()');
        SendInput = user32.func('uint32 __stdcall SendInput(uint32 nInputs, void *pInputs, int cbSize)');
        AllowSetForegroundWindow = user32.func('bool __stdcall AllowSetForegroundWindow(uint32 dwProcessId)');
        GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(void *hWnd, _Out_ uint32 *lpdwProcessId)');

        isInitialized = true;
        console.log('[WinPaste] Initialized native Win32 FFI (user32.dll)');
        return true;
    } catch (e) {
        console.error('[WinPaste] Failed to initialize koffi FFI:', e);
        return false;
    }
}

/**
 * Capture the current foreground window handle.
 * Call this when the hotkey is pressed — the target app IS the foreground window.
 * Much simpler than EnumWindows + PID matching.
 */
export function captureTargetWindow(): boolean {
    if (!isInitialized || !GetForegroundWindow) return false;

    try {
        capturedHwnd = GetForegroundWindow();
        console.log('[WinPaste] Captured foreground window handle');
        return capturedHwnd !== null;
    } catch (e) {
        console.error('[WinPaste] Failed to capture foreground window:', e);
        capturedHwnd = null;
        return false;
    }
}

/**
 * Build a KEYBDINPUT entry in a raw buffer at the given offset.
 *
 * KEYBDINPUT layout within INPUT (x64):
 *   offset+0:  type (DWORD, 4 bytes) = INPUT_KEYBOARD
 *   offset+4:  padding (4 bytes)
 *   offset+8:  wVk (WORD, 2 bytes)
 *   offset+10: wScan (WORD, 2 bytes)
 *   offset+12: dwFlags (DWORD, 4 bytes)
 *   offset+16: time (DWORD, 4 bytes)
 *   offset+20: padding (4 bytes, for ULONG_PTR alignment)
 *   offset+24: dwExtraInfo (ULONG_PTR, 8 bytes)
 */
function writeKeyInput(buf: Buffer, offset: number, vk: number, isKeyUp: boolean): void {
    // Zero entire INPUT struct first
    buf.fill(0, offset, offset + INPUT_SIZE);
    // type = INPUT_KEYBOARD
    buf.writeUInt32LE(INPUT_KEYBOARD, offset);
    // KEYBDINPUT.wVk
    buf.writeUInt16LE(vk, offset + KI_OFFSET);
    // KEYBDINPUT.dwFlags
    buf.writeUInt32LE(isKeyUp ? KEYEVENTF_KEYUP : 0, offset + KI_OFFSET + 4);
}

/** Pointer → numeric address for HWND equality checks (null if unavailable). */
function hwndAddress(ptr: any): bigint | null {
    if (!ptr || !koffiLib?.address) return null;
    try {
        const addr = koffiLib.address(ptr);
        return typeof addr === 'bigint' ? addr : BigInt(addr);
    } catch {
        return null;
    }
}

/** Tiny synchronous wait — used only between focus-verification retries. */
function busyWaitMs(ms: number): void {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin ≤15ms */ }
}

/**
 * Focus the previously captured window and send Ctrl+V paste keystroke.
 * Returns true if both operations succeeded.
 *
 * Total latency: ~2-5ms (vs ~1,150ms with PowerShell)
 */
export function focusAndPaste(pid: number): boolean {
    if (!isInitialized || !capturedHwnd) {
        console.error('[WinPaste] Not initialized or no captured window');
        return false;
    }

    const start = Date.now();

    // Step 1: Focus the captured window
    try {
        AllowSetForegroundWindow(pid);
    } catch { /* non-critical */ }

    SetForegroundWindow(capturedHwnd);

    // Step 1b: VERIFY the target window is actually foreground before firing
    // Ctrl+V. Windows' foreground lock can silently deny SetForegroundWindow
    // (e.g. after the user alt-tabbed away mid-recording); blind-firing the
    // keystroke then pastes into the wrong window — or nowhere — while we
    // report success. SetForegroundWindow can also take a moment, so retry
    // briefly. If focus never lands, bail WITHOUT sending the keystroke so the
    // caller can fall back to the clipboard honestly.
    const targetAddr = hwndAddress(capturedHwnd);
    let verified = targetAddr === null; // can't compare → trust (legacy behavior)
    if (!verified) {
        for (let attempt = 0; attempt < 5; attempt++) {
            if (hwndAddress(GetForegroundWindow()) === targetAddr) { verified = true; break; }
            if (attempt < 4) {
                SetForegroundWindow(capturedHwnd);
                busyWaitMs(15);
            }
        }
    }
    if (!verified) {
        console.warn(`[WinPaste] Focus verification failed for PID ${pid} — NOT sending Ctrl+V`);
        capturedHwnd = null;
        return false;
    }

    // Step 2: Send Ctrl+V via SendInput
    // 4 events: Ctrl down, V down, V up, Ctrl up
    const numInputs = 4;
    const buf = Buffer.alloc(INPUT_SIZE * numInputs);
    writeKeyInput(buf, INPUT_SIZE * 0, VK_CONTROL, false); // Ctrl down
    writeKeyInput(buf, INPUT_SIZE * 1, VK_V, false);       // V down
    writeKeyInput(buf, INPUT_SIZE * 2, VK_V, true);        // V up
    writeKeyInput(buf, INPUT_SIZE * 3, VK_CONTROL, true);  // Ctrl up

    const sent = SendInput(numInputs, buf, INPUT_SIZE);
    const elapsed = Date.now() - start;

    // Clear captured handle after use
    capturedHwnd = null;

    if (sent !== numInputs) {
        console.error(`[WinPaste] SendInput only sent ${sent}/${numInputs} events`);
        return false;
    }

    console.log(`[WinPaste] Focus + Paste completed in ${elapsed}ms`);
    return true;
}

/**
 * PID of the current foreground window via direct FFI (microseconds — safe on
 * hot paths like the hotkey handler, unlike shelling out to PowerShell).
 * Returns null off-Windows or when the call fails.
 */
export function getForegroundPid(): number | null {
    if (!isInitialized || !GetForegroundWindow || !GetWindowThreadProcessId) return null;
    try {
        const hwnd = GetForegroundWindow();
        if (!hwnd) return null;
        const out = [0];
        GetWindowThreadProcessId(hwnd, out);
        return out[0] > 0 ? out[0] : null;
    } catch {
        return null;
    }
}

/**
 * Check if native paste is available (initialized and on Windows)
 */
export function isNativePasteAvailable(): boolean {
    return isInitialized;
}

/**
 * Check if a target window has been captured
 */
export function hasCapturedWindow(): boolean {
    return capturedHwnd !== null;
}
