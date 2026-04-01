# Clarity Scribe

A lightweight, standalone desktop dictation app powered by dual transcription engines: **NVIDIA Parakeet TDT 0.6B-v3** and **OpenAI Whisper Large V3 Turbo**. Press a global hotkey, speak, and your transcription is instantly pasted into whatever app you're using — up to **46x faster than real-time**.

Built with Electron, React, and ONNX Runtime for fully offline, GPU-accelerated speech-to-text.

## ⬇️ Download

| Platform | Download | Size |
|----------|----------|------|
| **Windows** (x64) | [**Clarity Scribe Setup (Windows)**](https://github.com/laloquidity/clarity-scribe/releases/latest) | ~472 MB |
| **macOS** (Apple Silicon) | [**Clarity Scribe.dmg (macOS)**](https://github.com/laloquidity/clarity-scribe/releases/latest) | ~119 MB |

> On first launch, the app downloads the Whisper AI model (~1.5 GB). Parakeet TDT (~890 MB) is downloaded on first use when engine is set to Auto or Parakeet. Fully offline after model downloads.

## Features

- **Dual Transcription Engine** — Auto-selects the best engine: Parakeet TDT for English/European languages (up to 38.6x real-time), Whisper for all others. Manual override available in settings.
- **Silero VAD Segmentation** — Intelligent voice activity detection splits audio at natural speech boundaries instead of arbitrary time intervals
- **Hallucination Detection** — Detects and corrects Whisper's looping/repetition artifacts with automatic retry
- **Context Prompting** — Maintains coherent transcription across long recordings by passing context between chunks
- **Overlap Deduplication** — Removes duplicate words at chunk boundaries for seamless output
- **Transcription Progress** — Real-time progress percentage shown during long recordings
- **Global Hotkey** — Configurable system-wide shortcut (default: `Option+Space` on Mac, `Alt+Space` on Windows)
- **GPU-Accelerated Transcription** — Hybrid hardware routing: DirectML GPU encoder + CPU decoder for Parakeet (benchmarked 38.6x real-time on RTX 3090), CUDA/Vulkan/Metal for Whisper, with automatic fallback
- **Paste-to-Target** — Transcriptions are automatically pasted into the app you were using when you started recording
- **Transcription History** — Timestamped log of all dictations with click-to-copy, individual delete, and clear all
- **Always-on-Top Widget** — Minimal floating bar with mic button, waveform visualization, and expandable history panel
- **Guided First-Run Setup** — Model download progress bar followed by permission requests
- **Tray Icon** — Lives in the system tray/menu bar for quick access
- **Launch on Login** — Optional toggle to start automatically when you log in
- **Multi-Language** — 25 European languages via Parakeet, 100+ via Whisper, with auto-detect and translate-to-English mode
- **Auto-Stop** — Configurable silence detection to automatically stop recording

## Transcription Engines

### Engine Selection

| Setting | Behavior |
|---------|----------|
| **Auto** (default) | Parakeet for English + 24 European languages, Whisper for all others |
| **Whisper Only** | Always use Whisper Large V3 Turbo |
| **Parakeet TDT Only** | Always use Parakeet (falls back to Whisper for unsupported languages) |

### Parakeet TDT 0.6B-v3

| Spec | Value |
|------|-------|
| Parameters | 600M |
| WER (English) | 6.05% (#1 on HuggingFace ASR Leaderboard) |
| Languages | 25 European |
| Speed | 15–38x real-time (hybrid DML+CPU, benchmarked on RTX 3090) |
| Model Size | ~890 MB (INT8 quantized ONNX) |

### Whisper Large V3 Turbo

| Spec | Value |
|------|-------|
| Parameters | 809M |
| WER | ~7.7% |
| Languages | 100+ |
| Speed | GPU-accelerated via Metal/CUDA/Vulkan |
| Model Size | ~1.5 GB |

### Transcription Pipeline

Long recordings are processed through a hardened pipeline:

1. **Silero VAD** — Detects speech segments, splits on natural pauses (~2MB ONNX model)
2. **Chunked Transcription** — Each segment processed independently (≤28s each)
3. **Context Prompting** — Last sentence of chunk N feeds into chunk N+1 for coherent flow
4. **Hallucination Detection** — If looping detected, retries with adjusted temperature
5. **Overlap Dedup** — Removes repeated words at segment boundaries
6. **Result Assembly** — Clean, continuous transcription output

## Requirements

- **macOS** 10.12+ (Apple Silicon or Intel)
- **Windows** 10/11 x64 (NVIDIA GPU recommended for best performance)
- ~2.5 GB disk space for both models (downloaded on first launch/use)
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

3. **Rebuild smart-whisper**:
   ```powershell
   $env:BYOL = "C:/whisper-build/build-cuda/src/Release/whisper.lib"
   npx node-gyp rebuild --directory=node_modules/smart-whisper --nodedir=$env:USERPROFILE/.electron-gyp/39.8.3 --arch=x64
   ```

### Build Installers

```bash
# macOS DMG
npm run build:mac

# Windows NSIS installer (must be run on Windows)
npm run build:win
```

Build output goes to the `release/` directory.

## Architecture

```
clarity-scribe/
├── electron/              # Main process
│   ├── main.ts            # Window, tray, IPC, hotkey, paste logic
│   ├── nativeWhisper.ts   # Engine router, Whisper, GPU detection, chunking
│   ├── vadService.ts      # Silero VAD speech detection (ONNX Runtime)
│   ├── parakeetService.ts # Parakeet TDT 0.6B-v3 engine (ONNX Runtime)
│   ├── tdtDecoder.ts      # Token-and-Duration Transducer beam search
│   └── preload.ts         # Context bridge (IPC API)
├── src/                   # Renderer (React)
│   ├── App.tsx            # Main shell with setup/widget/history/settings
│   ├── components/
│   │   ├── Widget.tsx         # Floating bar with mic, waveform, progress
│   │   ├── HistoryPanel.tsx   # Transcription history with delete
│   │   ├── SettingsPanel.tsx  # Engine, hotkey, mic, language, auto-stop
│   │   └── SetupScreen.tsx    # First-run download + permissions
│   ├── hooks/
│   │   ├── useAudioRecording.ts  # AudioWorklet recording pipeline
│   │   └── useSettings.ts       # Settings state management
│   └── styles/globals.css        # Dark glassmorphic theme
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

The app uses a **hybrid hardware routing** strategy, assigning each stage of the transcription pipeline to the hardware where it performs best:

### Parakeet TDT (ONNX Runtime)

The Parakeet encoder runs on GPU (DirectML) while the decoder/joiner run on CPU. This hybrid approach was benchmarked to be faster than running everything on any single provider:

| Config | 23s Audio | 60s Audio |
|--------|-----------|-----------|
| **Hybrid (DML encoder + CPU decoder)** | **854ms (26.6x)** | **1,313ms (46.2x)** |
| DML (all GPU) | 1,457ms (15.6x) | 2,283ms (28.1x) |
| CPU (all) | 1,268ms (17.2x) | 4,731ms (13.5x) |
| CUDA custom build (all GPU) | 1,971ms (12.3x) | 5,126ms (13.1x) |

*Benchmarked on NVIDIA GeForce RTX 3090, Windows 11, reading identical scripts. Paste latency: 11ms (native Win32 FFI via koffi).*

**Why hybrid wins:** The encoder benefits from GPU parallelism (processes entire audio at once), but the decoder runs hundreds of sequential inference calls per transcription — GPU kernel launch overhead dominates for these tiny operations, making CPU 3–6x faster for the decoder.

| Platform | Encoder | Decoder/Joiner |
|----------|---------|----------------|
| Windows (NVIDIA/AMD/Intel GPU) | DirectML | CPU |
| Windows (no GPU) | CPU | CPU |
| macOS (Apple Silicon) | CoreML | CPU |
| Linux | CUDA / CPU | CPU |

### Whisper Large V3 Turbo (whisper.cpp)

Uses CUDA, Vulkan, or Metal depending on platform. GPU DLLs are loaded automatically from `resources/win-gpu/{cuda,vulkan}/` on Windows.

## Privacy

- **Fully offline** — No audio or text ever leaves your machine
- **No telemetry** — Zero analytics, tracking, or network calls (except one-time model downloads from Hugging Face)
- **No accounts** — No sign-up, no cloud, no server
- **Local storage only** — Settings and history stored via `electron-store` on disk

## License

MIT
