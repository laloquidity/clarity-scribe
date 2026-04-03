/**
 * Type declarations for Clarity Scribe
 */

export interface Settings {
    hotkey: string;
    selectedMicId: string;
    whisperLanguage: string;
    silenceDuration: number;
    transcriptionEngine: 'auto' | 'whisper' | 'parakeet';
}

export interface HistoryEntry {
    id: string;
    text: string;
    timestamp: number;
    app: string;
}

export type AppState = 'IDLE' | 'RECORDING' | 'PROCESSING' | 'ERROR';

// Electron API exposed via preload
export interface ElectronAPI {
    transcribe: (audio: Float32Array, sampleRate: number) => Promise<any>;
    isWhisperReady: () => Promise<boolean>;
    copyToClipboard: (text: string) => Promise<boolean>;

    onWhisperReady: (cb: (info?: { acceleration: string }) => void) => () => void;
    onWhisperProgress: (cb: (p: number, m: string) => void) => () => void;
    onTranscriptionResult: (cb: (text: string) => void) => () => void;
    onTranscriptionProgress: (cb: (percent: number) => void) => () => void;
    onSetupStepProgress: (cb: (step: { id: string; label: string; percent: number; status: string }) => void) => () => void;
    onToggleRecording: (cb: () => void) => () => void;
    onStartRecording: (cb: () => void) => () => void;
    onStopRecording: (cb: () => void) => () => void;

    getTargetApp: () => Promise<{ targetApp: { name: string; pid: number } | null; confidence: string }>;
    clearTargetApp: () => Promise<void>;
    pasteToTarget: (text: string) => Promise<{ success: boolean; fallback?: string; app?: string }>;

    // Widget mic button — captures target from cache before focus steal
    widgetToggleRecording: () => Promise<{ success: boolean }>;

    getSettings: () => Promise<Partial<Settings>>;
    saveSettings: (settings: Settings) => Promise<void>;
    getHotkey: () => Promise<string>;
    setHotkey: (key: string) => Promise<boolean>;
    onHotkeyChanged: (cb: (key: string) => void) => () => void;
    getKeyCodeMap: () => Promise<Array<{ id: string; label: string }>>;

    // Engine management
    getEngineInfo: () => Promise<{ whisper: string; parakeet: boolean; currentEngine: string }>;
    setTranscriptionEngine: (engine: string) => Promise<boolean>;
    initParakeet: () => Promise<boolean>;

    getHistory: () => Promise<HistoryEntry[]>;
    addHistory: (entry: HistoryEntry) => Promise<void>;
    clearHistory: () => Promise<void>;
    deleteHistory: (id: string) => Promise<void>;

    quitApp: () => Promise<void>;
    setWindowSize: (dims: { width: number; height: number }) => Promise<void>;
    hideWindow: () => Promise<void>;
    showWindow: () => Promise<void>;

    // Permissions & Setup
    requestMicPermission: () => Promise<string>;
    requestAccessibilityPermission: () => Promise<string>;
    setupComplete: () => Promise<boolean>;
    isSetupDone: () => Promise<boolean>;

    // Launch on Login
    getLaunchOnLogin: () => Promise<boolean>;
    setLaunchOnLogin: (enabled: boolean) => Promise<boolean>;

    // Platform
    getPlatform: () => Promise<string>;
}

declare global {
    interface Window {
        electronAPI?: ElectronAPI;
    }
}
