/**
 * Hotkey Service — Unified cross-platform hotkey handler
 *
 * Supports two modes:
 *   toggle: Press once to start recording, press again to stop (Electron globalShortcut)
 *   hold:   Hold key to record, release to stop (uiohook-napi for keydown/keyup)
 *
 * uiohook-napi uses SetWindowsHookEx on Windows and CGEventTap on macOS
 * for global key-down/key-up detection — works even when app is not focused.
 */

import { globalShortcut, BrowserWindow } from 'electron';
import { uIOhook, UiohookKey } from 'uiohook-napi';

export type HotkeyMode = 'toggle' | 'hold';

interface HotkeyCallbacks {
    onToggle: () => void;       // Toggle mode: single press
    onKeyDown: () => void;      // Hold mode: key pressed
    onKeyUp: () => void;        // Hold mode: key released
}

let currentMode: HotkeyMode = 'toggle';
let currentAccelerator: string = 'Alt+Space';
let callbacks: HotkeyCallbacks | null = null;
let isUiohookStarted = false;
let isKeyCurrentlyDown = false;
let targetKeyCode: number | null = null;

// Map Electron accelerator strings to uiohook key codes
// These are the keys users can select for hold-to-talk
const ACCELERATOR_TO_UIOHOOK: Record<string, number> = {
    'F1': UiohookKey.F1,
    'F2': UiohookKey.F2,
    'F3': UiohookKey.F3,
    'F4': UiohookKey.F4,
    'F5': UiohookKey.F5,
    'F6': UiohookKey.F6,
    'F7': UiohookKey.F7,
    'F8': UiohookKey.F8,
    'F9': UiohookKey.F9,
    'F10': UiohookKey.F10,
    'F11': UiohookKey.F11,
    'F12': UiohookKey.F12,
    'Alt+Space': UiohookKey.Space,
    'Control+Shift+Space': UiohookKey.Space,
    'Control+Shift+R': UiohookKey.R,
};

// Single-key options exposed to the settings UI for hold-to-talk mode
export const HOLD_MODE_KEYS = [
    { value: 'F5', label: 'F5' },
    { value: 'F6', label: 'F6' },
    { value: 'F7', label: 'F7' },
    { value: 'F8', label: 'F8' },
    { value: 'F9', label: 'F9' },
    { value: 'F10', label: 'F10' },
    { value: 'F11', label: 'F11' },
    { value: 'F12', label: 'F12' },
];

/**
 * Initialize the hotkey service with callbacks
 */
export function initHotkeyService(cbs: HotkeyCallbacks): void {
    callbacks = cbs;
}

/**
 * Register a hotkey in the specified mode
 */
export function registerHotkeyService(
    accelerator: string,
    mode: HotkeyMode
): boolean {
    // Clean up previous registration
    stopHotkeyService();

    currentMode = mode;
    currentAccelerator = accelerator;

    if (mode === 'toggle') {
        return registerToggleMode(accelerator);
    } else {
        return registerHoldMode(accelerator);
    }
}

/**
 * Toggle mode — uses Electron's globalShortcut (existing behavior)
 */
function registerToggleMode(accelerator: string): boolean {
    globalShortcut.unregisterAll();

    let key = accelerator;
    if (!key || key.trim() === '' || key === '=') key = 'Alt+Space';

    // On Windows, convert macOS-specific modifiers
    if (process.platform === 'win32') {
        key = key.replace(/Command/g, 'Control').replace(/⌘/g, 'Control');
    }

    // Validate: hotkey must have at least one non-modifier key
    const modifiers = ['Control', 'Alt', 'Shift', 'Command', 'Meta', 'Super'];
    const parts = key.split('+').map(p => p.trim());
    const hasNonModifier = parts.some(p => !modifiers.includes(p));
    if (!hasNonModifier) {
        console.log(`[Hotkey] Invalid hotkey "${key}" (modifiers only), defaulting to Alt+Space`);
        key = 'Alt+Space';
    }

    try {
        const success = globalShortcut.register(key, () => {
            callbacks?.onToggle();
        });

        if (success) console.log(`[Hotkey] Toggle mode registered: ${key}`);
        else console.error(`[Hotkey] Failed to register: ${key}`);
        return success;
    } catch (err) {
        console.error(`[Hotkey] Registration error:`, err);
        if (key !== 'Alt+Space') {
            console.log('[Hotkey] Falling back to Alt+Space');
            return registerToggleMode('Alt+Space');
        }
        return false;
    }
}

/**
 * Hold mode — uses uiohook-napi for global keydown/keyup
 */
function registerHoldMode(accelerator: string): boolean {
    // Unregister any globalShortcut first
    globalShortcut.unregisterAll();

    // Resolve the target key code
    targetKeyCode = ACCELERATOR_TO_UIOHOOK[accelerator] ?? null;
    if (targetKeyCode === null) {
        console.error(`[Hotkey] No uiohook mapping for "${accelerator}", falling back to F8`);
        targetKeyCode = UiohookKey.F8;
    }

    isKeyCurrentlyDown = false;

    // Set up uiohook event listeners
    uIOhook.removeAllListeners();

    uIOhook.on('keydown', (e) => {
        if (e.keycode !== targetKeyCode) return;
        // Ignore key-repeat events (OS sends repeated keydown while held)
        if (isKeyCurrentlyDown) return;
        isKeyCurrentlyDown = true;
        console.log('[Hotkey] Hold key down');
        callbacks?.onKeyDown();
    });

    uIOhook.on('keyup', (e) => {
        if (e.keycode !== targetKeyCode) return;
        if (!isKeyCurrentlyDown) return;
        isKeyCurrentlyDown = false;
        console.log('[Hotkey] Hold key up');
        callbacks?.onKeyUp();
    });

    // Start the hook if not already running
    if (!isUiohookStarted) {
        try {
            uIOhook.start();
            isUiohookStarted = true;
            console.log(`[Hotkey] Hold mode started, listening for keycode ${targetKeyCode} (${accelerator})`);
        } catch (err) {
            console.error('[Hotkey] Failed to start uiohook:', err);
            return false;
        }
    } else {
        console.log(`[Hotkey] Hold mode updated, listening for keycode ${targetKeyCode} (${accelerator})`);
    }

    return true;
}

/**
 * Stop all hotkey listeners and clean up
 */
export function stopHotkeyService(): void {
    globalShortcut.unregisterAll();

    if (isUiohookStarted) {
        try {
            uIOhook.stop();
        } catch { /* ignore */ }
        isUiohookStarted = false;
    }
    uIOhook.removeAllListeners();
    isKeyCurrentlyDown = false;
    targetKeyCode = null;
}

/**
 * Get current mode
 */
export function getHotkeyMode(): HotkeyMode {
    return currentMode;
}
