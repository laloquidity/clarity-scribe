/**
 * Clarity Scribe — Main App Shell
 * 
 * Always-on-top widget with expandable history panel.
 * Global hotkey toggles recording, transcription gets pasted to the active app.
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ChevronDown, ChevronUp, Settings, Minus, Book } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import Widget from './components/Widget';
import HistoryPanel from './components/HistoryPanel';
import SettingsPanel from './components/SettingsPanel';
import { PersonalDictionary } from './components/PersonalDictionary';
import SetupScreen from './components/SetupScreen';
import { useSettings } from './hooks/useSettings';
import { useAudioRecording } from './hooks/useAudioRecording';
import { cleanTranscription } from './utils/cleanTranscription';
import type { AppState, HistoryEntry, DictionaryEntry } from './types';

const COLLAPSED_HEIGHT = 64;
const EXPANDED_HEIGHT = 460;
const SETUP_HEIGHT = 300;

const App: React.FC = () => {
    const [appState, setAppState] = useState<AppState>('IDLE');
    const [expanded, setExpanded] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [showDictionary, setShowDictionary] = useState(false);
    const [statusMessage, setStatusMessage] = useState<string | undefined>();
    const [history, setHistory] = useState<HistoryEntry[]>([]);
    const [whisperReady, setWhisperReady] = useState(false);
    const [whisperProgress, setWhisperProgress] = useState(0);
    const [whisperStatus, setWhisperStatus] = useState('Initializing...');
    const [copiedToast, setCopiedToast] = useState(false);
    const [setupDone, setSetupDone] = useState(false);
    const [personalDictionary, setPersonalDictionary] = useState<DictionaryEntry[]>([]);

    // Keep a ref to dictionary for use in the transcription callback (avoids stale closure)
    const dictionaryRef = useRef<DictionaryEntry[]>([]);
    useEffect(() => { dictionaryRef.current = personalDictionary; }, [personalDictionary]);

    const { settings, updateSetting, isLoaded } = useSettings();

    // Audio recording — disable silence detection in hold-to-talk mode
    const { startRecording, stopRecording, isRecordingRef } = useAudioRecording({
        settings,
        onStateChange: setAppState,
        onError: (msg) => {
            setStatusMessage(msg);
            setTimeout(() => setStatusMessage(undefined), 5000);
        },
        skipSilenceDetection: settings.hotkeyMode === 'hold',
    });

    // Toggle recording — called by mic button click
    // Uses widgetToggleRecording IPC to capture target app from cache
    // before Clarity Scribe's window steals focus
    const toggleRecordingFromWidget = useCallback(() => {
        // Tell main process to capture target app and toggle state
        window.electronAPI?.widgetToggleRecording();
    }, []);

    // The actual start/stop logic — called when main process sends toggle-recording
    const handleToggle = useCallback(() => {
        if (isRecordingRef.current) {
            stopRecording();
        } else {
            setStatusMessage(undefined);
            startRecording();
        }
    }, [startRecording, stopRecording, isRecordingRef]);

    // PTT start — called when main process sends start-recording (key down)
    const handleStartRecording = useCallback(() => {
        if (isRecordingRef.current) return;
        setStatusMessage(undefined);
        startRecording();
    }, [startRecording, isRecordingRef]);

    // PTT stop — called when main process sends stop-recording (key up)
    const handleStopRecording = useCallback(() => {
        if (!isRecordingRef.current) return;
        stopRecording();
    }, [stopRecording, isRecordingRef]);

    // Load history + dictionary on mount + check if setup was already completed
    useEffect(() => {
        window.electronAPI?.getHistory().then(h => setHistory(h || []));
        window.electronAPI?.getDictionary?.().then(d => setPersonalDictionary(d || []));
        window.electronAPI?.isSetupDone().then(done => {
            if (done) setSetupDone(true);
        });
        // Catch the case where whisper-ready fired before React registered its listener.
        // The IPC event is a one-shot broadcast emitted during app startup — if the
        // renderer wasn't mounted yet, the event is lost. Polling here recovers from that.
        window.electronAPI?.isWhisperReady().then(ready => {
            if (ready) {
                setWhisperReady(true);
                setWhisperProgress(100);
                setWhisperStatus('Ready');
            }
        });
    }, []);

    // Save dictionary when it changes (debounced via the effect)
    const dictionarySaveTimerRef = useRef<number | null>(null);
    useEffect(() => {
        // Skip saving on initial load (empty array)
        if (!isLoaded) return;
        if (dictionarySaveTimerRef.current) clearTimeout(dictionarySaveTimerRef.current);
        dictionarySaveTimerRef.current = window.setTimeout(() => {
            window.electronAPI?.saveDictionary?.(personalDictionary);
        }, 500);
        return () => { if (dictionarySaveTimerRef.current) clearTimeout(dictionarySaveTimerRef.current); };
    }, [personalDictionary, isLoaded]);

    // Listen for hotkey events (toggle, start, stop)
    useEffect(() => {
        const api = window.electronAPI;
        if (!api) return;

        const unsubToggle = api.onToggleRecording(() => {
            handleToggle();
        });

        // PTT events from hold mode
        const unsubStart = api.onStartRecording(() => {
            handleStartRecording();
        });

        const unsubStop = api.onStopRecording(() => {
            handleStopRecording();
        });

        // If main process falls back to a different hotkey, sync the UI
        const unsubHotkey = api.onHotkeyChanged?.((key: string) => {
            updateSetting('hotkey', key);
        });

        return () => { unsubToggle?.(); unsubStart?.(); unsubStop?.(); unsubHotkey?.(); };
    }, [handleToggle, handleStartRecording, handleStopRecording, updateSetting]);

    // Listen for Whisper events
    useEffect(() => {
        const api = window.electronAPI;
        if (!api) return;

        const unsubReady = api.onWhisperReady((info) => {
            setWhisperReady(true);
            setWhisperProgress(100);
            setWhisperStatus('Ready');
        });

        const unsubProgress = api.onWhisperProgress((p, m) => {
            setWhisperProgress(p);
            setWhisperStatus(m);
        });

        return () => { unsubReady?.(); unsubProgress?.(); };
    }, []);

    // Listen for transcription results
    useEffect(() => {
        const api = window.electronAPI;
        if (!api) return;

        const unsubResult = api.onTranscriptionResult(async (rawText) => {
            if (!rawText || rawText.trim().length === 0) {
                setAppState('IDLE');
                isRecordingRef.current = false;
                return;
            }

            // Post-processing: remove filler words, stutters, apply dictionary, and clean up
            let text = cleanTranscription(rawText, dictionaryRef.current);

            if (!text || text.trim().length === 0) {
                setAppState('IDLE');
                isRecordingRef.current = false;
                return;
            }

            // Guard: reject transcriptions that are only punctuation (no actual words)
            // Parakeet can emit lone periods/commas from silence or background noise
            if (!/[a-zA-Z0-9]/.test(text)) {
                setAppState('IDLE');
                isRecordingRef.current = false;
                return;
            }

            // Add trailing space so consecutive transcriptions read naturally
            text = text.trimEnd() + ' ';

            // Paste to target app
            const result = await api.pasteToTarget(text);
            const didPaste = result.success;
            const targetAppName = result.app || (result.fallback === 'clipboard' ? 'clipboard' : 'unknown');

            // Add to history
            const entry: HistoryEntry = {
                id: Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
                text: text.trim(),
                timestamp: Date.now(),
                app: targetAppName,
            };
            await api.addHistory(entry);
            setHistory(prev => [entry, ...prev]);

            // Show accurate feedback
            setStatusMessage(didPaste ? `Pasted → ${targetAppName} ✓` : 'Copied ✓');
            setTimeout(() => setStatusMessage(undefined), 2000);

            setAppState('IDLE');
            isRecordingRef.current = false;
        });

        return () => { unsubResult?.(); };
    }, []);

    // Resize window based on state
    useEffect(() => {
        const api = window.electronAPI;
        if (!api) return;

        let height = COLLAPSED_HEIGHT;
        if (!setupDone) {
            height = SETUP_HEIGHT;
        } else if (expanded) {
            height = EXPANDED_HEIGHT;
        }

        api.setWindowSize({ width: 340, height });
    }, [expanded, setupDone]);

    // Copy entry to clipboard
    const handleCopyEntry = useCallback((text: string) => {
        window.electronAPI?.copyToClipboard(text);
        setCopiedToast(true);
        setTimeout(() => setCopiedToast(false), 1500);
    }, []);

    // Delete single entry
    const handleDeleteEntry = useCallback((id: string) => {
        window.electronAPI?.deleteHistory(id);
        setHistory(prev => prev.filter(e => e.id !== id));
    }, []);

    // Clear history
    const handleClearHistory = useCallback(() => {
        window.electronAPI?.clearHistory();
        setHistory([]);
    }, []);

    // Dictionary update handler
    const handleDictionaryUpdate = useCallback((updated: DictionaryEntry[]) => {
        setPersonalDictionary(updated);
    }, []);

    if (!isLoaded) {
        return <div className="widget-shell" />;
    }

    // First-run setup screen (model download + permissions)
    if (!setupDone) {
        return (
            <div className="widget-shell">
                <SetupScreen
                    progress={whisperProgress}
                    status={whisperStatus}
                    onSetupComplete={() => setSetupDone(true)}
                />
            </div>
        );
    }

    return (
        <div className={`widget-shell ${appState === 'RECORDING' ? 'recording' : ''}`} style={{ position: 'relative' }}>
            {/* Widget bar */}
            <div style={{ display: 'flex', alignItems: 'center' }}>
                <div style={{ flex: 1 }}>
                    <Widget
                        appState={appState}
                        onToggleRecording={toggleRecordingFromWidget}
                        statusMessage={statusMessage}
                        whisperReady={whisperReady}
                        whisperProgress={whisperProgress}
                        whisperStatus={whisperStatus}
                        hotkey={settings.hotkey}
                        hotkeyMode={settings.hotkeyMode}
                    />
                </div>
                <div className="no-drag" style={{ display: 'flex', gap: 4, paddingRight: 12 }}>
                    <button
                        className="minimize-btn"
                        onClick={() => window.electronAPI?.minimizeToTray?.()}
                        title="Minimize"
                    >
                        <Minus size={14} />
                    </button>
                    <button
                        className={`gear-btn ${showDictionary ? 'active' : ''}`}
                        onClick={() => {
                            if (!expanded) setExpanded(true);
                            if (showDictionary) {
                                // Already showing dictionary — close it
                                setShowDictionary(false);
                            } else {
                                // Open dictionary, close settings
                                setShowSettings(false);
                                setShowDictionary(true);
                            }
                        }}
                        title="Personal Dictionary"
                    >
                        <Book size={14} />
                    </button>
                    <button
                        className="gear-btn"
                        onClick={() => {
                            if (!expanded) setExpanded(true);
                            if (showSettings) {
                                setShowSettings(false);
                            } else {
                                setShowDictionary(false);
                                setShowSettings(true);
                            }
                        }}
                        title="Settings"
                    >
                        <Settings size={14} />
                    </button>
                    <button
                        className="expand-btn"
                        onClick={() => {
                            setExpanded(!expanded);
                            if (!expanded) {
                                setShowSettings(false);
                                setShowDictionary(false);
                            }
                        }}
                        title={expanded ? 'Collapse' : 'Expand history'}
                    >
                        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    </button>
                </div>
            </div>

            {/* Expandable area */}
            <AnimatePresence>
                {expanded && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.15 }}
                        style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
                    >
                        {showDictionary ? (
                            <PersonalDictionary
                                isOpen={showDictionary}
                                onClose={() => setShowDictionary(false)}
                                dictionary={personalDictionary}
                                onUpdate={handleDictionaryUpdate}
                            />
                        ) : showSettings ? (
                            <SettingsPanel
                                settings={settings}
                                onUpdateSetting={updateSetting}
                                onClose={() => setShowSettings(false)}
                            />
                        ) : (
                            <HistoryPanel
                                entries={history}
                                onCopy={handleCopyEntry}
                                onDelete={handleDeleteEntry}
                                onClear={handleClearHistory}
                            />
                        )}
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Copied toast */}
            <AnimatePresence>
                {copiedToast && (
                    <motion.div
                        className="copied-toast"
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 10 }}
                    >
                        Copied to clipboard
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

export default App;
