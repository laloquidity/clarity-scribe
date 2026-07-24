/**
 * Clarity Scribe — Electron Main Process
 * 
 * Lightweight dictation app: global hotkey, Whisper transcription,
 * paste-to-target with clipboard restore, transcription history.
 */
import { app, BrowserWindow, globalShortcut, ipcMain, clipboard, shell, Tray, Menu, nativeImage, screen, powerMonitor, systemPreferences } from 'electron';
import { exec, execSync } from 'child_process';
import * as path from 'path';
import Store from 'electron-store';
import * as nativeWhisper from './nativeWhisper';
import * as streaming from './streamingTranscriber';
import { transcribeParakeet, setVocabularyBoostTerms } from './parakeetService';
import { startLocalApi, stopLocalApi, emitEvent, isRunning as isLocalApiRunning } from './localApi';
import { initWinPaste, focusAndPaste, isNativePasteAvailable, captureTargetWindow, getForegroundPid } from './winPaste';
import { initHotkeyService, registerHotkeyService, registerCommandHotkeyService, stopHotkeyService, HOLD_MODE_KEYS, type HotkeyMode } from './hotkeyService';
import * as llmRouter from './llmRouter';
import { runCommand, resolveConfirmation, awaitUserConfirmation, CommandStage } from './commandMode';
import type { CommandDeps } from './commandTools';
import * as visionSidecar from './visionSidecar';
import * as uiaProbe from './uiaProbe';
import { captureScreen, captureScreenRegion } from './screenCapture';
import * as input from './inputControl';
import { runAgentTask as runAgentLoop, Perception, AgentElement } from './agentLoop';
import { resolveApp } from './appLauncher';
import { findPlayButton, titleConfirmsPlayback, TREE_POLL_GAPS_MS } from './mediaControl';
import * as recipeStore from './recipeStore';
import { replayRecipe } from './recipePlayer';

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
    audioMs?: number;   // recorded audio duration
    latencyMs?: number; // stop→pasted (transcription + paste)
    kind?: 'command';   // spoken command (app = tool name); absent = dictation
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

// --- Command mode (voice → action) ---
// A second hotkey records a COMMAND instead of dictation: the transcript is
// routed by a local LLM (llmRouter) to a tool, gated by the capsule's
// confirmation UI for outward-facing actions, then executed.
let isCommandSession = false;

/** Well-known folder names → real paths for the open_target tool. */
function resolveKnownFolder(name: string): string | null {
    const n = name.toLowerCase();
    const map: Array<[RegExp, Parameters<typeof app.getPath>[0]]> = [
        [/download/, 'downloads'],
        [/document/, 'documents'],
        [/desktop/, 'desktop'],
        [/picture|photo/, 'pictures'],
        [/music/, 'music'],
        [/video|movie/, 'videos'],
        [/home folder|user folder/, 'home'],
    ];
    for (const [re, key] of map) {
        if (re.test(n)) {
            try { return app.getPath(key); } catch { return null; }
        }
    }
    return null;
}

// Abort handle for the currently running screen-agent task (Esc / Stop button).
let agentAbort: AbortController | null = null;

/**
 * Perception for the screen agent: ACCESSIBILITY TREE FIRST (uiaProbe, ~100ms,
 * exact rects + real names), OmniParser vision only when the tree is unusable
 * (games/canvas apps) — and then scoped to the window's own pixels, so the
 * model never sees the desktop around it. (UFO²-style hybrid, UIA wins.)
 */
async function agentPerceive(pinnedHwnd: number | null, signal?: AbortSignal): Promise<Perception> {
    const MIN_LABELED_CONTROLS = 3;
    const toElements = (d: uiaProbe.UiaDump): AgentElement[] => (d.elements ?? []).map(e => ({
        id: e.id, name: e.name, type: e.type, rect: e.rect,
        invoke: e.invoke || e.select, value: e.value,
    }));
    const labeledCount = (els: AgentElement[]) => els.filter(e => e.name.trim().length > 0 || e.value).length;

    // Follow the foreground window (pinnedHwnd is only a hint). This avoids
    // dumping a stale transient hwnd captured during app launch; the loop's
    // foreground-guard is what keeps physical actions safely scoped.
    let dump = await uiaProbe.dump(pinnedHwnd);
    if (!dump.ok || !dump.window) {
        dump = await uiaProbe.dump(null); // pinned/hint failed — use true foreground
    }
    let window = dump.ok && dump.window ? dump.window : null;
    let uiaElements = toElements(dump);

    // ACCESSIBILITY WARMUP: Chromium/Electron apps (Spotify, Discord, VS Code)
    // build their accessibility tree LAZILY once an assistive client asks —
    // measured on Spotify: 4 elements immediately after launch, 93 a few
    // seconds later. A single sparse dump is not evidence the app has no tree,
    // so retry with backoff before writing it off. This is what lets us drive
    // these apps natively instead of falling back to slow, imprecise vision.
    if (window && labeledCount(uiaElements) < MIN_LABELED_CONTROLS) {
        const target = window.hwnd;
        // Cumulative ≈5s — measured: Spotify needed ~4s from launch to a full
        // tree. Only paid when a real window looks sparse (the Chromium case),
        // and still far cheaper than a vision parse plus imprecise clicking.
        for (const wait of [400, 800, 1500, 2500]) {
            if (signal?.aborted) break;
            await new Promise(r => setTimeout(r, wait));
            const retry = await uiaProbe.dump(target);
            if (!retry.ok) continue;
            const els = toElements(retry);
            if (labeledCount(els) >= MIN_LABELED_CONTROLS) {
                console.log(`[Perceive] accessibility tree warmed after ${wait}ms (${els.length} controls)`);
                dump = retry;
                window = retry.window ?? window;
                uiaElements = els;
                break;
            }
        }
    }

    const uiaPerception: Perception = { source: 'uia', window, elements: uiaElements };

    // Accessibility tree is the truth whenever it's USEFUL. A Chromium/CEF app
    // (Spotify, Discord, Electron apps) exposes only a few UNNAMED caption
    // buttons — present but useless — so count LABELED controls, not raw ones.
    // Too few labeled controls on a real window ⇒ fall to vision. A sparse
    // desktop (no window) is NOT a vision trigger — the model should launch_app.
    // Vision must never be fatal: any failure degrades to the UIA passthrough.
    // Only after the warmup retries above have failed is a window genuinely
    // treeless (a game or custom-drawn canvas) and worth the vision cost.
    if (window === null || labeledCount(uiaElements) >= MIN_LABELED_CONTROLS) return uiaPerception;
    const visionWindow = window; // narrowed for the async block below

    try {
        if (!(await visionSidecar.ensureStarted())) return uiaPerception;
        const region = visionWindow.rect;
        const shot = await captureScreenRegion(region);
        const parsed = await visionSidecar.parseScreen(shot.pngBase64, signal);
        const [ox, oy] = [region[0], region[1]];
        const elements: AgentElement[] = parsed
            .filter(e => e.interactive || e.content)
            .map((e, i) => ({
                id: i,
                name: e.content,
                type: e.type || 'icon',
                rect: [
                    ox + e.bbox[0] * shot.width, oy + e.bbox[1] * shot.height,
                    ox + e.bbox[2] * shot.width, oy + e.bbox[3] * shot.height,
                ] as [number, number, number, number],
                invoke: false, // vision has no patterns — physical clicks only
                value: false,
            }));
        return elements.length ? { source: 'vision', window: visionWindow, elements } : uiaPerception;
    } catch (e: any) {
        if (signal?.aborted) throw e;
        console.warn(`[Agent] vision fallback failed (${e?.message || e}) — using UIA data`);
        return uiaPerception;
    }
}

/**
 * Press Play on the top search result of a media app (after a deep link put
 * it on the results page). Chromium builds its accessibility tree lazily and
 * only once an assistive client asks, so the first dump is the poke and we
 * poll for the tree to arrive. Returns what actually happened — never throws.
 */
async function playTopResult(appNameMatch: RegExp, query: string): Promise<{ played: boolean; title?: string }> {
    if (!uiaProbe.isAvailable()) return { played: false };
    let hwnd: number | null = null;

    for (const gap of TREE_POLL_GAPS_MS) {
        if (hwnd === null) {
            const wins = await uiaProbe.listWindows();
            hwnd = wins.find(w => appNameMatch.test(w.title))?.hwnd ?? null;
        }
        if (hwnd !== null) {
            // The dump doubles as the poke that enables Chromium accessibility;
            // the tree shows up on a LATER poll, not this one.
            const dump = await uiaProbe.dump(hwnd);
            if (!dump.ok) {
                hwnd = null;
            } else {
                const elements = (dump.elements ?? []).map(e => ({ id: e.id, name: e.name, type: e.type, invoke: e.invoke || e.select }));
                const playId = findPlayButton(elements, query);
                if (playId !== null) {
                    const r = await uiaProbe.invoke(playId);
                    if (r.ok) {
                        await delay(1200); // let the title update
                        const after = await uiaProbe.listWindows();
                        const title = after.find(w => w.hwnd === hwnd)?.title ?? '';
                        return { played: titleConfirmsPlayback(title, query), title };
                    }
                }
            }
        }
        await delay(gap);
    }
    return { played: false };
}

/**
 * "Learn once, replay fast": try a known recipe for this utterance.
 *
 * Returns handled:false both when nothing matched and when a recipe went
 * STALE (the app's UI changed under it) — the caller then falls through to
 * the agent. A stale recipe is counted, and after enough consecutive misses
 * it's quarantined so it stops costing time before every fallback.
 */
async function tryRecipe(utterance: string): Promise<{ handled: boolean; message?: string; detail?: string; note?: string }> {
    const match = recipeStore.findRecipe(utterance);
    if (!match) return { handled: false };
    const { recipe, slots } = match;

    const outcome = await replayRecipe(recipe, slots, {
        perceive: async () => {
            const dump = await uiaProbe.dump(null);
            if (!dump.ok || !dump.window) return null;
            return {
                elements: (dump.elements ?? []).map(e => ({
                    id: e.id, name: e.name, type: e.type,
                    invoke: e.invoke || e.select, value: e.value,
                })),
                windowTitle: dump.window.title,
            };
        },
        launchApp: (name) => commandDeps.launchApp(name),
        openUri: (uri) => shell.openExternal(uri),
        invokeElement: (id) => uiaProbe.invoke(id),
        setValue: (id, text) => uiaProbe.setValue(id, text),
        typeText: (text) => input.typeText(text),
        pressKeys: (keys) => input.pressKeys(keys),
        requestConfirm: async (description, reason) => {
            emitCommandStage({ stage: 'agent_confirm', description, reason });
            return awaitUserConfirmation(20_000);
        },
        onStep: (e) => emitCommandStage({
            stage: 'agent_step', step: e.index, maxSteps: e.total, description: e.description,
        }),
        delay,
        signal: agentAbort?.signal,
    });

    switch (outcome.status) {
        case 'done':
            recipeStore.recordSuccess(recipe.id);
            return {
                handled: true,
                message: recipe.describe,
                detail: outcome.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'),
                note: recipe.stopsBefore ? `stopped before ${recipe.stopsBefore}` : undefined,
            };
        case 'stale':
            // The app changed. Count it, say nothing to the user, and let the
            // agent solve it the slow way — that run can be recorded as a
            // fresh recipe, which supersedes this one.
            recipeStore.recordFailure(recipe.id);
            console.log(`[Recipes] "${recipe.id}" stale at step ${outcome.atStep}: ${outcome.reason} — falling back to the agent`);
            return { handled: false };
        case 'refused':
            return { handled: true, message: `Not doing that: ${outcome.reason}` };
        case 'cancelled':
            return { handled: true, message: `Cancelled — ${outcome.reason}` };
        case 'aborted':
            return { handled: true, message: 'Stopped by you' };
    }
}

const commandDeps: CommandDeps = {
    playTopResult,
    runAgentTask: async (goal) => {
        const none = { steps: [] as string[], stepsTaken: 0 };
        if (agentAbort) {
            return { ok: false, summary: 'An agent task is already running — say "stop" or press Esc first', ...none };
        }
        if (!input.isInputControlAvailable()) {
            return { ok: false, summary: 'The screen agent needs Windows native input (koffi unavailable)', ...none };
        }
        if (!uiaProbe.isAvailable()) {
            return { ok: false, summary: 'The screen agent needs uia-probe.exe (missing from this build)', ...none };
        }
        agentAbort = new AbortController();
        const abortRef = agentAbort;
        // TRUE kill switch: global Esc aborts even mid-parse/mid-decide.
        try { globalShortcut.register('Escape', () => { abortRef.abort(); resolveConfirmation(false); }); } catch { /* ignore */ }
        try {
            return await runAgentLoop(goal, {
                perceive: agentPerceive,
                decide: async (messages, tools, signal) => {
                    const r = await llmRouter.chatToolCall(messages, tools, { timeoutMs: 30_000, signal });
                    return { tool: r.tool, args: r.args as Record<string, any> };
                },
                act: {
                    invokeElement: (id) => uiaProbe.invoke(id),
                    setValue: (id, text) => uiaProbe.setValue(id, text),
                    focusElement: (id) => uiaProbe.focus(id),
                    clickAtScreen: input.clickAtScreen,
                    typeText: input.typeText,
                    pressKeys: input.pressKeys,
                    scrollWheel: input.scrollWheel,
                    launchApp: (name) => commandDeps.launchApp(name),
                    getForegroundPid: () => getForegroundPid(),
                    focusWindow: (hwnd) => input.focusWindow(hwnd),
                    findAppWindow: async (name) => {
                        // Match a launched app to its top-level window. Prefer
                        // the PROCESS NAME: a window's title is frequently not
                        // the app's name — Telegram shows the active chat, an
                        // editor shows the open file — so title-only matching
                        // silently fails to find windows we just launched.
                        const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
                        const q = norm(name.replace(/^(open|launch|start|the|a|my)\s+/i, ''));
                        if (!q) return null;
                        const wins = await uiaProbe.listWindows();
                        const self = mainWindow?.getTitle?.() ?? '';
                        const candidates = wins.filter(w => w.title !== self);
                        const byProc = candidates.find(w => {
                            const p = norm(w.proc || '');
                            return p && (p.includes(q) || q.includes(p));
                        });
                        if (byProc) return byProc.hwnd;
                        const byTitle = candidates.find(w => {
                            const t = norm(w.title);
                            return t.includes(q) || (q.length >= 4 && t.length >= 4 && q.includes(t));
                        });
                        return byTitle ? byTitle.hwnd : null;
                    },
                },
                requestConfirm: async (description, reason) => {
                    emitCommandStage({ stage: 'agent_confirm', description, reason });
                    return awaitUserConfirmation(20_000);
                },
                onStep: (e) => emitCommandStage({ stage: 'agent_step', ...e }),
                signal: agentAbort.signal,
            });
        } finally {
            try { globalShortcut.unregister('Escape'); } catch { /* ignore */ }
            agentAbort = null;
        }
    },
    typeText: async (text) => {
        const r = await pasteToTarget(text);
        return { success: r.success, app: r.app };
    },
    copyToClipboard: (text) => clipboard.writeText(text),
    openExternal: (url) => shell.openExternal(url),
    openPath: (p) => shell.openPath(p),
    launchApp: async (name) => {
        // Resolve real install paths (Start Menu shortcut / App Paths) instead
        // of `start "" "name"`, which fails for apps not on PATH (Spotify etc.)
        // and pops a "Windows cannot find" dialog the agent then fights.
        if (process.platform === 'win32') {
            const { target, via } = await resolveApp(name);
            console.log(`[Launch] "${name}" → ${via}: ${target}`);
            if (via === 'startmenu' || via === 'path' || via === 'apppaths') {
                const err = await shell.openPath(target);
                if (!err) return;
                console.warn(`[Launch] openPath failed (${err}) — shell fallback`);
            }
            await new Promise<void>((resolve) => exec(`start "" "${target.replace(/"/g, '')}"`, () => resolve()));
            return;
        }
        await new Promise<void>((resolve) => exec(`open -a "${name.replace(/"/g, '')}"`, () => resolve()));
    },
    resolveKnownFolder,
    getHistory: (limit) => getHistory().slice(0, limit).map(e => ({ text: e.text, timestamp: e.timestamp })),
};

function emitCommandStage(s: CommandStage): void {
    mainWindow?.webContents.send('command-stage', s);
    emitEvent({ type: 'command', ...s }); // mirror to the Local API stream
}

function isCommandModeEnabled(): boolean {
    const s = store.get('settings') as any;
    return s?.commandModeEnabled === true;
}

/** Register/unregister the command hotkey + warm the router per settings. */
function applyCommandModeSettings(): void {
    const s = store.get('settings') as any || {};
    if (s.commandModeEnabled === true) {
        // Default differs by platform: on macOS the F-keys are media keys, so
        // use a modifier combo (Alt = Option); on Windows an F-key is free.
        const defaultCommandHotkey = process.platform === 'darwin' ? 'Control+Alt+Space' : 'F10';
        registerCommandHotkeyService((s.commandHotkey as string) || defaultCommandHotkey);
        llmRouter.ensureStarted(); // warm the router in the background; non-blocking
        // Vision (OmniParser) is a multi-GB GPU model and only a FALLBACK for
        // apps with no accessibility tree — start it lazily on first need
        // (agentPerceive), not on every launch.
    } else {
        registerCommandHotkeyService(null);
        llmRouter.stop();
        visionSidecar.stop();
    }
}

/**
 * Feed Personal Dictionary "replacement" terms (what the user MEANT) into the
 * decoder's shallow-fusion vocabulary bias, so custom terms are recognized at
 * decode time instead of only string-replaced afterwards.
 */
function syncVocabularyBoost(): void {
    try {
        const raw = store.get('personalDictionary') as any[];
        const terms = Array.isArray(raw)
            ? raw.map(e => (typeof e === 'string' ? e : e?.replacement)).filter((t: any) => typeof t === 'string' && t.trim())
            : [];
        setVocabularyBoostTerms(terms);
    } catch (e) {
        console.warn('[Main] Vocabulary boost sync failed:', e);
    }
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
                    // Focus verification failed — the target window could not
                    // be brought foreground, so NO keystroke was sent. Don't
                    // blind-fire a PowerShell SendKeys at whatever IS focused;
                    // leave the transcription on the clipboard and say so.
                    console.warn('[Main] Native paste could not verify focus — leaving text on clipboard');
                    targetAppBeforeRecording = null;
                    return { success: false, fallback: 'clipboard', reason: 'focus-failed' };
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

        // Restore original clipboard — but NEVER clear: if the clipboard was
        // empty before, leave the transcription on it. If a paste ever lands
        // somewhere unexpected, the text stays one Ctrl+V away instead of
        // being destroyed (history is the other recovery path).
        if (hadOriginalContent) {
            clipboard.writeText(originalClipboard);
            console.log('[Main] Pasted to ' + targetApp.name + ', clipboard restored');
        } else {
            console.log('[Main] Pasted to ' + targetApp.name + ' (clipboard kept as safety net)');
        }

        targetAppBeforeRecording = null;
        return { success: true, app: targetApp.name };
    } catch (e) {
        // We report a clipboard fallback, so the clipboard must actually hold
        // the transcription (not the restored original).
        clipboard.writeText(text);
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
        backgroundColor: '#00000000',
        thickFrame: false,
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

/** Resolve a bundled resource on disk in both dev and packaged layouts. */
function getResourcePath(name: string): string {
    return app.isPackaged
        ? path.join(process.resourcesPath, name)
        : path.join(app.getAppPath(), 'resources', name);
}

function createTrayIcon(): Electron.NativeImage {
    // Use the real app logo everywhere. Previous implementation used a
    // hand-rolled 16px base64 blob on Windows (rendered as a garbled dot in
    // the hidden-icons tray) and an SVG buffer on macOS — which Electron's
    // nativeImage cannot decode at all, leaving the menu-bar icon BLANK.
    if (process.platform === 'win32') {
        // .ico carries proper 16/20/24/32px renditions for the tray.
        const icon = nativeImage.createFromPath(getResourcePath('icon.ico'));
        if (!icon.isEmpty()) return icon;
    } else {
        // macOS menu bar: the logo resized to menu-bar size (18pt; Electron
        // derives @2x from the source PNG for retina).
        const icon = nativeImage.createFromPath(getResourcePath('icon.png'));
        if (!icon.isEmpty()) return icon.resize({ width: 18, height: 18 });
    }
    // Fallback: minimal embedded 16x16 mic glyph (never leaves the tray empty).
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA' +
        'mklEQVQ4y2NgGAWkAEYo/R8KGCkxgJGBgYGFgYHhPxD/h2IWKA0D' +
        'LFANYIayQRgEQGwWqAYQzcy4DGCBagBhkCQLLgNYoGx0AxgpMYCF' +
        'Eg1gga0eBv4jNJBkACMKG90ARgYI+I+kgRFdA5BmhjqHBSTDDCAH' +
        'sECdw4JLAwuaH1gI+QGfBuwaWIgJJFwaWAgZQJIGfBoYKdGADwAA' +
        'GmwZEWhKgZkAAAAASUVORK5CYII=';
    return nativeImage.createFromBuffer(Buffer.from(pngBase64, 'base64'), { width: 16, height: 16 });
}

function createTray(): void {
    try {
        // macOS dev runs show the default Electron dock icon; point the dock
        // at the real logo (packaged builds get it from icon.icns).
        if (process.platform === 'darwin' && !app.isPackaged) {
            try {
                const dockIcon = nativeImage.createFromPath(getResourcePath('icon.png'));
                if (!dockIcon.isEmpty()) app.dock?.setIcon(dockIcon);
            } catch { /* cosmetic only */ }
        }
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

// --- Global Hotkey (via hotkeyService) ---
function captureTargetBeforeRecording(): void {
    captureTargetWindow();
    if (lastKnownFrontApp) {
        const cacheAge = Date.now() - lastKnownFrontApp.timestamp;
        targetAppBeforeRecording = lastKnownFrontApp;
        targetAppConfidence = cacheAge < getEffectiveCacheExpiry() ? 'cached' : 'stale';
    } else {
        targetAppBeforeRecording = null;
        targetAppConfidence = 'unknown';
    }
}

/**
 * Hotkey-stop retarget: the user pressed the stop hotkey while some app was
 * foreground — THAT app is where they expect the text, even if they switched
 * apps mid-recording (the start-time capture would be stale, and pasting into
 * it used to blind-fire Ctrl+V at the wrong window). Only hotkey stop paths
 * call this — the widget-click stop keeps the recording-start capture,
 * because clicking the widget focuses Scribe itself.
 *
 * Must be FAST (runs in the hotkey handler): the foreground pid comes from
 * direct FFI (µs). The human-readable app name is resolved from the poller
 * cache when it matches, else asynchronously — the paste itself targets the
 * HWND/pid, so a late name only affects the history label, never the paste.
 */
function retargetAtStop(): void {
    if (process.platform === 'win32') {
        const fgPid = getForegroundPid();
        if (fgPid && fgPid !== process.pid) {
            captureTargetWindow(); // fresh HWND — the actual paste destination
            const cachedName = lastKnownFrontApp?.pid === fgPid ? lastKnownFrontApp.name : null;
            if (targetAppBeforeRecording?.pid !== fgPid) {
                console.log(`[Main] Retargeted at stop: ${targetAppBeforeRecording?.name ?? 'none'} → pid ${fgPid}${cachedName ? ` (${cachedName})` : ''}`);
            }
            targetAppBeforeRecording = {
                name: cachedName ?? targetAppBeforeRecording?.name ?? 'app',
                pid: fgPid,
            };
            targetAppConfidence = 'confirmed';
            if (!cachedName) {
                // Resolve the real name off the hot path; update if still current.
                exec(`powershell -NoProfile -Command "(Get-Process -Id ${fgPid} -ErrorAction SilentlyContinue).ProcessName"`,
                    { timeout: 3000, windowsHide: true }, (err, stdout) => {
                        const name = stdout?.trim();
                        if (!err && name && targetAppBeforeRecording?.pid === fgPid) {
                            targetAppBeforeRecording = { ...targetAppBeforeRecording, name };
                        }
                    });
            }
            return;
        }
    } else if (lastKnownFrontApp && Date.now() - lastKnownFrontApp.timestamp < 3000
               && lastKnownFrontApp.pid !== targetAppBeforeRecording?.pid) {
        // macOS: no cheap synchronous foreground query — trust a fresh poller
        // cache entry (poller already excludes Scribe itself).
        console.log(`[Main] Retargeted at stop: ${targetAppBeforeRecording?.name ?? 'none'} → ${lastKnownFrontApp.name}`);
        targetAppBeforeRecording = lastKnownFrontApp;
        targetAppConfidence = 'confirmed';
        return;
    }
    // Foreground is us / detection unavailable — keep the start-time capture,
    // dropping it only if that process has since died.
    if (targetAppBeforeRecording && !isProcessAlive(targetAppBeforeRecording.pid)) {
        targetAppBeforeRecording = null;
    }
}

function setupHotkeyCallbacks(): void {
    initHotkeyService({
        // Toggle mode: single press toggles recording on/off
        onToggle: () => {
            console.log('[Main] Hotkey triggered (toggle)');
            if (!isCurrentlyRecording) {
                captureTargetBeforeRecording();
                isCurrentlyRecording = true;
                emitEvent({ type: 'state', state: 'RECORDING' });
            } else {
                // Hotkey stop: the app under the user's fingers RIGHT NOW is
                // where they want the text — retarget in case they switched
                // apps mid-recording (start-time capture would be stale).
                retargetAtStop();
                isCurrentlyRecording = false;
                emitEvent({ type: 'state', state: 'PROCESSING' });
            }
            mainWindow?.webContents.send('toggle-recording');
        },
        // Hold mode: key down starts recording
        onKeyDown: () => {
            console.log('[Main] PTT key down — start recording');
            if (isCurrentlyRecording) return;
            captureTargetBeforeRecording();
            isCurrentlyRecording = true;
            emitEvent({ type: 'state', state: 'RECORDING' });
            mainWindow?.webContents.send('start-recording');
        },
        // Hold mode: key up stops recording
        onKeyUp: () => {
            console.log('[Main] PTT key up — stop recording');
            if (!isCurrentlyRecording) return;
            retargetAtStop();
            isCurrentlyRecording = false;
            emitEvent({ type: 'state', state: 'PROCESSING' });
            mainWindow?.webContents.send('stop-recording');
        },
        // Command mode: second hotkey toggles a command-capture session that
        // reuses the whole recording pipeline; the transcript is routed to an
        // action instead of being pasted.
        onCommandToggle: () => {
            if (!isCommandModeEnabled()) return;
            if (!isCurrentlyRecording) {
                console.log('[Main] Command hotkey — start command capture');
                captureTargetBeforeRecording(); // type_text targets the current app
                isCurrentlyRecording = true;
                isCommandSession = true;
                emitEvent({ type: 'state', state: 'RECORDING' });
                emitCommandStage({ stage: 'listening' });
                llmRouter.ensureStarted(); // warm while the user is speaking
                mainWindow?.webContents.send('start-recording');
            } else if (isCommandSession) {
                console.log('[Main] Command hotkey — stop command capture');
                retargetAtStop();
                isCurrentlyRecording = false;
                emitEvent({ type: 'state', state: 'PROCESSING' });
                mainWindow?.webContents.send('stop-recording');
            }
            // Recording a normal dictation → the command hotkey does nothing.
        },
    });
}

function registerHotkey(key: string, mode?: HotkeyMode): boolean {
    const resolvedMode = mode || (store.get('settings') as any)?.hotkeyMode || 'toggle';
    return registerHotkeyService(key, resolvedMode);
}

/**
 * Route a command transcript through the orchestrator (fire-and-forget from
 * the transcribe handler's perspective) and log successful actions to history.
 */
function dispatchCommand(transcript: string): { success: boolean; command: true } {
    isCommandSession = false;
    runCommand(transcript, {
        route: llmRouter.route,
        deps: commandDeps,
        emit: emitCommandStage,
        tryRecipe,
    }).then((end) => {
        emitEvent({ type: 'state', state: 'IDLE' });
        if (end.stage === 'done') {
            addHistoryEntry({
                id: Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
                text: transcript,
                timestamp: Date.now(),
                app: end.tool,
                kind: 'command',
            });
        }
    }).catch((e) => {
        // runCommand never throws by contract; belt-and-braces.
        console.error('[Main] Command dispatch error:', e);
        emitCommandStage({ stage: 'error', message: String(e?.message || e) });
        emitEvent({ type: 'state', state: 'IDLE' });
    });
    return { success: true, command: true };
}

// --- IPC Handlers ---
function setupIpcHandlers(): void {
    ipcMain.handle('transcribe', async (_, audioData: Float32Array | number[], sampleRate: number) => {
        if (!isWhisperReady) return { success: false, error: 'Whisper not ready' };
        try {
            const audioBuffer = audioData instanceof Float32Array ? audioData : new Float32Array(audioData);

            // Streaming-first: if a live session transcribed segments during
            // recording, its finalize only has the tail left — near-instant.
            // Unhealthy or empty results fall through to the classic batch path
            // (full buffer, includes Whisper fallback + hallucination guards).
            if (streaming.isSessionActive()) {
                const t0 = Date.now();
                const result = await streaming.finalizeSession();
                if (result.healthy && result.text) {
                    console.log(`[Main] Streamed transcription finalized in ${Date.now() - t0}ms (${result.segments} segments): "${result.text.substring(0, 80)}"`);
                    if (isCommandSession) return dispatchCommand(result.text);
                    mainWindow?.webContents.send('transcription-result', result.text);
                    emitEvent({ type: 'result', text: result.text });
                    emitEvent({ type: 'state', state: 'IDLE' });
                    return { success: true, text: result.text };
                }
                console.log(`[Main] Streaming session ${result.healthy ? 'empty' : 'unhealthy'} — falling back to batch transcription`);
            }

            const settings = store.get('settings') as any;
            const language = settings?.whisperLanguage || 'en';
            const text = await nativeWhisper.transcribe(audioBuffer, {
                language,
                onProgress: (percent: number) => {
                    mainWindow?.webContents.send('transcription-progress', percent);
                },
            });
            console.log(`[Main] Transcribed: "${text.substring(0, 80)}"`);
            if (isCommandSession) return dispatchCommand(text);
            mainWindow?.webContents.send('transcription-result', text);
            emitEvent({ type: 'result', text });
            emitEvent({ type: 'state', state: 'IDLE' });
            return { success: true, text };
        } catch (error: any) {
            console.error('[Main] Transcribe error:', error);
            if (isCommandSession) {
                isCommandSession = false;
                emitCommandStage({ stage: 'error', message: error.message || 'Transcription failed' });
                emitEvent({ type: 'state', state: 'IDLE' });
            }
            return { success: false, error: error.message };
        }
    });

    // --- Streaming transcription (transcribe-while-recording) ---
    // Renderer streams raw audio chunks during recording; segments transcribe
    // at natural pauses so stop→text is just the tail. Parakeet engine only.
    ipcMain.handle('stream-start', (_, sampleRate: number) => {
        const engineInfo = nativeWhisper.getEngineInfo();
        if (engineInfo.currentEngine !== 'parakeet' || !engineInfo.parakeet) {
            return { streaming: false };
        }
        const started = streaming.startSession(sampleRate);
        return { streaming: started };
    });
    ipcMain.handle('stream-chunk', (_, chunk: Float32Array | number[]) => {
        streaming.pushChunk(chunk instanceof Float32Array ? chunk : new Float32Array(chunk));
    });
    ipcMain.handle('stream-abort', () => { streaming.abortSession(); });

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
        const s = store.get('settings') as any || {};
        nativeWhisper.setCoreMLEnabled(s.coreMLEnabled !== false); // default on (Apple Silicon)
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
        if (settings.hotkey) registerHotkey(settings.hotkey, settings.hotkeyMode);
        applyCommandModeSettings(); // command hotkey + router lifecycle
    });
    ipcMain.handle('get-hotkey', () => store.get('hotkey') || 'Alt+Space');
    ipcMain.handle('set-hotkey', (_, key) => { store.set('hotkey', key); return registerHotkey(key); });
    ipcMain.handle('get-hold-mode-keys', () => HOLD_MODE_KEYS);

    // History
    ipcMain.handle('get-history', () => getHistory());
    ipcMain.handle('add-history', (_, entry: HistoryEntry) => addHistoryEntry(entry));
    ipcMain.handle('clear-history', () => clearHistory());
    ipcMain.handle('delete-history-entry', (_, id: string) => deleteHistoryEntry(id));

    // Personal Dictionary
    ipcMain.handle('get-dictionary', () => {
        const raw = store.get('personalDictionary') as any;
        if (!raw) return [];
        // Migration guard: convert old string[] format to DictionaryEntry[]
        if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'string') {
            const migrated = (raw as string[]).map((word: string) => ({
                id: `migrated-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
                original: word,
                replacement: word,
                variants: [],
                createdAt: Date.now(),
            }));
            store.set('personalDictionary', migrated);
            return migrated;
        }
        return raw;
    });
    ipcMain.handle('save-dictionary', (_, dictionary: any[]) => {
        store.set('personalDictionary', dictionary);
        syncVocabularyBoost();
    });

    // --- Command mode ---
    ipcMain.handle('command-confirm', (_, approved: boolean) => resolveConfirmation(!!approved));
    // Stop button / Esc during an agent task: abort the loop AND decline any
    // pending mid-task confirmation so nothing stays blocked.
    ipcMain.handle('agent-stop', () => {
        agentAbort?.abort();
        resolveConfirmation(false);
        return agentAbort !== null;
    });
    ipcMain.handle('get-command-status', () => ({
        enabled: isCommandModeEnabled(),
        ...llmRouter.getStatus(),
        vision: visionSidecar.getStatus(),
        uiaAvailable: uiaProbe.isAvailable(),
    }));

    // Local API info for the settings UI (token shown so users can wire tools).
    ipcMain.handle('get-local-api-info', () => {
        const s = store.get('settings') as any || {};
        return {
            enabled: s.localApiEnabled === true,
            running: isLocalApiRunning(),
            port: (s.localApiPort as number) || 5111,
            token: (store.get('localApiToken') as string) || null,
        };
    });

    // Window
    ipcMain.handle('quit-app', () => { (app as any).isQuitting = true; app.quit(); });
    ipcMain.handle('minimize-to-tray', () => {
        if (mainWindow) {
            mainWindow.minimize();
            console.log('[Main] Widget minimized');
        }
    });
    ipcMain.handle('set-window-size', (_, { width, height }: { width: number; height: number }) => {
        if (mainWindow) {
            // Use setBounds to resize, preserving current position
            // This is more reliable than setSize on Windows with transparent windows.
            // macOS refuses programmatic resizes on a resizable:false window, so
            // briefly lift the flag around the resize (no-op on Windows).
            const [x, y] = mainWindow.getPosition();
            const wasResizable = mainWindow.isResizable();
            if (!wasResizable) mainWindow.setResizable(true);
            mainWindow.setBounds({ x, y, width, height }, true);
            if (!wasResizable) mainWindow.setResizable(false);
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
            const pkSettings = store.get('settings') as any || {};
            nativeWhisper.setCoreMLEnabled(pkSettings.coreMLEnabled !== false); // default on (Apple Silicon)
            nativeWhisper.setTranscriptionEngine('parakeet' as any);
            sendStep('parakeet', 'Parakeet Engine', 0, 'Downloading...');
            try {
                await nativeWhisper.initParakeetEngine((percent, status) => {
                    sendStep('parakeet', 'Parakeet Engine', percent, status);
                });
                sendStep('parakeet', 'Parakeet Engine', 100, 'Ready');
                console.log(`[Main] ✓ Parakeet ready`);

                // Enable transcribe-while-recording: segments (≤28s, cut at
                // pauses) go straight through the Parakeet single-pass path.
                streaming.configureStreaming((audio16k) => transcribeParakeet(audio16k));
                streaming.onPartial((text) => {
                    mainWindow?.webContents.send('transcription-partial', text);
                    emitEvent({ type: 'partial', text });
                });
                console.log('[Main] ✓ Live streaming transcription enabled');

                // Decoder-level custom vocabulary from the Personal Dictionary
                syncVocabularyBoost();
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

    // --- Local API (programmable voice layer) ---
    // Opt-in loopback control server: SSE event stream of live transcription
    // plus start/stop endpoints. The integration seam for agent workflows.
    {
        const s = store.get('settings') as any || {};
        if (s.localApiEnabled === true) { // default OFF
            startLocalApi({
                port: (s.localApiPort as number) || 5111,
                getToken: () => (store.get('localApiToken') as string) || null,
                setToken: (t) => store.set('localApiToken', t),
                startRecording: () => {
                    if (isCurrentlyRecording) return false;
                    captureTargetBeforeRecording();
                    isCurrentlyRecording = true;
                    emitEvent({ type: 'state', state: 'RECORDING' });
                    mainWindow?.webContents.send('start-recording');
                    return true;
                },
                stopRecording: () => {
                    if (!isCurrentlyRecording) return false;
                    retargetAtStop();
                    isCurrentlyRecording = false;
                    emitEvent({ type: 'state', state: 'PROCESSING' });
                    mainWindow?.webContents.send('stop-recording');
                    return true;
                },
                getStatus: () => ({
                    recording: isCurrentlyRecording,
                    engine: nativeWhisper.getEngineInfo().currentEngine,
                    version: app.getVersion(),
                }),
                getHistory: (limit) => getHistory().slice(0, limit),
                // Text-command entry point for agents: same pipeline as speech.
                runCommand: (text) => {
                    if (!isCommandModeEnabled()) return Promise.resolve({ stage: 'error', message: 'Command mode is disabled' });
                    return runCommand(text, { route: llmRouter.route, deps: commandDeps, emit: emitCommandStage, tryRecipe });
                },
            })
                .then(({ port }) => console.log(`[LocalAPI] listening on 127.0.0.1:${port}`))
                .catch((err) => console.error('[LocalAPI] failed to start:', err));
        }
    }

    setupHotkeyCallbacks();
    recipeStore.loadRecipes(app.getPath('userData')); // builtin pack + learned
    applyCommandModeSettings(); // command hotkey + router (if enabled)
    const savedSettings = store.get('settings') as any;
    registerHotkey(
        (store.get('hotkey') as string) || savedSettings?.hotkey || 'Alt+Space',
        savedSettings?.hotkeyMode || 'toggle'
    );
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
    if (isLocalApiRunning()) stopLocalApi();
    llmRouter.stop();
    visionSidecar.stop();
    uiaProbe.stop();
    stopHotkeyService();
    if (pollingInterval) clearInterval(pollingInterval);
    nativeWhisper.cleanup();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
