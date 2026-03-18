/**
 * Clarity Scribe — Electron Main Process
 * 
 * Lightweight dictation app: global hotkey, Whisper transcription,
 * paste-to-target with clipboard restore, transcription history.
 */
import { app, BrowserWindow, globalShortcut, ipcMain, clipboard, Tray, Menu, nativeImage, screen, powerMonitor } from 'electron';
import { exec, execSync } from 'child_process';
import * as path from 'path';
import Store from 'electron-store';
import * as nativeWhisper from './nativeWhisper';

const store = new Store();

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isWhisperReady = false;

// --- History Storage ---
interface HistoryEntry {
    id: string;
    text: string;
    timestamp: number;
    app: string;
}

function getHistory(): HistoryEntry[] {
    return (store.get('history') as HistoryEntry[]) || [];
}

function addHistoryEntry(entry: HistoryEntry): void {
    const history = getHistory();
    history.unshift(entry);
    if (history.length > 200) history.length = 200;
    store.set('history', history);
}

function clearHistory(): void {
    store.set('history', []);
}

function deleteHistoryEntry(id: string): void {
    const history = getHistory();
    const filtered = history.filter(e => e.id !== id);
    store.set('history', filtered);
}

// --- Active App Detection ---
interface TargetApp {
    name: string;
    pid: number;
}

interface CachedApp extends TargetApp {
    timestamp: number;
}

const CACHE_EXPIRY_MS = 2000;
const CACHE_EXPIRY_AFTER_WAKE_MS = 5000;
const WAKE_GRACE_PERIOD_MS = 3000;

let targetAppBeforeRecording: TargetApp | null = null;
let targetAppConfidence: 'confirmed' | 'cached' | 'stale' | 'unknown' = 'unknown';
let lastKnownFrontApp: CachedApp | null = null;
let lastWakeTimestamp = 0;
let lastSuccessfulPollTimestamp = 0;
let isCurrentlyRecording = false;
let pollingInterval: ReturnType<typeof setInterval> | null = null;

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function getEffectiveCacheExpiry(): number {
    const timeSinceWake = Date.now() - lastWakeTimestamp;
    if (lastWakeTimestamp > 0 && timeSinceWake < WAKE_GRACE_PERIOD_MS) {
        return CACHE_EXPIRY_AFTER_WAKE_MS;
    }
    return CACHE_EXPIRY_MS;
}

// macOS: AppleScript-based active app detection
function detectActiveAppMac(): { name: string; pid: number } | null {
    try {
        const result = execSync(
            `osascript -e 'tell application "System Events" to return (name of first application process whose frontmost is true) & "|" & (unix id of first application process whose frontmost is true)'`,
            { encoding: 'utf-8', timeout: 2000 }
        ).trim();
        const [name, pidStr] = result.split('|');
        const pid = parseInt(pidStr, 10);
        if (!name || isNaN(pid)) return null;
        return { name, pid };
    } catch {
        return null;
    }
}

// Windows: PowerShell-based active app detection
function detectActiveAppWindows(): { name: string; pid: number } | null {
    try {
        const script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Win32 {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
}
'@
$hwnd = [Win32]::GetForegroundWindow()
$pid = 0
[Win32]::GetWindowThreadProcessId($hwnd, [ref]$pid) | Out-Null
$proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
if ($proc) { Write-Output "$($proc.ProcessName)|$pid" }
`;
        const result = execSync(`powershell -NoProfile -Command "${script.replace(/\n/g, ';').replace(/"/g, '\\"')}"`, {
            encoding: 'utf-8',
            timeout: 3000
        }).trim();
        const [name, pidStr] = result.split('|');
        const pid = parseInt(pidStr, 10);
        if (!name || isNaN(pid)) return null;
        return { name, pid };
    } catch {
        return null;
    }
}

function inlineDetectActiveApp(): { name: string; pid: number } | null {
    return process.platform === 'darwin' ? detectActiveAppMac() : detectActiveAppWindows();
}

function startActiveAppPolling(): void {
    console.log('[Main] Starting active app polling...');
    let isPolling = false;
    const ourPid = process.pid;

    if (process.platform === 'darwin') {
        pollingInterval = setInterval(() => {
            if (isPolling) return;
            isPolling = true;

            const script = `tell application "System Events"
                set frontApp to first application process whose frontmost is true
                return (name of frontApp) & "|" & (unix id of frontApp)
            end tell`;

            exec(`osascript -e '${script}'`, { encoding: 'utf-8', timeout: 3000 }, (error, stdout) => {
                isPolling = false;
                if (error) return;
                try {
                    const [activeApp, pidStr] = stdout.trim().split('|');
                    const activePid = parseInt(pidStr, 10);
                    if (activeApp && activePid !== ourPid && activeApp !== 'Clarity Scribe') {
                        // Only cache external apps — skip ourselves so lastKnownFrontApp
                        // always points to the app the user was in before clicking our widget
                        lastKnownFrontApp = { name: activeApp, pid: activePid, timestamp: Date.now() };
                        lastSuccessfulPollTimestamp = Date.now();
                    }
                } catch { /* ignore */ }
            });
        }, 500);
    } else {
        pollingInterval = setInterval(() => {
            if (isPolling) return;
            isPolling = true;
            const detected = detectActiveAppWindows();
            isPolling = false;
            if (detected && detected.pid !== ourPid && detected.name !== 'Clarity Scribe') {
                lastKnownFrontApp = { ...detected, timestamp: Date.now() };
                lastSuccessfulPollTimestamp = Date.now();
            }
        }, 1000);
    }
}

// --- Paste to Target ---
function execPromise(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
        exec(command, { encoding: 'utf-8', timeout: 5000 }, (err, stdout) => {
            if (err) reject(err);
            else resolve(stdout);
        });
    });
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function pasteToTarget(text: string): Promise<{ success: boolean; fallback?: string; app?: string; reason?: string }> {
    const targetApp = targetAppBeforeRecording;
    if (!targetApp) {
        clipboard.writeText(text);
        return { success: false, fallback: 'clipboard' };
    }

    if (!isProcessAlive(targetApp.pid)) {
        clipboard.writeText(text);
        targetAppBeforeRecording = null;
        return { success: false, fallback: 'clipboard', reason: 'process-dead' };
    }

    const originalClipboard = clipboard.readText();
    const hadOriginalContent = originalClipboard.length > 0;

    try {
        clipboard.writeText(text);

        if (process.platform === 'darwin') {
            const activateScript = `tell application "System Events"
                set targetProcess to first application process whose unix id is ${targetApp.pid}
                set frontmost of targetProcess to true
            end tell`;
            await execPromise(`osascript -e '${activateScript}'`);
            await delay(100);

            // Verify focus
            const verifyScript = `tell application "System Events" to return (unix id of first application process whose frontmost is true)`;
            try {
                const currentPidStr = (await execPromise(`osascript -e '${verifyScript}'`)).trim();
                const currentPid = parseInt(currentPidStr, 10);
                if (currentPid !== targetApp.pid) {
                    console.log(`[Main] Focus verification failed, clipboard fallback`);
                    // Text is already in clipboard from above
                    targetAppBeforeRecording = null;
                    if (hadOriginalContent) {
                        // Don't restore — the user needs the transcription
                    }
                    return { success: false, fallback: 'clipboard', reason: 'focus-failed' };
                }
            } catch { /* continue anyway */ }

            const pasteScript = `tell application "System Events" to keystroke "v" using command down`;
            await execPromise(`osascript -e '${pasteScript}'`);
        } else {
            // Windows
            const winScript = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Win32Focus {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@
$proc = Get-Process -Id ${targetApp.pid} -ErrorAction SilentlyContinue
if ($proc -and $proc.MainWindowHandle) {
    [Win32Focus]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
    Start-Sleep -Milliseconds 100
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.SendKeys]::SendWait("^v")
}
`;
            await execPromise(`powershell -NoProfile -Command "${winScript.replace(/\n/g, ';').replace(/"/g, '\\"')}"`);
        }

        await delay(300);

        // Restore original clipboard
        if (hadOriginalContent) {
            clipboard.writeText(originalClipboard);
            console.log(`[Main] Pasted to ${targetApp.name}, clipboard restored`);
        } else {
            clipboard.clear();
        }

        targetAppBeforeRecording = null;
        return { success: true, app: targetApp.name };
    } catch (e) {
        if (hadOriginalContent) clipboard.writeText(originalClipboard);
        console.error('[Main] Paste failed:', e);
        return { success: false, fallback: 'clipboard' };
    }
}

// --- Window ---
function createWindow(): void {
    mainWindow = new BrowserWindow({
        width: 340,
        height: 64,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        resizable: false,
        movable: true,
        skipTaskbar: true,
        hasShadow: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
        },
    });

    const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
    const saved = store.get('windowBounds') as { x: number; y: number } | undefined;

    if (saved && saved.x >= 0 && saved.x < screenWidth - 50 && saved.y >= 0 && saved.y < screenHeight - 50) {
        // Use saved position only if it's still on-screen
        mainWindow.setPosition(saved.x, saved.y);
    } else {
        // Center horizontally, upper third vertically
        const x = Math.round((screenWidth - 340) / 2);
        const y = Math.round(screenHeight * 0.3);
        mainWindow.setPosition(x, y);
    }

    mainWindow.on('moved', () => {
        if (mainWindow) {
            const [x, y] = mainWindow.getPosition();
            store.set('windowBounds', { x, y });
        }
    });

    if (!app.isPackaged) {
        mainWindow.loadURL('http://localhost:5198');
    } else {
        mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
    }
}

// --- Tray ---
function createTray(): void {
    try {
        const icon = nativeImage.createEmpty();
        tray = new Tray(icon);
        tray.setToolTip('Clarity Scribe');
        tray.setContextMenu(Menu.buildFromTemplate([
            { label: 'Show', click: () => mainWindow?.show() },
            { label: 'Quit', click: () => { (app as any).isQuitting = true; app.quit(); } },
        ]));
    } catch {
        console.log('[Main] Tray icon not available');
    }
}

// --- Global Hotkey ---
function registerHotkey(key: string): boolean {
    globalShortcut.unregisterAll();
    if (!key || key.trim() === '' || key === '=') key = 'Alt+Space';

    try {
        const success = globalShortcut.register(key, () => {
            console.log('[Main] Hotkey triggered');

            if (!isCurrentlyRecording) {
                if (lastKnownFrontApp) {
                    const cacheAge = Date.now() - lastKnownFrontApp.timestamp;
                    targetAppBeforeRecording = lastKnownFrontApp;
                    targetAppConfidence = cacheAge < getEffectiveCacheExpiry() ? 'cached' : 'stale';
                } else {
                    targetAppBeforeRecording = null;
                    targetAppConfidence = 'unknown';
                }
                isCurrentlyRecording = true;
            } else {
                if (targetAppBeforeRecording && !isProcessAlive(targetAppBeforeRecording.pid)) {
                    targetAppBeforeRecording = null;
                }
                isCurrentlyRecording = false;
            }

            mainWindow?.webContents.send('toggle-recording');
        });

        if (success) console.log(`[Main] Hotkey registered: ${key}`);
        return success;
    } catch (err) {
        console.error(`[Main] Hotkey error:`, err);
        return false;
    }
}

// --- IPC Handlers ---
function setupIpcHandlers(): void {
    ipcMain.handle('transcribe', async (_, audioData: Float32Array | number[], sampleRate: number) => {
        if (!isWhisperReady) return { success: false, error: 'Whisper not ready' };
        try {
            const audioBuffer = audioData instanceof Float32Array ? audioData : new Float32Array(audioData);
            const settings = store.get('settings') as any;
            const language = settings?.whisperLanguage || 'en';
            const text = await nativeWhisper.transcribe(audioBuffer, { language });
            console.log(`[Main] Transcribed: "${text.substring(0, 80)}"`);
            mainWindow?.webContents.send('transcription-result', text);
            return { success: true, text };
        } catch (error: any) {
            console.error('[Main] Transcribe error:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('is-whisper-ready', () => isWhisperReady);

    ipcMain.handle('get-target-app', () => {
        const detected = inlineDetectActiveApp();
        if (detected) {
            targetAppBeforeRecording = detected;
            targetAppConfidence = 'confirmed';
            lastKnownFrontApp = { ...detected, timestamp: Date.now() };
        }
        return { targetApp: targetAppBeforeRecording, confidence: targetAppConfidence };
    });

    ipcMain.handle('clear-target-app', () => { targetAppBeforeRecording = null; });
    ipcMain.handle('paste-to-target', async (_, text: string) => pasteToTarget(text));
    ipcMain.handle('copy-to-clipboard', (_, text: string) => { if (text) clipboard.writeText(text); return !!text; });

    // Widget mic button click — captures target app from poller cache
    // (before the click steals focus to Clarity Scribe's window)
    ipcMain.handle('widget-toggle-recording', () => {
        console.log('[Main] Widget toggle recording triggered');

        if (!isCurrentlyRecording) {
            // Starting — capture target from cache (should be the external app)
            if (lastKnownFrontApp) {
                const cacheAge = Date.now() - lastKnownFrontApp.timestamp;
                if (cacheAge < getEffectiveCacheExpiry()) {
                    targetAppBeforeRecording = lastKnownFrontApp;
                    targetAppConfidence = 'cached';
                    console.log(`[Main] Widget: captured target ${lastKnownFrontApp.name} (PID: ${lastKnownFrontApp.pid})`);
                } else {
                    targetAppBeforeRecording = null;
                    targetAppConfidence = 'stale';
                }
            } else {
                targetAppBeforeRecording = null;
                targetAppConfidence = 'unknown';
            }
            isCurrentlyRecording = true;
        } else {
            // Stopping — validate target is still alive
            if (targetAppBeforeRecording && !isProcessAlive(targetAppBeforeRecording.pid)) {
                console.log(`[Main] Widget: target died during recording, clearing`);
                targetAppBeforeRecording = null;
            }
            isCurrentlyRecording = false;
        }

        mainWindow?.webContents.send('toggle-recording');
        return { success: true };
    });

    // Settings
    ipcMain.handle('get-settings', () => store.get('settings') || {});
    ipcMain.handle('save-settings', (_, settings) => {
        store.set('settings', settings);
        if (settings.hotkey) registerHotkey(settings.hotkey);
    });
    ipcMain.handle('get-hotkey', () => store.get('hotkey') || 'Alt+Space');
    ipcMain.handle('set-hotkey', (_, key) => { store.set('hotkey', key); return registerHotkey(key); });

    // History
    ipcMain.handle('get-history', () => getHistory());
    ipcMain.handle('add-history', (_, entry: HistoryEntry) => addHistoryEntry(entry));
    ipcMain.handle('clear-history', () => clearHistory());
    ipcMain.handle('delete-history-entry', (_, id: string) => deleteHistoryEntry(id));

    // Window
    ipcMain.handle('quit-app', () => { (app as any).isQuitting = true; app.quit(); });
    ipcMain.handle('set-window-size', (_, { width, height }: { width: number; height: number }) => {
        mainWindow?.setSize(width, height, true);
    });
}

// --- App Lifecycle ---
app.dock?.hide();

app.whenReady().then(async () => {
    createWindow();
    createTray();
    setupIpcHandlers();

    console.log('[Main] Initializing Whisper...');
    try {
        const ready = await nativeWhisper.initWhisper('turbo', (percent, status) => {
            console.log(`[Main] Whisper: ${status} (${percent}%)`);
            mainWindow?.webContents.send('whisper-progress', percent, status);
        });
        isWhisperReady = ready;
        if (ready) {
            mainWindow?.webContents.send('whisper-ready', { acceleration: nativeWhisper.getAccelerationInfo().type });
            console.log(`[Main] ✓ Whisper ready`);
        } else {
            console.error('[Main] Whisper failed to initialize');
        }
    } catch (error) {
        console.error('[Main] Whisper init error:', error);
    }

    registerHotkey((store.get('hotkey') as string) || 'Alt+Space');
    startActiveAppPolling();

    powerMonitor.on('suspend', () => { lastKnownFrontApp = null; });
    powerMonitor.on('resume', () => {
        lastWakeTimestamp = Date.now();
        const detected = inlineDetectActiveApp();
        if (detected) lastKnownFrontApp = { ...detected, timestamp: Date.now() };
    });
    powerMonitor.on('unlock-screen', () => { lastWakeTimestamp = Date.now(); });
});

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (pollingInterval) clearInterval(pollingInterval);
    nativeWhisper.cleanup();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
