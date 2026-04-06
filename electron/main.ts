/**
 * Clarity Scribe — Electron Main Process
 * 
 * Lightweight dictation app: global hotkey, Whisper transcription,
 * paste-to-target with clipboard restore, transcription history.
 */
import { app, BrowserWindow, globalShortcut, ipcMain, clipboard, Tray, Menu, nativeImage, screen, powerMonitor, systemPreferences } from 'electron';
import { exec, execSync } from 'child_process';
import * as path from 'path';
import Store from 'electron-store';
import * as nativeWhisper from './nativeWhisper';
import { initWinPaste, focusAndPaste, isNativePasteAvailable, captureTargetWindow } from './winPaste';

const store = new Store();

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isWhisperReady = false;

// Initialize native Win32 paste (loads user32.dll via FFI)
if (process.platform === 'win32') {
    initWinPaste();
}

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
        const result = execSync(
            'powershell -NoProfile -Command "Add-Type -MemberDefinition \'[DllImport(\\\"user32.dll\\\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\\\"user32.dll\\\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);\' -Name Win32 -Namespace Temp -ErrorAction SilentlyContinue; $h=[Temp.Win32]::GetForegroundWindow(); $p=0; [Temp.Win32]::GetWindowThreadProcessId($h,[ref]$p)|Out-Null; $pr=Get-Process -Id $p -ErrorAction SilentlyContinue; if($pr){Write-Output($pr.ProcessName+\'|\'+$p)}"',
            { encoding: 'utf-8', timeout: 3000, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }
        ).trim();
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
        // Windows: async polling using exec (never block the main thread)
        const PS_COMMAND = 'powershell -NoProfile -Command "Add-Type -MemberDefinition \'[DllImport(\\\"user32.dll\\\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\\\"user32.dll\\\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);\' -Name Win32 -Namespace Temp -ErrorAction SilentlyContinue; $h=[Temp.Win32]::GetForegroundWindow(); $p=0; [Temp.Win32]::GetWindowThreadProcessId($h,[ref]$p)|Out-Null; $pr=Get-Process -Id $p -ErrorAction SilentlyContinue; if($pr){Write-Output($pr.ProcessName+\'|\'+$p)}"';

        pollingInterval = setInterval(() => {
            if (isPolling) return;
            isPolling = true;

            exec(PS_COMMAND, { encoding: 'utf-8', timeout: 3000, windowsHide: true }, (error, stdout) => {
                isPolling = false;
                if (error) return;
                try {
                    const result = stdout.trim();
                    const [name, pidStr] = result.split('|');
                    const pid = parseInt(pidStr, 10);
                    if (name && !isNaN(pid) && pid !== ourPid && name !== 'Clarity Scribe') {
                        lastKnownFrontApp = { name, pid, timestamp: Date.now() };
                        lastSuccessfulPollTimestamp = Date.now();
                    }
                } catch { /* ignore */ }
            });
        }, 1500);
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
            // macOS: Single consolidated AppleScript — focus, verify, and paste in one call
            // Old approach used 3 separate osascript calls + 200ms of delays (~350ms total)
            // This consolidation brings paste latency down to ~80ms
            const script = `
                tell application "System Events"
                    set frontmost of (first application process whose unix id is ${targetApp.pid}) to true
                    delay 0.05
                    set currentPid to unix id of first application process whose frontmost is true
                    if currentPid is not ${targetApp.pid} then
                        error "focus failed"
                    end if
                    keystroke "v" using command down
                end tell
            `;
            try {
                await execPromise(`osascript -e '${script.replace(/'/g, "'\\''")}'`);
            } catch (e: any) {
                if (e?.message?.includes('focus failed') || e?.stderr?.includes('focus failed')) {
                    console.log('[Main] Focus verification failed, clipboard fallback');
                    targetAppBeforeRecording = null;
                    return { success: false, fallback: 'clipboard', reason: 'focus-failed' };
                }
                throw e;
            }
        } else {
            // Windows: native Win32 FFI to focus and paste (~4ms vs ~1100ms for PowerShell)
            if (isNativePasteAvailable()) {
                const ok = focusAndPaste(targetApp.pid);
                if (!ok) {
                    console.error('[Main] Native paste failed, falling back to PowerShell');
                    // Fallback to PowerShell if native fails
                    const focusCmd = 'powershell -NoProfile -Command "Add-Type -MemberDefinition \'[DllImport(\\\"user32.dll\\\")] public static extern bool SetForegroundWindow(IntPtr hWnd);\' -Name WF -Namespace Temp -ErrorAction SilentlyContinue; $p=Get-Process -Id ' + targetApp.pid + ' -ErrorAction SilentlyContinue; if($p -and $p.MainWindowHandle){[Temp.WF]::SetForegroundWindow($p.MainWindowHandle)|Out-Null}"';
                    await execPromise(focusCmd);
                    await delay(150);
                    const pasteCmd = 'powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(\'^v\')"';
                    await execPromise(pasteCmd);
                }
            } else {
                // Fallback: PowerShell when koffi is unavailable
                const focusCmd = 'powershell -NoProfile -Command "Add-Type -MemberDefinition \'[DllImport(\\\"user32.dll\\\")] public static extern bool SetForegroundWindow(IntPtr hWnd);\' -Name WF -Namespace Temp -ErrorAction SilentlyContinue; $p=Get-Process -Id ' + targetApp.pid + ' -ErrorAction SilentlyContinue; if($p -and $p.MainWindowHandle){[Temp.WF]::SetForegroundWindow($p.MainWindowHandle)|Out-Null}"';
                await execPromise(focusCmd);
                await delay(150);
                const pasteCmd = 'powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(\'^v\')"';
                await execPromise(pasteCmd);
            }
        }

        await delay(50); // Min safe delay — target app must read clipboard before restore

        // Restore original clipboard
        if (hadOriginalContent) {
            clipboard.writeText(originalClipboard);
            console.log('[Main] Pasted to ' + targetApp.name + ', clipboard restored');
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
    const isWin = process.platform === 'win32';
    mainWindow = new BrowserWindow({
        width: 340,
        height: 64,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        resizable: false,
        movable: true,
        skipTaskbar: isWin ? false : true,
        hasShadow: false,
        ...(isWin ? { icon: path.join(__dirname, '../resources/icon.png') } : {}),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
        },
    });

    const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
    const saved = store.get('windowBounds') as { x: number; y: number } | undefined;

    if (saved && saved.x >= 0 && saved.x < screenWidth - 50 && saved.y >= 0 && saved.y < screenHeight - 50) {
        mainWindow.setPosition(saved.x, saved.y);
    } else {
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
function createTrayIcon(): Electron.NativeImage {
    const size = 16;
    if (process.platform === 'win32') {
        // Windows: Generate a proper 16x16 RGBA PNG for the system tray
        // Simple microphone icon in white on transparent background
        const img = nativeImage.createEmpty();
        // Use a base64-encoded 16x16 PNG microphone icon
        const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA' +
            'mklEQVQ4y2NgGAWkAEYo/R8KGCkxgJGBgYGFgYHhPxD/h2IWKA0D' +
            'LFANYIayQRgEQGwWqAYQzcy4DGCBagBhkCQLLgNYoGx0AxgpMYCF' +
            'Eg1gga0eBv4jNJBkACMKG90ARgYI+I+kgRFdA5BmhjqHBSTDDCAH' +
            'sECdw4JLAwuaH1gI+QGfBuwaWIgJJFwaWAgZQJIGfBoYKdGADwAA' +
            'GmwZEWhKgZkAAAAASUVORK5CYII=';
        return nativeImage.createFromBuffer(Buffer.from(pngBase64, 'base64'), { width: size, height: size });
    } else {
        // macOS: SVG template image for menu bar
        const canvas = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
<circle cx="8" cy="8" r="6" fill="black"/>
<circle cx="8" cy="5" r="2.5" fill="white"/>
<path d="M5.5,6.5 Q5.5,10 8,10 Q10.5,10 10.5,6.5" fill="none" stroke="white" stroke-width="1.2"/>
<line x1="8" y1="10.5" x2="8" y2="12.5" stroke="white" stroke-width="1"/>
<line x1="6" y1="12.5" x2="10" y2="12.5" stroke="white" stroke-width="1"/>
</svg>`;
        const icon = nativeImage.createFromBuffer(Buffer.from(canvas));
        icon.setTemplateImage(true);
        return icon;
    }
}

function createTray(): void {
    try {
        const icon = createTrayIcon();
        tray = new Tray(icon);
        tray.setToolTip('Clarity Scribe');
        tray.setContextMenu(Menu.buildFromTemplate([
            { label: 'Show', click: () => mainWindow?.show() },
            { type: 'separator' },
            { label: 'Quit', click: () => { (app as any).isQuitting = true; app.quit(); } },
        ]));
    } catch (e) {
        console.log('[Main] Tray icon not available:', e);
    }
}

// --- Global Hotkey ---
function registerHotkey(key: string): boolean {
    globalShortcut.unregisterAll();
    const originalKey = key;
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
        console.log(`[Main] Invalid hotkey "${key}" (modifiers only), defaulting to Alt+Space`);
        key = 'Alt+Space';
    }

    // If the key was corrected, update the store so UI stays in sync
    if (key !== originalKey) {
        store.set('hotkey', key);
        // Also update settings.hotkey if settings exist
        const settings = store.get('settings') as any;
        if (settings) {
            settings.hotkey = key;
            store.set('settings', settings);
        }
        // Notify renderer of the actual hotkey
        mainWindow?.webContents.send('hotkey-changed', key);
    }

    try {
        const success = globalShortcut.register(key, () => {
            console.log('[Main] Hotkey triggered');

            if (!isCurrentlyRecording) {
                // Capture native HWND FIRST (before our window steals focus)
                captureTargetWindow();

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

            // Show widget if hidden (user minimized to tray)
            if (mainWindow && !mainWindow.isVisible()) {
                mainWindow.show();
            }

            mainWindow?.webContents.send('toggle-recording');
        });

        if (success) console.log(`[Main] Hotkey registered: ${key}`);
        return success;
    } catch (err) {
        console.error(`[Main] Hotkey error:`, err);
        // If registration failed and we weren't already trying Alt+Space, try fallback
        if (key !== 'Alt+Space') {
            console.log('[Main] Falling back to Alt+Space');
            return registerHotkey('Alt+Space');
        }
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
            const text = await nativeWhisper.transcribe(audioBuffer, {
                language,
                onProgress: (percent: number) => {
                    mainWindow?.webContents.send('transcription-progress', percent);
                },
            });
            console.log(`[Main] Transcribed: "${text.substring(0, 80)}"`);
            mainWindow?.webContents.send('transcription-result', text);
            return { success: true, text };
        } catch (error: any) {
            console.error('[Main] Transcribe error:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('is-whisper-ready', () => isWhisperReady);

    // Engine management
    ipcMain.handle('get-engine-info', () => nativeWhisper.getEngineInfo());
    ipcMain.handle('set-transcription-engine', (_, engine: string) => {
        nativeWhisper.setTranscriptionEngine(engine as any);
        const settings = store.get('settings') as any || {};
        settings.transcriptionEngine = engine;
        store.set('settings', settings);
        return true;
    });
    ipcMain.handle('init-parakeet', async () => {
        return nativeWhisper.initParakeetEngine((percent, status) => {
            mainWindow?.webContents.send('whisper-progress', percent, status);
        });
    });

    ipcMain.handle('get-target-app', () => {
        const detected = inlineDetectActiveApp();
        if (detected) {
            targetAppBeforeRecording = detected;
            targetAppConfidence = 'confirmed';
            lastKnownFrontApp = { ...detected, timestamp: Date.now() };
            // Capture native HWND for fast paste (before our window steals focus)
            captureTargetWindow();
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
                    // Capture native HWND for fast paste
                    captureTargetWindow();
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
    ipcMain.handle('minimize-to-tray', () => {
        if (mainWindow) {
            mainWindow.hide();
            console.log('[Main] Widget hidden to tray');
        }
    });
    ipcMain.handle('set-window-size', (_, { width, height }: { width: number; height: number }) => {
        if (mainWindow) {
            // Use setBounds to resize, preserving current position
            // This is more reliable than setSize on Windows with transparent windows
            const [x, y] = mainWindow.getPosition();
            mainWindow.setBounds({ x, y, width, height }, true);
        }
    });

    // Permissions
    ipcMain.handle('request-mic-permission', async () => {
        if (process.platform === 'darwin') {
            const status = systemPreferences.getMediaAccessStatus('microphone');
            if (status === 'granted') return 'granted';
            const granted = await systemPreferences.askForMediaAccess('microphone');
            return granted ? 'granted' : 'denied';
        }
        return 'granted'; // Windows doesn't require explicit permission
    });

    ipcMain.handle('request-accessibility-permission', async () => {
        if (process.platform === 'darwin') {
            // Trigger System Events permission by running a quick AppleScript
            try {
                execSync(`osascript -e 'tell application "System Events" to return name of first application process whose frontmost is true'`,
                    { encoding: 'utf-8', timeout: 5000 });
                return 'granted';
            } catch {
                return 'denied';
            }
        }
        return 'granted';
    });

    // Setup complete — persist and start polling
    ipcMain.handle('setup-complete', () => {
        store.set('setupDone', true);
        if (!pollingInterval) {
            startActiveAppPolling();
        }
        return true;
    });

    // Check if setup was already completed on a previous launch
    ipcMain.handle('is-setup-done', () => {
        return !!store.get('setupDone');
    });

    // Platform detection for renderer
    ipcMain.handle('get-platform', () => process.platform);

    // Launch on Login
    ipcMain.handle('get-launch-on-login', () => {
        return app.getLoginItemSettings().openAtLogin;
    });
    ipcMain.handle('set-launch-on-login', (_, enabled: boolean) => {
        app.setLoginItemSettings({ openAtLogin: enabled });
        return true;
    });
}

// --- App Lifecycle ---
// app.dock?.hide() — removed: show in Dock like a normal app

// Set app name for dev mode (in production, electron-builder sets this)
app.setName('Clarity Scribe');

app.whenReady().then(async () => {
    createWindow();
    createTray();
    setupIpcHandlers();

    console.log('[Main] Initializing engines...');
    const sendStep = (id: string, label: string, percent: number, status: string) => {
        mainWindow?.webContents.send('setup-step-progress', { id, label, percent, status });
    };

    try {
        const settings = store.get('settings') as any || {};
        const savedLang = settings?.whisperLanguage || 'en';
        const needsWhisperNow = savedLang !== 'en';

        if (needsWhisperNow) {
            // Non-English language: load Whisper eagerly (it's the primary engine)
            sendStep('whisper', 'Whisper AI Model', 0, 'Preparing...');
            const ready = await nativeWhisper.initWhisper('turbo', (percent, status) => {
                console.log(`[Main] Whisper: ${status} (${percent}%)`);
                mainWindow?.webContents.send('whisper-progress', percent, status);
                sendStep('whisper', 'Whisper AI Model', percent, status);
            });
            isWhisperReady = ready;
            if (ready) {
                sendStep('whisper', 'Whisper AI Model', 100, 'Ready');
                mainWindow?.webContents.send('whisper-ready', { acceleration: nativeWhisper.getAccelerationInfo().type });
                console.log(`[Main] ✓ Whisper ready`);
            }
            nativeWhisper.setTranscriptionEngine('whisper' as any);
        } else {
            // English: skip Whisper GPU init — saves ~1.5GB VRAM
            // Whisper will lazy-load on first fallback if Parakeet fails
            sendStep('whisper', 'Whisper AI Model', 100, 'Deferred (Parakeet primary)');
            console.log(`[Main] Whisper deferred — Parakeet is primary engine for English`);
            isWhisperReady = true; // Parakeet is the primary engine, UI should be enabled
            // Signal ready immediately so the mic button enables while Parakeet loads
            mainWindow?.webContents.send('whisper-progress', 100, 'Ready');
            mainWindow?.webContents.send('whisper-ready', { acceleration: 'DirectML' });
        }

        // Step 2: VAD (needed by both engines)
        sendStep('vad', 'Voice Detection', 0, 'Downloading...');
        await nativeWhisper.initAudioSegmentation();
        sendStep('vad', 'Voice Detection', 100, 'Ready');
        console.log(`[Main] ✓ VAD ready`);

        // Step 3: Parakeet (for English — the default language)
        if (!needsWhisperNow) {
            nativeWhisper.setTranscriptionEngine('parakeet' as any);
            sendStep('parakeet', 'Parakeet Engine', 0, 'Downloading...');
            try {
                await nativeWhisper.initParakeetEngine((percent, status) => {
                    sendStep('parakeet', 'Parakeet Engine', percent, status);
                });
                sendStep('parakeet', 'Parakeet Engine', 100, 'Ready');
                console.log(`[Main] ✓ Parakeet ready`);
            } catch (e) {
                console.warn('[Main] Parakeet init failed, falling back to Whisper:', e);
                sendStep('parakeet', 'Parakeet Engine', 100, 'Skipped');
                // Lazy-load Whisper now since Parakeet failed
                sendStep('whisper', 'Whisper AI Model', 0, 'Loading (fallback)...');
                const ready = await nativeWhisper.initWhisper('turbo', (percent, status) => {
                    sendStep('whisper', 'Whisper AI Model', percent, status);
                });
                isWhisperReady = ready;
                nativeWhisper.setTranscriptionEngine('whisper' as any);
            }
        }

        // Signal overall completion
        mainWindow?.webContents.send('whisper-progress', 100, 'Ready');
        mainWindow?.webContents.send('whisper-ready', { acceleration: nativeWhisper.getAccelerationInfo().type });
    } catch (error) {
        console.error('[Main] Init error:', error);
    }

    registerHotkey((store.get('hotkey') as string) || 'Alt+Space');
    // If setup was already completed on a prior launch, start polling immediately
    if (store.get('setupDone') && !pollingInterval) {
        startActiveAppPolling();
    }

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
