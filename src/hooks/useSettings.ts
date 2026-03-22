/**
 * useSettings — Simplified settings hook for Clarity Scribe
 */
import { useState, useEffect, useCallback } from 'react';
import type { Settings } from '../types';

const DEFAULT_SETTINGS: Settings = {
    hotkey: 'Super+Space',
    selectedMicId: 'default',
    whisperLanguage: 'en',
    silenceDuration: 0,
};

export function useSettings() {
    const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
    const [isLoaded, setIsLoaded] = useState(false);

    useEffect(() => {
        const load = async () => {
            const api = window.electronAPI;
            if (api?.getSettings) {
                const saved = await api.getSettings();
                if (saved) {
                    setSettings({ ...DEFAULT_SETTINGS, ...saved });
                }
            }
            setIsLoaded(true);
        };
        load();
    }, []);

    // Auto-save on change
    useEffect(() => {
        if (!isLoaded) return;
        const timeout = setTimeout(() => {
            window.electronAPI?.saveSettings(settings);
        }, 500);
        return () => clearTimeout(timeout);
    }, [settings, isLoaded]);

    const updateSetting = useCallback(<K extends keyof Settings>(key: K, value: Settings[K]) => {
        setSettings(prev => ({ ...prev, [key]: value }));
    }, []);

    return { settings, updateSetting, isLoaded };
}
