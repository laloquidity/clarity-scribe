/**
 * Type declarations for Clarity Scribe
 */

export interface Settings {
    hotkey: string;
    hotkeyMode: 'toggle' | 'hold';
    selectedMicId: string;
    whisperLanguage: string;
    silenceDuration: number;
    transcriptionEngine: 'auto' | 'whisper' | 'parakeet';
    personalDictionary: DictionaryEntry[];
}

export interface HistoryEntry {
    id: string;
    text: string;
    timestamp: number;
    app: string;
}

/**
 * Personal dictionary entry with "What was written" → "What you meant" mapping
 */
export interface DictionaryEntry {
    id: string;
    original: string;      // What was incorrectly written (e.g., "D-Bridge")
    replacement: string;   // What it should be (e.g., "deBridge")
    variants: string[];    // Auto-generated case/punctuation variants
    createdAt: number;     // Timestamp
}

/**
 * Generate regex-friendly variants for a word or phrase.
 * e.g., "neo bank" → ["NEO BANK", "neo-bank", "neobank", "Neo Bank", ...]
 * Handles multi-word phrases with mixed case combinations.
 */
export function generateVariants(original: string): string[] {
    const variants: string[] = [];
    const lower = original.toLowerCase();
    const upper = original.toUpperCase();
    const noHyphen = original.replace(/-/g, ' ');
    const noSpace = original.replace(/[\s-]/g, '');

    // Add common variations
    variants.push(lower);                         // "neo bank"
    variants.push(upper);                         // "NEO BANK"
    variants.push(original.replace(/-/g, ' '));   // hyphen → space
    variants.push(original.replace(/\s/g, '-'));  // space → hyphen
    variants.push(noSpace.toLowerCase());         // "neobank"
    variants.push(noSpace.toUpperCase());         // "NEOBANK"
    variants.push(noHyphen);                      // no hyphens

    // Title Case: "neo bank" → "Neo Bank"
    const titleCase = lower.replace(/\b\w/g, c => c.toUpperCase());
    variants.push(titleCase);

    // For multi-word phrases, add mixed case variants
    const words = lower.split(/[\s-]+/);
    if (words.length >= 2) {
        const separator = original.includes('-') ? '-' : ' ';

        // First word uppercase only: "NEO bank"
        const firstUpper = [words[0].toUpperCase(), ...words.slice(1)].join(separator);
        variants.push(firstUpper);

        // First word title case only: "Neo bank"
        const firstTitle = [words[0].charAt(0).toUpperCase() + words[0].slice(1), ...words.slice(1)].join(separator);
        variants.push(firstTitle);

        // Last word uppercase only: "neo BANK"
        const lastUpper = [...words.slice(0, -1), words[words.length - 1].toUpperCase()].join(separator);
        variants.push(lastUpper);

        // All uppercase except last: for 3+ words
        if (words.length >= 3) {
            const allButLastUpper = [...words.slice(0, -1).map(w => w.toUpperCase()), words[words.length - 1]].join(separator);
            variants.push(allButLastUpper);
        }
    }

    // Remove duplicates and the original
    return [...new Set(variants)].filter(v => v !== original);
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
    getHoldModeKeys: () => Promise<Array<{ value: string; label: string }>>;

    // Engine management
    getEngineInfo: () => Promise<{ whisper: string; parakeet: boolean; currentEngine: string }>;
    setTranscriptionEngine: (engine: string) => Promise<boolean>;
    initParakeet: () => Promise<boolean>;

    getHistory: () => Promise<HistoryEntry[]>;
    addHistory: (entry: HistoryEntry) => Promise<void>;
    clearHistory: () => Promise<void>;
    deleteHistory: (id: string) => Promise<void>;

    // Personal Dictionary
    getDictionary: () => Promise<DictionaryEntry[]>;
    saveDictionary: (dictionary: DictionaryEntry[]) => Promise<void>;

    quitApp: () => Promise<void>;
    minimizeToTray: () => Promise<void>;
    setWindowSize: (dims: { width: number; height: number }) => Promise<void>;

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

