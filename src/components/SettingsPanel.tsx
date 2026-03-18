import React, { useState, useEffect, useCallback, useRef } from 'react';
import { X } from 'lucide-react';
import type { Settings } from '../types';

interface SettingsPanelProps {
    settings: Settings;
    onUpdateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
    onClose: () => void;
}

// Map Electron accelerator parts to display-friendly symbols
function formatHotkey(hotkey: string): string {
    if (!hotkey) return '—';

    const MAP: Record<string, string> = {
        'CommandOrControl': '⌘/Ctrl',
        'Command': '⌘',
        'Control': 'Ctrl',
        'Alt': '⌥',
        'Shift': '⇧',
        'Space': 'Space',
        ' ': 'Space',
        '\u00A0': 'Space',  // non-breaking space from Mac Option+Space
    };

    // Split on + delimiter, map each part, rejoin
    const parts = hotkey.split('+');
    const mapped = parts
        .map(p => p.trim())
        .filter(p => p.length > 0)
        .map(p => MAP[p] || (p.length === 1 ? p.toUpperCase() : p));

    return mapped.length > 0 ? mapped.join(' + ') : '—';
}

const SettingsPanel: React.FC<SettingsPanelProps> = ({ settings, onUpdateSetting, onClose }) => {
    const [listening, setListening] = useState(false);
    const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
    const listeningRef = useRef(false);

    // Load mic devices
    useEffect(() => {
        navigator.mediaDevices.enumerateDevices().then(devices => {
            setMicDevices(devices.filter(d => d.kind === 'audioinput'));
        }).catch(console.error);
    }, []);

    // Hotkey capture
    const handleKeyDown = useCallback((e: KeyboardEvent) => {
        if (!listeningRef.current) return;
        e.preventDefault();
        e.stopPropagation();

        const parts: string[] = [];
        if (e.metaKey) parts.push('Command');
        if (e.ctrlKey) parts.push('Control');
        if (e.altKey) parts.push('Alt');
        if (e.shiftKey) parts.push('Shift');

        const key = e.key;
        if (!['Meta', 'Control', 'Alt', 'Shift'].includes(key)) {
            // Space, non-breaking space (Mac Option+Space), or any whitespace
            if (key === ' ' || key === '\u00A0' || key === 'Spacebar') parts.push('Space');
            else if (key.length === 1) parts.push(key.toUpperCase());
            else parts.push(key);
        }

        if (parts.length >= 2) {
            const accelerator = parts.join('+');
            window.electronAPI?.setHotkey(accelerator);
            onUpdateSetting('hotkey', accelerator);
            setListening(false);
            listeningRef.current = false;
        }
    }, [onUpdateSetting]);

    useEffect(() => {
        if (listening) {
            listeningRef.current = true;
            window.addEventListener('keydown', handleKeyDown, true);
            return () => {
                window.removeEventListener('keydown', handleKeyDown, true);
                listeningRef.current = false;
            };
        }
    }, [listening, handleKeyDown]);

    return (
        <div className="settings-overlay">
            <div className="settings-header">
                <span className="settings-title">Settings</span>
                <button className="settings-close-btn" onClick={onClose}>
                    <X size={14} />
                </button>
            </div>
            <div className="settings-body">
                {/* Hotkey */}
                <div className="settings-group">
                    <span className="settings-label">Global Hotkey</span>
                    <div
                        className={`hotkey-capture no-drag ${listening ? 'listening' : ''}`}
                        onClick={() => setListening(!listening)}
                    >
                        {listening ? 'Press a key combination...' : formatHotkey(settings.hotkey)}
                    </div>
                </div>

                {/* Microphone */}
                <div className="settings-group">
                    <span className="settings-label">Microphone</span>
                    <select
                        className="settings-value"
                        value={settings.selectedMicId}
                        onChange={e => onUpdateSetting('selectedMicId', e.target.value)}
                    >
                        <option value="default">System Default</option>
                        {micDevices.map(d => (
                            <option key={d.deviceId} value={d.deviceId}>
                                {d.label || `Microphone ${d.deviceId.substring(0, 8)}`}
                            </option>
                        ))}
                    </select>
                </div>

                {/* Language */}
                <div className="settings-group">
                    <span className="settings-label">Language</span>
                    <select
                        className="settings-value"
                        value={settings.whisperLanguage}
                        onChange={e => onUpdateSetting('whisperLanguage', e.target.value)}
                    >
                        <option value="en">English</option>
                        <option value="auto">Auto-detect</option>
                        <option value="es">Spanish</option>
                        <option value="fr">French</option>
                        <option value="de">German</option>
                        <option value="it">Italian</option>
                        <option value="pt">Portuguese</option>
                        <option value="nl">Dutch</option>
                        <option value="ar">Arabic</option>
                        <option value="zh">Chinese</option>
                        <option value="ja">Japanese</option>
                        <option value="ko">Korean</option>
                        <option value="ru">Russian</option>
                        <option value="en-translate">Translate to English</option>
                    </select>
                </div>

                {/* Auto-stop silence */}
                <div className="settings-group">
                    <span className="settings-label">Auto-stop after silence</span>
                    <select
                        className="settings-value"
                        value={settings.silenceDuration}
                        onChange={e => onUpdateSetting('silenceDuration', Number(e.target.value))}
                    >
                        <option value={0}>Disabled</option>
                        <option value={2000}>2 seconds</option>
                        <option value={3000}>3 seconds</option>
                        <option value={5000}>5 seconds</option>
                        <option value={10000}>10 seconds</option>
                    </select>
                </div>
            </div>
        </div>
    );
};

export default SettingsPanel;
