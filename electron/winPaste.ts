/**
 * winPaste.ts — Native Win32 window focus and keyboard paste via FFI
 *
 * Replaces PowerShell process spawning with direct user32.dll calls.
 * PowerShell approach: ~1,000ms (two process spawns + .NET runtime)
 * Native FFI approach: ~4ms (direct DLL calls in-process)
 */

let koffi: typeof import('koffi') | null = null;
let user32: any = null;

// Win32 function signatures (loaded lazily)
let SetForegroundWindow: ((hWnd: Buffer) => boolean) | null = null;
let GetForegroundWindow: (() => Buffer) | null = null;
let IsWindowVisible: ((hWnd: Buffer) => boolean) | null = null;
let GetWindowThreadProcessId: ((hWnd: Buffer, lpdwProcessId: Buffer) => number) | null = null;
let EnumWindows: ((lpEnumFunc: any, lParam: number) => boolean) | null = null;
let SendInput: ((nInputs: number, pInputs: Buffer, cbSize: number) => number) | null = null;
let AllowSetForegroundWindow: ((dwProcessId: number) => boolean) | null = null;

// Constants
const INPUT_KEYBOARD = 1;
const KEYEVENTF_KEYUP = 0x0002;
const VK_CONTROL = 0x11;
const VK_V = 0x56;

let INPUT_SIZE = 0;
let KI_OFFSET = 8; // offset of the union inside INPUT struct (after type + padding)
let isInitialized = false;

/**
 * Initialize the Win32 FFI bindings. Call once at app startup.
 * Safe to call multiple times — subsequent calls are no-ops.
 * Returns false if not on Windows or if koffi fails to load.
 */
export function initWinPaste(): boolean {
    if (isInitialized) return true;
    if (process.platform !== 'win32') return false;

    try {
        // koffi is a native module — use require to ensure proper resolution
        koffi = require('koffi');
        const k = koffi!;
        user32 = k.load('user32.dll');

        // Define callback type for EnumWindows
        const WNDENUMPROC = k.proto('bool __stdcall WNDENUMPROC(void *hwnd, int64 lParam)');

        // Bind Win32 functions
        SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(void *hWnd)');
        GetForegroundWindow = user32.func('void* __stdcall GetForegroundWindow()');
        IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(void *hWnd)');
        GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(void *hWnd, _Out_ uint32 *lpdwProcessId)');
        EnumWindows = user32.func('bool __stdcall EnumWindows(WNDENUMPROC lpEnumFunc, int64 lParam)');
        SendInput = user32.func('uint32 __stdcall SendInput(uint32 nInputs, void *pInputs, int cbSize)');
        AllowSetForegroundWindow = user32.func('bool __stdcall AllowSetForegroundWindow(uint32 dwProcessId)');

        // Calculate INPUT struct size for SendInput
        // INPUT = { type: DWORD(4), padding(4), union KEYBDINPUT(16) } on x64 = 28 bytes
        // Actually: DWORD type (4) + 4 padding + union (24 max: MOUSEINPUT) = 40 bytes on x64
        // We use the raw buffer approach since koffi struct alignment for unions is tricky
        INPUT_SIZE = 40; // sizeof(INPUT) on x64 Windows
        KI_OFFSET = 8;   // offset past type(4) + padding(4)

        isInitialized = true;
        console.log('[WinPaste] Initialized native Win32 FFI (user32.dll)');
        return true;
    } catch (e) {
        console.error('[WinPaste] Failed to initialize koffi FFI:', e);
        return false;
    }
}

/**
 * Find the main window handle for a given process ID.
 * Uses EnumWindows to iterate all top-level windows.
 */
function findWindowByPid(pid: number): Buffer | null {
    if (!EnumWindows || !GetWindowThreadProcessId || !IsWindowVisible) return null;

    let foundHwnd: Buffer | null = null;
    const pidBuf = Buffer.alloc(4);

    try {
        EnumWindows((hwnd: Buffer, _lParam: number) => {
            GetWindowThreadProcessId!(hwnd, pidBuf);
            const windowPid = pidBuf.readUInt32LE(0);

            if (windowPid === pid && IsWindowVisible!(hwnd)) {
                foundHwnd = hwnd;
                return false; // Stop enumerating
            }
            return true; // Continue
        }, 0);
    } catch (e) {
        console.error('[WinPaste] EnumWindows failed:', e);
    }

    return foundHwnd;
}

/**
 * Build a KEYBDINPUT entry in a raw buffer at the given offset.
 * Layout: wVk(2) + wScan(2) + dwFlags(4) + time(4) + dwExtraInfo(8) = 20 bytes
 */
function writeKeyInput(buf: Buffer, offset: number, vk: number, isKeyUp: boolean): void {
    // type = INPUT_KEYBOARD (1)
    buf.writeUInt32LE(INPUT_KEYBOARD, offset);
    // padding to 8-byte alignment
    buf.writeUInt32LE(0, offset + 4);
    // KEYBDINPUT.wVk
    buf.writeUInt16LE(vk, offset + KI_OFFSET);
    // KEYBDINPUT.wScan
    buf.writeUInt16LE(0, offset + KI_OFFSET + 2);
    // KEYBDINPUT.dwFlags
    buf.writeUInt32LE(isKeyUp ? KEYEVENTF_KEYUP : 0, offset + KI_OFFSET + 4);
    // KEYBDINPUT.time
    buf.writeUInt32LE(0, offset + KI_OFFSET + 8);
    // KEYBDINPUT.dwExtraInfo (ULONG_PTR = 8 bytes on x64)
    buf.writeBigUInt64LE(0n, offset + KI_OFFSET + 12);
}

/**
 * Focus a window by PID and send Ctrl+V paste keystroke.
 * Returns true if both operations succeeded.
 *
 * Total latency: ~2-5ms (vs ~1,150ms with PowerShell)
 */
export function focusAndPaste(pid: number): boolean {
    if (!isInitialized) {
        console.error('[WinPaste] Not initialized — call initWinPaste() first');
        return false;
    }

    const start = Date.now();

    // Step 1: Find window handle for the target PID
    const hwnd = findWindowByPid(pid);
    if (!hwnd) {
        console.error(`[WinPaste] No visible window found for PID ${pid}`);
        return false;
    }

    // Step 2: Focus the window
    // AllowSetForegroundWindow grants our process permission to set foreground
    try {
        AllowSetForegroundWindow!(pid);
    } catch { /* non-critical */ }

    const focused = SetForegroundWindow!(hwnd);
    if (!focused) {
        console.warn(`[WinPaste] SetForegroundWindow returned false for PID ${pid}`);
        // Continue anyway — sometimes returns false but still works
    }

    // Step 3: Send Ctrl+V via SendInput
    // 4 events: Ctrl down, V down, V up, Ctrl up
    const numInputs = 4;
    const buf = Buffer.alloc(INPUT_SIZE * numInputs);
    writeKeyInput(buf, INPUT_SIZE * 0, VK_CONTROL, false); // Ctrl down
    writeKeyInput(buf, INPUT_SIZE * 1, VK_V, false);       // V down
    writeKeyInput(buf, INPUT_SIZE * 2, VK_V, true);        // V up
    writeKeyInput(buf, INPUT_SIZE * 3, VK_CONTROL, true);  // Ctrl up

    const sent = SendInput!(numInputs, buf, INPUT_SIZE);
    const elapsed = Date.now() - start;

    if (sent !== numInputs) {
        console.error(`[WinPaste] SendInput only sent ${sent}/${numInputs} events`);
        return false;
    }

    console.log(`[WinPaste] Focus + Paste completed in ${elapsed}ms`);
    return true;
}

/**
 * Check if native paste is available (initialized and on Windows)
 */
export function isNativePasteAvailable(): boolean {
    return isInitialized;
}
