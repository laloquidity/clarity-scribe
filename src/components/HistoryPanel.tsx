import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Trash2 } from 'lucide-react';
import type { HistoryEntry } from '../types';

interface HistoryPanelProps {
    entries: HistoryEntry[];
    onCopy: (text: string) => void;
    onDelete: (id: string) => void;
    onClear: () => void;
}

function formatTime(timestamp: number): string {
    const d = new Date(timestamp);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();

    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (isToday) return time;

    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;

    return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

/** Audio length: "12.4s" under a minute, "1:05" above. */
export function formatAudioLength(ms: number): string {
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    const mins = Math.floor(s / 60);
    const secs = Math.round(s % 60);
    return `${mins}:${String(secs).padStart(2, '0')}`;
}

/** Transcribe+paste latency: "380ms" under a second, "1.2s" above. */
export function formatLatency(ms: number): string {
    return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Speed vs real time: "33×". Sub-10× keeps a decimal so it stays truthful. */
export function formatSpeed(audioMs: number, latencyMs: number): string | null {
    if (!(audioMs > 0) || !(latencyMs > 0)) return null;
    const x = audioMs / latencyMs;
    return x >= 10 ? `${Math.round(x)}×` : `${x.toFixed(1)}×`;
}

const HistoryPanel: React.FC<HistoryPanelProps> = ({ entries, onCopy, onDelete, onClear }) => {
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
    const [confirmClearAll, setConfirmClearAll] = useState(false);

    const handleDeleteClick = (e: React.MouseEvent, id: string) => {
        e.stopPropagation();
        setConfirmDeleteId(id);
    };

    const handleConfirmDelete = (e: React.MouseEvent, id: string) => {
        e.stopPropagation();
        onDelete(id);
        setConfirmDeleteId(null);
    };

    const handleCancelDelete = (e: React.MouseEvent) => {
        e.stopPropagation();
        setConfirmDeleteId(null);
    };

    return (
        <div className="history-panel">
            <div className="history-header">
                <span className="history-title">History</span>
                {entries.length > 0 && (
                    <div className="history-header-actions">
                        {confirmClearAll ? (
                            <>
                                <button
                                    className="history-action-btn confirm"
                                    onClick={() => { onClear(); setConfirmClearAll(false); }}
                                >
                                    Confirm?
                                </button>
                                <button
                                    className="history-action-btn cancel"
                                    onClick={() => setConfirmClearAll(false)}
                                >
                                    Cancel
                                </button>
                            </>
                        ) : (
                            <button
                                className="history-clear-btn"
                                onClick={() => setConfirmClearAll(true)}
                            >
                                Clear All
                            </button>
                        )}
                    </div>
                )}
            </div>
            <div className="history-list">
                {entries.length === 0 ? (
                    <div className="history-empty">
                        Transcriptions will appear here
                    </div>
                ) : (
                    <AnimatePresence initial={false}>
                        {entries.map(entry => (
                            <motion.div
                                key={entry.id}
                                className="history-entry"
                                onClick={() => confirmDeleteId !== entry.id && onCopy(entry.text)}
                                initial={{ opacity: 0, height: 0 }}
                                animate={{ opacity: 1, height: 'auto' }}
                                exit={{ opacity: 0, height: 0 }}
                                transition={{ duration: 0.2 }}
                                title={confirmDeleteId === entry.id ? '' : 'Click to copy'}
                            >
                                <div className="history-entry-row">
                                    <div className="history-entry-text">{entry.text}</div>
                                    {confirmDeleteId !== entry.id && (
                                        <button
                                            className="history-delete-btn"
                                            onClick={(e) => handleDeleteClick(e, entry.id)}
                                            title="Delete"
                                        >
                                            <Trash2 size={11} />
                                        </button>
                                    )}
                                </div>
                                <div className="history-entry-meta">
                                    {confirmDeleteId === entry.id ? (
                                        <div className="history-confirm-bar">
                                            <button
                                                className="history-action-btn confirm"
                                                onClick={(e) => handleConfirmDelete(e, entry.id)}
                                            >
                                                Confirm Delete?
                                            </button>
                                            <button
                                                className="history-action-btn cancel"
                                                onClick={handleCancelDelete}
                                            >
                                                Cancel
                                            </button>
                                        </div>
                                    ) : (
                                        <>
                                            <span className="history-entry-time">{formatTime(entry.timestamp)}</span>
                                            {entry.audioMs !== undefined && (
                                                <>
                                                    <span className="history-entry-sep">·</span>
                                                    <span className="history-entry-stat" title="Audio length">
                                                        {formatAudioLength(entry.audioMs)}
                                                    </span>
                                                </>
                                            )}
                                            {entry.latencyMs !== undefined && (
                                                <>
                                                    <span className="history-entry-sep">·</span>
                                                    <span className="history-entry-stat" title="Transcription + paste time">
                                                        {formatLatency(entry.latencyMs)}
                                                    </span>
                                                </>
                                            )}
                                            {entry.audioMs !== undefined && entry.latencyMs !== undefined &&
                                                formatSpeed(entry.audioMs, entry.latencyMs) && (
                                                <>
                                                    <span className="history-entry-sep">·</span>
                                                    <span className="history-entry-stat speed" title="Speed vs real time">
                                                        {formatSpeed(entry.audioMs, entry.latencyMs)}
                                                    </span>
                                                </>
                                            )}
                                            {entry.app && entry.app !== 'clipboard' && (
                                                <span className="history-entry-app">→ {entry.app}</span>
                                            )}
                                        </>
                                    )}
                                </div>
                            </motion.div>
                        ))}
                    </AnimatePresence>
                )}
            </div>
        </div>
    );
};

export default HistoryPanel;
