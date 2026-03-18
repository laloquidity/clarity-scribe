# Clarity Scribe

A lightweight, standalone desktop dictation app powered by OpenAI's Whisper Large V3 Turbo. Press a global hotkey, speak, and your transcription is instantly pasted into whatever app you're using.

Built with Electron, React, and whisper.cpp for fully offline, GPU-accelerated speech-to-text.

## Features

- **Global Hotkey** — Configurable system-wide shortcut (default: `Option+Space` on Mac, `Alt+Space` on Windows) to toggle recording from any app
- **Whisper Large V3 Turbo** — 809M parameter model with ~7.7% WER, runs locally via Metal (Mac) acceleration. ~1.5 GB one-time download
- **Paste-to-Target** — Transcriptions are automatically pasted into the app you were using when you started recording. Falls back to clipboard copy when paste isn't possible
- **Transcription History** — Timestamped log of all dictations with click-to-copy, individual delete, and clear all
- **Always-on-Top Widget** — Minimal floating bar with mic button, waveform visualization, and expandable history panel
- **Guided First-Run Setup** — Model download progress bar followed by permission requests (microphone + accessibility) so everything works on first use
- **Tray Icon** — Lives in the system tray/menu bar for quick access
- **Launch on Login** — Optional toggle to start automatically when you log in
- **Multi-Language** — Supports 100+ languages via Whisper, with auto-detect and translate-to-English mode
- **Auto-Stop** — Configurable silence detection to automatically stop recording (2s, 3s, 5s, or 10s)

## Requirements

- **macOS** 10.12+ (Apple Silicon or Intel)
- **Windows** support planned (requires alternative Whisper binding — see [Windows Status](#windows-status))
- ~1.5 GB disk space for the Whisper model (downloaded on first launch)
- ~2 GB RAM during transcription

## Getting Started

### From Source

```bash
git clone <repo-url>
cd clarity-scribe
npm install
npm run dev
```

### Build Installers

```bash
# macOS DMG
npm run build:mac

# Windows NSIS installer (must be run on Windows)
npm run build:win
```

Build output goes to the `release/` directory.

## How It Works

1. **Press your hotkey** (or click the mic icon) — Clarity Scribe captures which app you're in
2. **Speak** — Audio is recorded via the Web Audio API and processed through an AudioWorklet
3. **Release** (or let silence auto-stop) — Audio is sent to the local Whisper model
4. **Done** — Transcription is pasted into your original app, or copied to clipboard

The app runs a background poller to track the active/frontmost application, so it always knows where to paste. On macOS this uses AppleScript via System Events; on Windows it uses PowerShell with the Win32 API.

## Architecture

```
clarity-scribe/
├── electron/           # Main process
│   ├── main.ts         # Window, tray, IPC, hotkey, paste logic
│   ├── nativeWhisper.ts # Whisper model download, init, and transcription
│   └── preload.ts      # Context bridge (IPC API)
├── src/                # Renderer (React)
│   ├── App.tsx         # Main shell with setup/widget/history/settings
│   ├── components/
│   │   ├── Widget.tsx      # Floating bar with mic, waveform, status
│   │   ├── HistoryPanel.tsx # Transcription history with delete
│   │   ├── SettingsPanel.tsx # Hotkey, mic, language, auto-stop, login
│   │   └── SetupScreen.tsx  # First-run download + permissions
│   ├── hooks/
│   │   ├── useAudioRecording.ts # AudioWorklet recording pipeline
│   │   └── useSettings.ts      # Settings state management
│   └── styles/globals.css       # Dark glassmorphic theme
├── resources/
│   ├── icon.icns       # macOS app icon
│   ├── icon.png        # Source icon
│   └── entitlements.mac.plist # macOS permissions
├── electron-builder.yml # Build configuration
└── vite.config.ts       # Vite bundler config
```

## Transcription Engine

Uses [`@napi-rs/whisper`](https://www.npmjs.com/package/@napi-rs/whisper) — a Rust/NAPI binding around [whisper.cpp](https://github.com/ggerganov/whisper.cpp) by Georgi Gerganov. The model file (`ggml-large-v3-turbo.bin`) is downloaded from Hugging Face on first launch and stored locally in the app's user data directory. Large V3 Turbo is a distilled version of Large V3 — 4 decoder layers instead of 32 — delivering comparable accuracy at significantly faster inference.

| Model | Parameters | WER | Size | Speed |
|-------|-----------|-----|------|-------|
| Whisper Small | 244M | ~10.5% | 460 MB | Fast |
| **Large V3 Turbo** (default) | **809M** | **~7.7%** | **1.5 GB** | **Nearly as fast (distilled)** |
| Large V3 | 1.54B | ~6.8% | 3+ GB | Slowest |

## Windows Status

The current Whisper binding (`@napi-rs/whisper`) only supports macOS. For Windows builds, an alternative binding such as `smart-whisper` or `@xenova/transformers` (ONNX/WebGPU) is needed. The architecture supports this — only `electron/nativeWhisper.ts` needs a platform-conditional import. The rest of the app (UI, audio recording, paste logic) is fully cross-platform.

## Privacy

- **Fully offline** — No audio or text ever leaves your machine
- **No telemetry** — Zero analytics, tracking, or network calls (except the one-time model download from Hugging Face)
- **No accounts** — No sign-up, no cloud, no server
- **Local storage only** — Settings and history stored via `electron-store` on disk

## License

MIT
