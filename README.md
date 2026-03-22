# Clarity Scribe

A lightweight, standalone desktop dictation app powered by OpenAI's Whisper Large V3 Turbo. Press a global hotkey, speak, and your transcription is instantly pasted into whatever app you're using.

Built with Electron, React, and whisper.cpp for fully offline, GPU-accelerated speech-to-text.

## ⬇️ Download

| Platform | Download | Size |
|----------|----------|------|
| **Windows** (x64) | [**Clarity Scribe Setup (Windows)**](https://github.com/laloquidity/clarity-scribe/releases/latest) | ~472 MB |
| **macOS** (Universal) | [**Clarity Scribe (macOS)**](https://github.com/laloquidity/clarity-scribe/releases/latest) | Coming soon |

> On first launch, the app downloads the Whisper AI model (~1.5 GB). This only happens once — after that everything runs fully offline.

## Features

- **Global Hotkey** — Configurable system-wide shortcut (default: `Option+Space` on Mac, `Win+Space` on Windows) to toggle recording from any app
- **GPU-Accelerated Transcription** — Metal on macOS, CUDA (NVIDIA) or Vulkan (Intel/AMD) on Windows, with automatic CPU fallback
- **Whisper Large V3 Turbo** — 809M parameter model with ~7.7% WER, runs fully locally. ~1.5 GB one-time download
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
- **Windows** 10/11 x64 (NVIDIA GPU recommended for best performance)
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

### Windows GPU Setup (BYOL Rebuild)

To enable GPU acceleration on Windows, the `smart-whisper` native addon must be rebuilt with [BYOL](https://github.com/nicholasgasior/smart-whisper#byol) linking against a CUDA-compiled `whisper.dll`:

1. **Build whisper.cpp with CUDA** (requires [CUDA Toolkit](https://developer.nvidia.com/cuda-toolkit) and Visual Studio Build Tools):
   ```powershell
   git clone https://github.com/ggerganov/whisper.cpp C:\whisper-build
   cd C:\whisper-build
   cmake -B build-cuda -DGGML_CUDA=ON -DBUILD_SHARED_LIBS=ON
   cmake --build build-cuda --config Release
   ```

2. **Copy GPU DLLs** to `resources/win-gpu/cuda/`:
   ```
   whisper.dll, ggml.dll, ggml-base.dll, ggml-cpu.dll, ggml-cuda.dll
   ```
   Also copy CUDA runtime DLLs from the CUDA Toolkit (`cublas64_*.dll`, `cublasLt64_*.dll`, `cudart64_*.dll`).

3. **Cache Electron headers** (if behind a VPN/firewall):
   ```powershell
   # Download headers manually and place in ~/.electron-gyp/39.8.3/
   ```

4. **Rebuild smart-whisper**:
   ```powershell
   $env:BYOL = "C:/whisper-build/build-cuda/src/Release/whisper.lib"
   npx node-gyp rebuild --directory=node_modules/smart-whisper --nodedir=$env:USERPROFILE/.electron-gyp/39.8.3 --arch=x64
   ```

The `postinstall` script automatically patches smart-whisper for ABI compatibility with the CUDA build.

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
├── electron/              # Main process
│   ├── main.ts            # Window, tray, IPC, hotkey, paste logic
│   ├── nativeWhisper.ts   # Whisper init, GPU detection, transcription
│   └── preload.ts         # Context bridge (IPC API)
├── src/                   # Renderer (React)
│   ├── App.tsx            # Main shell with setup/widget/history/settings
│   ├── components/
│   │   ├── Widget.tsx         # Floating bar with mic, waveform, status
│   │   ├── HistoryPanel.tsx   # Transcription history with delete
│   │   ├── SettingsPanel.tsx  # Hotkey, mic, language, auto-stop, login
│   │   └── SetupScreen.tsx    # First-run download + permissions
│   ├── hooks/
│   │   ├── useAudioRecording.ts  # AudioWorklet recording pipeline
│   │   └── useSettings.ts       # Settings state management
│   └── styles/globals.css        # Dark glassmorphic theme
├── scripts/
│   ├── patch-smart-whisper.js    # Postinstall: patches smart-whisper for GPU ABI
│   └── whisper-headers/          # CUDA-build-compatible whisper.cpp headers
├── resources/
│   ├── win-gpu/
│   │   ├── cuda/          # CUDA backend DLLs (NVIDIA)
│   │   └── vulkan/        # Vulkan backend DLLs (Intel/AMD/NVIDIA)
│   ├── icon.icns          # macOS app icon
│   └── entitlements.mac.plist  # macOS permissions
├── electron-builder.yml   # Build configuration
└── vite.config.ts         # Vite bundler config
```

## GPU Acceleration

The app auto-detects the best available GPU backend at startup:

| Priority | Backend | GPUs | Performance |
|----------|---------|------|-------------|
| 1 | **CUDA** | NVIDIA (GTX 10xx+) | ~1-2s for 3s audio |
| 2 | **Vulkan** | Intel, AMD, NVIDIA | ~3-5s for 3s audio |
| 3 | **CPU** | Any (fallback) | ~20s for 3s audio |

Detection happens in `nativeWhisper.ts` → `detectGpuBackend()`. The corresponding DLLs are loaded from `resources/win-gpu/{cuda,vulkan}/` and injected into `PATH` before the whisper module loads.

## Transcription Engine

- **macOS**: [`@napi-rs/whisper`](https://www.npmjs.com/package/@napi-rs/whisper) — Rust/NAPI binding with Metal acceleration
- **Windows**: [`smart-whisper`](https://www.npmjs.com/package/smart-whisper) — C++/NAPI binding with BYOL (Bring Your Own Library) support for CUDA/Vulkan

Both use [whisper.cpp](https://github.com/ggerganov/whisper.cpp) by Georgi Gerganov under the hood. The model file (`ggml-large-v3-turbo.bin`) is downloaded from Hugging Face on first launch and stored locally. Large V3 Turbo is a distilled version of Large V3 — 4 decoder layers instead of 32 — delivering comparable accuracy at significantly faster inference.

| Model | Parameters | WER | Size | Speed |
|-------|-----------|-----|------|-------|
| Whisper Small | 244M | ~10.5% | 460 MB | Fast |
| **Large V3 Turbo** (default) | **809M** | **~7.7%** | **1.5 GB** | **Nearly as fast (distilled)** |
| Large V3 | 1.54B | ~6.8% | 3+ GB | Slowest |

## Privacy

- **Fully offline** — No audio or text ever leaves your machine
- **No telemetry** — Zero analytics, tracking, or network calls (except the one-time model download from Hugging Face)
- **No accounts** — No sign-up, no cloud, no server
- **Local storage only** — Settings and history stored via `electron-store` on disk

## License

MIT
