import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
    // Transcription
    transcribe: (audio: Float32Array, sampleRate: number) => ipcRenderer.invoke('transcribe', audio, sampleRate),
    isWhisperReady: () => ipcRenderer.invoke('is-whisper-ready'),
    copyToClipboard: (text: string) => ipcRenderer.invoke('copy-to-clipboard', text),

    // Listeners
    onWhisperReady: (cb: (info?: { acceleration: string }) => void) => {
        const handler = (_: any, info?: { acceleration: string }) => cb(info);
        ipcRenderer.on('whisper-ready', handler);
        return () => { ipcRenderer.removeListener('whisper-ready', handler); };
    },
    onWhisperProgress: (cb: (p: number, m: string) => void) => {
        const handler = (_: any, p: number, m: string) => cb(p, m);
        ipcRenderer.on('whisper-progress', handler);
        return () => { ipcRenderer.removeListener('whisper-progress', handler); };
    },
    onTranscriptionResult: (cb: (text: string) => void) => {
        const handler = (_: any, text: string) => cb(text);
        ipcRenderer.on('transcription-result', handler);
        return () => { ipcRenderer.removeListener('transcription-result', handler); };
    },
    onToggleRecording: (cb: () => void) => {
        const handler = () => cb();
        ipcRenderer.on('toggle-recording', handler);
        return () => { ipcRenderer.removeListener('toggle-recording', handler); };
    },

    // Target app & paste
    getTargetApp: () => ipcRenderer.invoke('get-target-app'),
    clearTargetApp: () => ipcRenderer.invoke('clear-target-app'),
    pasteToTarget: (text: string) => ipcRenderer.invoke('paste-to-target', text),

    // Widget mic button — captures target app from cache before focus steal
    widgetToggleRecording: () => ipcRenderer.invoke('widget-toggle-recording'),

    // Settings
    getSettings: () => ipcRenderer.invoke('get-settings'),
    saveSettings: (settings: any) => ipcRenderer.invoke('save-settings', settings),
    getHotkey: () => ipcRenderer.invoke('get-hotkey'),
    setHotkey: (key: string) => ipcRenderer.invoke('set-hotkey', key),

    // History
    getHistory: () => ipcRenderer.invoke('get-history'),
    addHistory: (entry: any) => ipcRenderer.invoke('add-history', entry),
    clearHistory: () => ipcRenderer.invoke('clear-history'),
    deleteHistory: (id: string) => ipcRenderer.invoke('delete-history-entry', id),

    // Window
    quitApp: () => ipcRenderer.invoke('quit-app'),
    setWindowSize: (dims: { width: number; height: number }) => ipcRenderer.invoke('set-window-size', dims),

    // Permissions & Setup
    requestMicPermission: () => ipcRenderer.invoke('request-mic-permission'),
    requestAccessibilityPermission: () => ipcRenderer.invoke('request-accessibility-permission'),
    setupComplete: (opts?: { accessibilityGranted?: boolean }) => ipcRenderer.invoke('setup-complete', opts),
    isSetupDone: () => ipcRenderer.invoke('is-setup-done'),

    // Launch on Login
    getLaunchOnLogin: () => ipcRenderer.invoke('get-launch-on-login'),
    setLaunchOnLogin: (enabled: boolean) => ipcRenderer.invoke('set-launch-on-login', enabled),
});
