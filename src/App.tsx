/**
 * Clarity Scribe — Main App Shell
 * 
 * Always-on-top widget with expandable history panel.
 * Push-to-talk: hold hotkey to record, release to stop.
 * Widget auto-hides when idle, appears during recording/processing.
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ChevronDown, ChevronUp, Settings } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import Widget from './components/Widget';
import HistoryPanel from './components/HistoryPanel';
import SettingsPanel from './components/SettingsPanel';
import SetupScreen from './components/SetupScreen';
import { useSettings } from './hooks/useSettings';
import { useAudioRecording } from './hooks/useAudioRecording';
import type { AppState, HistoryEntry } from './types';

const COLLAPSED_HEIGHT = 64;
const EXPANDED_HEIGHT = 460;
const SETUP_HEIGHT = 300;

const App: React.FC = () => {
    const [appState, setAppState] = useState<AppState>('IDLE');
    const [expanded, setExpanded] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [statusMessage, setStatusMessage] = useState<string | undefined>();
    const [history, setHistory] = useState<HistoryEntry[]>([]);
    const [whisperReady, setWhisperReady] = useState(false);
    const [whisperProgress, setWhisperProgress] = useState(0);
    const [whisperStatus, setWhisperStatus] = useState('Initializing...');
    const [copiedToast, setCopiedToast] = useState(false);
    const [setupDone, setSetupDone] = useState(false);
    const [keepVisible, setKeepVisible] = useState(false); // User explicitly showed via tray
    const [pttActivated, setPttActivated] = useState(false); // True after first PTT key-down

    const { settings, updateSetting, isLoaded } = useSettings();

    // Audio recording
    const { startRecording, stopRecording, isRecordingRef } = useAudioRecording({
        settings,
        onStateChange: setAppState,
        onError: (msg) => {
            setStatusMessage(msg);
            setTimeout(() => setStatusMessage(undefined), 3000);
        },
        skipSilenceDetection: true, // PTT handles stop via key release
    });

    // Toggle recording — called by mic button click (widget tap)
    // Uses widgetToggleRecording IPC to capture target app from cache
    // before Clarity Scribe's window steals focus
    const toggleRecordingFromWidget = useCallback(() => {
        window.electronAPI?.widgetToggleRecording();
    }, []);

    // The actual start/stop logic — called when main process sends toggle-recording (widget click)
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
        setPttActivated(true);
        setStatusMessage(undefined);
        startRecording();
    }, [startRecording, isRecordingRef]);

    // PTT stop — called when main process sends stop-recording (key up)
    const handleStopRecording = useCallback(() => {
        if (!isRecordingRef.current) return;
        stopRecording();
    }, [stopRecording, isRecordingRef]);

    // Load history on mount + check if setup was already completed
    useEffect(() => {
        window.electronAPI?.getHistory().then(h => setHistory(h || []));
        window.electronAPI?.isSetupDone().then(done => {
            if (done) setSetupDone(true);
        });
    }, []);

    // Listen for hotkey events (toggle, start, stop)
    useEffect(() => {
        const api = window.electronAPI;
        if (!api) return;

        const unsubToggle = api.onToggleRecording(() => {
            handleToggle();
        });

        // PTT events from key monitor
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

        const unsubResult = api.onTranscriptionResult(async (text) => {
            if (!text || text.trim().length === 0) {
                setAppState('IDLE');
                isRecordingRef.current = false;
                return;
            }

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

            setAppState('IDLE');
            isRecordingRef.current = false;

            // Auto-hide after feedback shown
            setTimeout(() => {
                setStatusMessage(undefined);
                if (!keepVisible) {
                    api.hideWindow();
                }
            }, 2000);
        });

        return () => { unsubResult?.(); };
    }, [keepVisible]);

    // Auto-hide when idle (after setup) — only after PTT has been used, and not kept visible by user
    useEffect(() => {
        const api = window.electronAPI;
        if (!api || !setupDone || !pttActivated) return;

        if (appState === 'IDLE' && !expanded && !showSettings && !statusMessage && !keepVisible) {
            api.hideWindow();
        }
    }, [appState, expanded, showSettings, statusMessage, setupDone, keepVisible, pttActivated]);

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
                    />
                </div>
                <div className="no-drag" style={{ display: 'flex', gap: 4, paddingRight: 12 }}>
                    <button
                        className="gear-btn"
                        onClick={() => {
                            setKeepVisible(true);
                            if (!expanded) setExpanded(true);
                            setShowSettings(!showSettings);
                        }}
                        title="Settings"
                    >
                        <Settings size={14} />
                    </button>
                    <button
                        className="expand-btn"
                        onClick={() => {
                            if (!expanded) {
                                setKeepVisible(true);
                                setShowSettings(false);
                            } else {
                                setKeepVisible(false);
                            }
                            setExpanded(!expanded);
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
                        {showSettings ? (
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
