import React, { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import type { Settings } from '../types';

interface SettingsPanelProps {
    settings: Settings;
    onUpdateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
    onClose: () => void;
}

const SettingsPanel: React.FC<SettingsPanelProps> = ({ settings, onUpdateSetting, onClose }) => {
    const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
    const [keyOptions, setKeyOptions] = useState<Array<{ id: string; label: string }>>([]);

    // Load key code map and mic devices
    useEffect(() => {
        window.electronAPI?.getKeyCodeMap?.().then(keys => setKeyOptions(keys || []));
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

    return (
        <div className="settings-overlay">
            <div className="settings-header">
                <span className="settings-title">Settings</span>
                <button className="settings-close-btn" onClick={onClose}>
                    <X size={14} />
                </button>
            </div>
            <div className="settings-body">
                {/* Push-to-Talk Key */}
                <div className="settings-group">
                    <span className="settings-label">Push-to-Talk Key</span>
                    <select
                        className="settings-value"
                        value={settings.hotkey}
                        onChange={e => {
                            const val = e.target.value;
                            window.electronAPI?.setHotkey(val);
                            onUpdateSetting('hotkey', val);
                        }}
                    >
                        {keyOptions.map(k => (
                            <option key={k.id} value={k.id}>{k.label}</option>
                        ))}
                        {/* If current hotkey isn't in the list, show it anyway */}
                        {keyOptions.length > 0 && !keyOptions.some(k => k.id === settings.hotkey) && (
                            <option value={settings.hotkey}>{settings.hotkey}</option>
                        )}
                    </select>
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
                        onChange={e => {
                            const lang = e.target.value;
                            onUpdateSetting('whisperLanguage', lang);
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

                {/* Launch on Login */}
                <LaunchOnLogin />
            </div>
        </div>
    );
};

export default SettingsPanel;
