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
    // Opt-in Inverse Text Normalization (spoken-form → written-form, e.g.
    // "two thirty pm" → "2:30 PM"). Default OFF; applied after cleanTranscription.
    itnEnabled: boolean;
    // Live transcription: transcribe speech segments while still recording so
    // stop→text is near-instant, with a live preview in the widget. Default ON.
    liveTranscription: boolean;
    // Audible cues on recording start/stop (subtle, generated — no assets).
    soundCues: boolean;
    // Spoken punctuation commands ("comma", "period", "new line", URL-aware
    // "dot", …) converted to symbols. Default OFF (opt-in, like ITN).
    spokenPunctuation: boolean;
    // Local API: loopback SSE event stream + record start/stop endpoints for
    // scripts/agents. Default OFF; takes effect on app restart.
    localApiEnabled: boolean;
    // Command mode: a second hotkey records a spoken COMMAND, routed by a
    // local LLM to an action (with confirmation gating). Default OFF.
    commandModeEnabled: boolean;
    commandHotkey: string;
}

/** One stage of a command-mode run, streamed from the main process. */
export interface CommandStageEvent {
    stage: 'listening' | 'routing' | 'proposal' | 'executing' | 'agent_step' | 'agent_confirm' | 'done' | 'clarify' | 'cancelled' | 'refused' | 'error';
    transcript?: string;
    tool?: string;
    description?: string;
    message?: string;
    detail?: string;
    question?: string;
    /** Why a proposal/refusal guardrail applied (risk rulebook). */
    reason?: string;
    /** Screen-agent progress (stage 'agent_step'). */
    step?: number;
    maxSteps?: number;
}

export interface HistoryEntry {
    id: string;
    text: string;
    timestamp: number;
    app: string;
    /** Recorded audio duration in ms. Optional — entries saved before v3.1 lack it. */
    audioMs?: number;
    /** Stop→pasted latency in ms (transcription + paste). Optional for the same reason. */
    latencyMs?: number;
    /** 'command' = spoken command (app holds the tool name); absent = dictation. */
    kind?: 'command';
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

    // Streaming transcription (transcribe-while-recording)
    streamStart: (sampleRate: number) => Promise<{ streaming: boolean }>;
    streamChunk: (chunk: Float32Array) => Promise<void>;
    streamAbort: () => Promise<void>;
    onTranscriptionPartial: (cb: (text: string) => void) => () => void;

    // Local API (programmable voice layer)
    getLocalApiInfo: () => Promise<{ enabled: boolean; running: boolean; port: number; token: string | null }>;

    // Command mode
    onCommandStage: (cb: (stage: CommandStageEvent) => void) => () => void;
    commandConfirm: (approved: boolean) => Promise<boolean>;
    agentStop: () => Promise<boolean>;
    getCommandStatus: () => Promise<{ enabled: boolean; available: boolean; running: boolean; modelPath: string | null; binaryPath: string | null; lastRouteMs: number | null; uiaAvailable?: boolean; vision?: { available: boolean; running: boolean; port: number | null; lastParseMs: number | null } }>;

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

