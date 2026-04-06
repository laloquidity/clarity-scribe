import React, { useState, useEffect } from 'react';
import { Mic, Square, Check, GripVertical } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import type { AppState } from '../types';

interface WidgetProps {
    appState: AppState;
    onToggleRecording: () => void;
    statusMessage?: string;
    whisperReady: boolean;
    whisperProgress: number;
    whisperStatus: string;
    hotkey?: string;
    hotkeyMode?: 'toggle' | 'hold';
}

const Waveform = () => (
    <div className="waveform">
        {[0.4, 0.7, 1, 0.6, 0.8, 0.5, 0.9, 0.4].map((scale, i) => (
            <motion.div
                key={i}
                initial={{ scaleY: 0.2 }}
                animate={{ scaleY: [0.2, scale, 0.2] }}
                transition={{ repeat: Infinity, duration: 0.6 + i * 0.1, ease: 'easeInOut' }}
                className="waveform-bar"
            />
        ))}
    </div>
);

// Simple hotkey display formatter — platform-aware
function formatHotkeyShort(hotkey: string, platform: string = 'darwin'): string {
    if (!hotkey) return '';
    const isWin = platform === 'win32';
    const map: Record<string, string> = isWin ? {
        'Alt': 'Alt', 'Command': 'Ctrl', 'Control': 'Ctrl', 'Super': 'Win', 'Shift': 'Shift', 'Space': 'Space',
    } : {
        'Alt': '⌥', 'Command': '⌘', 'Control': 'Ctrl', 'Shift': '⇧', 'Space': 'Space',
    };
    return hotkey.split('+').map(p => map[p] || p).join('+');
}

const Widget: React.FC<WidgetProps> = ({
    appState,
    onToggleRecording,
    statusMessage,
    whisperReady,
    whisperProgress,
    whisperStatus,
    hotkey,
    hotkeyMode,
}) => {
    const isRecording = appState === 'RECORDING';
    const isProcessing = appState === 'PROCESSING';
    const isCopied = statusMessage?.includes('✓');
    const [platform, setPlatform] = useState('darwin');
    const [transcriptionProgress, setTranscriptionProgress] = useState<number | null>(null);

    useEffect(() => {
        window.electronAPI?.getPlatform?.().then((p: string) => setPlatform(p));
        const unsub = window.electronAPI?.onTranscriptionProgress?.((percent) => {
            setTranscriptionProgress(percent);
        });
        const unsubResult = window.electronAPI?.onTranscriptionResult?.(() => {
            setTranscriptionProgress(null);
        });
        return () => { unsub?.(); unsubResult?.(); };
    }, []);

    const getStatusText = () => {
        if (!whisperReady && whisperProgress < 100) return whisperStatus || 'Loading...';
        if (statusMessage) return statusMessage;
        if (isRecording) return 'Recording';
        if (isProcessing) {
            if (transcriptionProgress !== null && transcriptionProgress < 100) {
                return `Processing ${transcriptionProgress}%`;
            }
            return 'Processing';
        }
        if (hotkey) {
            const verb = hotkeyMode === 'hold' ? 'Hold' : 'Press';
            return `${verb} ${formatHotkeyShort(hotkey, platform)} to record`;
        }
        return 'Ready';
    };

    return (
        <div className="widget-bar drag-region">
            <div className="grab-handle drag-region">
                <GripVertical size={14} />
            </div>

            <div className="no-drag" style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1 }}>
                {/* Mic button */}
                <div style={{ position: 'relative' }}>
                    <AnimatePresence>
                        {isRecording && (
                            <motion.div
                                className="mic-pulse"
                                initial={{ scale: 0.8, opacity: 0 }}
                                animate={{ scale: 1.4, opacity: 0.15 }}
                                exit={{ scale: 0.8, opacity: 0 }}
                                transition={{ repeat: Infinity, duration: 2, ease: 'easeOut' }}
                            />
                        )}
                    </AnimatePresence>
                    <button
                        className={`mic-btn ${isRecording ? 'recording' : ''} ${isCopied ? 'success' : ''}`}
                        onClick={onToggleRecording}
                        disabled={!whisperReady && whisperProgress < 100}
                    >
                        {isRecording ? (
                            <Square size={14} fill="currentColor" />
                        ) : isCopied ? (
                            <Check size={16} strokeWidth={3} />
                        ) : (
                            <Mic size={16} />
                        )}
                    </button>
                </div>

                {/* Status */}
                <div className="status-area">
                    <div className="status-row" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span className={`status-label ${isRecording ? 'recording' : ''} ${isCopied ? 'success' : ''}`}>
                            {getStatusText()}
                        </span>
                        {isRecording && <Waveform />}
                    </div>
                    {!whisperReady && whisperProgress > 0 && whisperProgress < 100 && (
                        <div className="model-progress">
                            <div className="model-progress-bar">
                                <div className="model-progress-fill" style={{ width: `${whisperProgress}%` }} />
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default Widget;
