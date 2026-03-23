import React, { useState, useEffect, useCallback, useRef } from 'react';
import { X } from 'lucide-react';
import type { Settings } from '../types';

interface SettingsPanelProps {
    settings: Settings;
    onUpdateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
    onClose: () => void;
}

// Map Electron accelerator parts to display-friendly symbols
function formatHotkey(hotkey: string, platform: string = 'darwin'): string {
    if (!hotkey) return '—';

    const isWin = platform === 'win32';

    const MAP: Record<string, string> = isWin ? {
        'CommandOrControl': 'Ctrl',
        'Command': 'Win',
        'Super': 'Win',
        'Control': 'Ctrl',
        'Alt': 'Alt',
        'Shift': 'Shift',
        'Space': 'Space',
        ' ': 'Space',
        '\u00A0': 'Space',
    } : {
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
    const [platform, setPlatform] = useState('darwin');
    const listeningRef = useRef(false);

    // Detect platform
    useEffect(() => {
        window.electronAPI?.getPlatform?.().then(p => setPlatform(p));
    }, []);

    // Load mic devices
    useEffect(() => {
        navigator.mediaDevices.enumerateDevices().then(devices => {
            setMicDevices(devices.filter(d => d.kind === 'audioinput'));
        }).catch(() => {});
    }, []);

// Launch on Login sub-component
function LaunchOnLogin() {
    const [enabled, setEnabled] = React.useState(false);
    React.useEffect(() => {
        window.electronAPI?.getLaunchOnLogin().then(setEnabled).catch(() => {});
    }, []);
    return (
        <div className="settings-group">
            <span className="settings-label">Launch at Startup</span>
            <label className="settings-toggle">
                <input
                    type="checkbox"
                    checked={enabled}
                    onChange={e => {
                        setEnabled(e.target.checked);
                        window.electronAPI?.setLaunchOnLogin(e.target.checked);
                    }}
                />
                <span className="toggle-slider" />
            </label>
        </div>
    );
}

    // Hotkey capture — waits for modifier(s) + a non-modifier key
    const captureRef = useRef<HTMLInputElement>(null);
    const prevHotkeyRef = useRef(settings.hotkey);

    const handleKeyDown = useCallback((e: KeyboardEvent) => {
        if (!listeningRef.current) return;
        e.preventDefault();
        e.stopPropagation();

        const modifierKeys = ['Meta', 'Control', 'Alt', 'Shift'];
        const key = e.key;

        // Escape cancels capture
        if (key === 'Escape') {
            setListening(false);
            listeningRef.current = false;
            return;
        }

        // Only register when a non-modifier key is pressed
        if (modifierKeys.includes(key)) return;

        const parts: string[] = [];
        if (e.metaKey) parts.push('Command');
        if (e.ctrlKey) parts.push('Control');
        if (e.altKey) parts.push('Alt');
        if (e.shiftKey) parts.push('Shift');

        // Add the actual key
        if (key === ' ' || key === '\u00A0' || key === 'Spacebar') parts.push('Space');
        else if (key.length === 1) parts.push(key.toUpperCase());
        else parts.push(key);

        // Require at least modifier+key
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
            // Focus the capture input so the user knows it's active
            setTimeout(() => captureRef.current?.focus(), 50);
            return () => {
                window.removeEventListener('keydown', handleKeyDown, true);
                listeningRef.current = false;
            };
        }
    }, [listening, handleKeyDown]);

    const startCustomCapture = () => {
        prevHotkeyRef.current = settings.hotkey;
        setListening(true);
    };

    const handleDropdownChange = (value: string) => {
        setListening(false);
        listeningRef.current = false;
        window.electronAPI?.setHotkey(value);
        onUpdateSetting('hotkey', value);
    };

    // Determine dropdown value — if current hotkey is a preset, show it; otherwise blank
    const PRESETS = ['Alt+Space', 'Control+Shift+Space', 'Control+Shift+R', 'F8'];
    const isPreset = PRESETS.includes(settings.hotkey);

    return (
        <div className="settings-overlay">
            <div className="settings-header">
                <span className="settings-title">Settings</span>
                <button className="settings-close-btn" onClick={onClose}>
                    <X size={14} />
                </button>
            </div>
            <div className="settings-body">
                {/* Shortcut */}
                <div className="settings-group">
                    <span className="settings-label">Shortcut</span>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {listening ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                <input
                                    ref={captureRef}
                                    className="hotkey-capture-input"
                                    type="text"
                                    readOnly
                                    value="Press shortcut..."
                                    onBlur={() => {
                                        setTimeout(() => {
                                            if (listeningRef.current) {
                                                setListening(false);
                                                listeningRef.current = false;
                                            }
                                        }, 200);
                                    }}
                                />
                                <span style={{
                                    fontSize: 9,
                                    color: 'var(--text-muted)',
                                    textAlign: 'center',
                                }}>
                                    Hold modifier(s) + press a key · Escape to cancel
                                </span>
                            </div>
                        ) : (
                            <select
                                className="settings-value"
                                value={isPreset ? settings.hotkey : '__custom__'}
                                onChange={e => {
                                    const val = e.target.value;
                                    if (val === '__custom__') {
                                        startCustomCapture();
                                    } else {
                                        handleDropdownChange(val);
                                    }
                                }}
                            >
                                {platform === 'win32' ? (
                                    <>
                                        <option value="Alt+Space">Alt + Space</option>
                                        <option value="Control+Shift+Space">Ctrl + Shift + Space</option>
                                        <option value="Control+Shift+R">Ctrl + Shift + R</option>
                                        <option value="F8">F8</option>
                                    </>
                                ) : (
                                    <>
                                        <option value="Alt+Space">⌥ Space</option>
                                        <option value="Control+Shift+Space">Ctrl ⇧ Space</option>
                                        <option value="Control+Shift+R">Ctrl ⇧ R</option>
                                        <option value="F8">F8</option>
                                    </>
                                )}
                                {!isPreset && (
                                    <option value="__custom__" disabled>
                                        {formatHotkey(settings.hotkey, platform)}
                                    </option>
                                )}
                                <option value="__custom__">Custom…</option>
                            </select>
                        )}
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

                {/* Language — drives engine selection under the hood */}
                <div className="settings-group">
                    <span className="settings-label">Language</span>
                    <select
                        className="settings-value"
                        value={settings.whisperLanguage}
                        onChange={e => {
                            const lang = e.target.value;
                            onUpdateSetting('whisperLanguage', lang);
                            // Engine routing: English → Parakeet, everything else → Whisper
                            if (lang === 'en') {
                                window.electronAPI?.setTranscriptionEngine?.('parakeet');
                                window.electronAPI?.initParakeet?.();
                            } else {
                                window.electronAPI?.setTranscriptionEngine?.('whisper');
                            }
                        }}
                    >
                        <option value="en">English</option>
                        <option value="auto">Auto-detect</option>
                        <option disabled>──────────</option>
                        <option value="af">Afrikaans</option>
                        <option value="sq">Albanian</option>
                        <option value="am">Amharic</option>
                        <option value="ar">Arabic</option>
                        <option value="hy">Armenian</option>
                        <option value="as">Assamese</option>
                        <option value="az">Azerbaijani</option>
                        <option value="ba">Bashkir</option>
                        <option value="eu">Basque</option>
                        <option value="be">Belarusian</option>
                        <option value="bn">Bengali</option>
                        <option value="bs">Bosnian</option>
                        <option value="br">Breton</option>
                        <option value="bg">Bulgarian</option>
                        <option value="my">Burmese</option>
                        <option value="ca">Catalan</option>
                        <option value="zh">Chinese</option>
                        <option value="hr">Croatian</option>
                        <option value="cs">Czech</option>
                        <option value="da">Danish</option>
                        <option value="nl">Dutch</option>
                        <option value="et">Estonian</option>
                        <option value="fo">Faroese</option>
                        <option value="fi">Finnish</option>
                        <option value="fr">French</option>
                        <option value="gl">Galician</option>
                        <option value="ka">Georgian</option>
                        <option value="de">German</option>
                        <option value="el">Greek</option>
                        <option value="gu">Gujarati</option>
                        <option value="ht">Haitian Creole</option>
                        <option value="ha">Hausa</option>
                        <option value="haw">Hawaiian</option>
                        <option value="he">Hebrew</option>
                        <option value="hi">Hindi</option>
                        <option value="hu">Hungarian</option>
                        <option value="is">Icelandic</option>
                        <option value="id">Indonesian</option>
                        <option value="it">Italian</option>
                        <option value="ja">Japanese</option>
                        <option value="jw">Javanese</option>
                        <option value="kn">Kannada</option>
                        <option value="kk">Kazakh</option>
                        <option value="km">Khmer</option>
                        <option value="ko">Korean</option>
                        <option value="lo">Lao</option>
                        <option value="la">Latin</option>
                        <option value="lv">Latvian</option>
                        <option value="ln">Lingala</option>
                        <option value="lt">Lithuanian</option>
                        <option value="lb">Luxembourgish</option>
                        <option value="mk">Macedonian</option>
                        <option value="mg">Malagasy</option>
                        <option value="ms">Malay</option>
                        <option value="ml">Malayalam</option>
                        <option value="mt">Maltese</option>
                        <option value="mi">Maori</option>
                        <option value="mr">Marathi</option>
                        <option value="mn">Mongolian</option>
                        <option value="ne">Nepali</option>
                        <option value="no">Norwegian</option>
                        <option value="nn">Nynorsk</option>
                        <option value="oc">Occitan</option>
                        <option value="ps">Pashto</option>
                        <option value="fa">Persian</option>
                        <option value="pl">Polish</option>
                        <option value="pt">Portuguese</option>
                        <option value="pa">Punjabi</option>
                        <option value="ro">Romanian</option>
                        <option value="ru">Russian</option>
                        <option value="sa">Sanskrit</option>
                        <option value="sr">Serbian</option>
                        <option value="sn">Shona</option>
                        <option value="sd">Sindhi</option>
                        <option value="si">Sinhala</option>
                        <option value="sk">Slovak</option>
                        <option value="sl">Slovenian</option>
                        <option value="so">Somali</option>
                        <option value="es">Spanish</option>
                        <option value="su">Sundanese</option>
                        <option value="sw">Swahili</option>
                        <option value="sv">Swedish</option>
                        <option value="tl">Tagalog</option>
                        <option value="tg">Tajik</option>
                        <option value="ta">Tamil</option>
                        <option value="tt">Tatar</option>
                        <option value="te">Telugu</option>
                        <option value="th">Thai</option>
                        <option value="bo">Tibetan</option>
                        <option value="tr">Turkish</option>
                        <option value="tk">Turkmen</option>
                        <option value="uk">Ukrainian</option>
                        <option value="ur">Urdu</option>
                        <option value="uz">Uzbek</option>
                        <option value="vi">Vietnamese</option>
                        <option value="cy">Welsh</option>
                        <option value="yi">Yiddish</option>
                        <option value="yo">Yoruba</option>
                        <option disabled>──────────</option>
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

                {/* Launch on Login */}
                <LaunchOnLogin />
            </div>
        </div>
    );
};

export default SettingsPanel;
