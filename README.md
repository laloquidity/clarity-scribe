# Clarity Scribe

A lightweight, standalone desktop dictation app powered by dual transcription engines: **NVIDIA Parakeet TDT 0.6B-v3** and **OpenAI Whisper Large V3 Turbo**. Press a global hotkey — or hold a key to talk — and your transcription is instantly pasted into whatever app you're using — up to **~150x faster than real-time** on Apple Silicon (Apple Neural Engine) and ~19–53x on Windows (GPU). Transcribe 8 minutes of audio in about 3 seconds on a Mac.

Built with Electron and React, with CoreML (Apple Neural Engine) on macOS and ONNX Runtime (DirectML GPU) on Windows, for fully offline, hardware-accelerated speech-to-text.

## ⬇️ Download

| Platform | Install |
|----------|---------|
| **Windows** (x64) | [**Clarity Scribe Setup (Windows)**](https://github.com/laloquidity/clarity-scribe/releases/download/v2.8.0/Clarity.Scribe.Setup.2.8.0.exe) (~912 MB) |
| **macOS** (Apple Silicon) | Clone and run from source — see [Getting Started](#getting-started) |

> On first launch, the app downloads the Whisper AI model (~1.5 GB). Parakeet TDT (~890 MB) is downloaded on first use when engine is set to Auto or Parakeet. Fully offline after model downloads.

## Features

- **Dual Transcription Engine** — Auto-selects the best engine: Parakeet TDT for English/European languages (up to ~150x real-time on Apple Silicon), Whisper for all others. Manual override available in settings.
- **Live Streaming Transcription** — Speech is transcribed *while you talk*: segments are processed at natural pauses in the background, a live preview shows in the widget, and at stop only the last phrase remains — **text lands ~100–380 ms after you stop, no matter how long you spoke**. Automatic fallback to classic batch processing if anything fails. (Parakeet engine; toggle in Settings.)
- **Spoken Punctuation** (opt-in) — Say "comma", "period", "new line", "question mark" — with context-aware "dot" that only activates in URLs ("google dot com" → "google.com").
- **Personal Dictionary** — Add custom word corrections that automatically apply to every transcription. Maps what was written to what you meant (e.g. `Chat GPT` to `ChatGPT`). Book icon in the widget bar opens a full CRUD panel with Add, Edit, batch Delete, Export JSON, and Import JSON. Each entry auto-generates ~12 case/hyphen/space variants for robust matching.
- **Hold-to-Talk Mode** — Hold a key to record, release to transcribe — or use the classic tap-to-toggle. Switch modes instantly in Settings with an Apple-style segmented control. Single function keys (F5-F12) for hold mode, modifier combos for toggle mode.
- **Filler Word Removal** — Automatically strips filled pauses (um, uh, ah, er) from transcriptions while preserving natural speech patterns
- **No-Audio Auto-Stop** — Automatically stops recording if no meaningful audio is detected for 80% of a 30-second window. Catches wrong mic selection, muted mic, and forgotten recordings.
- **Silero VAD Segmentation** — Intelligent voice activity detection splits audio at natural speech boundaries instead of arbitrary time intervals
- **Hallucination Detection** — Detects and corrects Whisper looping/repetition artifacts with automatic retry. Also suppresses the cold-start Thank You hallucination on short silent clips.
- **Context Prompting** — Maintains coherent transcription across long recordings by passing context between chunks
- **Overlap Deduplication** — Removes duplicate words at chunk boundaries for seamless output
- **Transcription Progress** — Real-time progress percentage shown during long recordings
- **Global Hotkey** — Configurable system-wide shortcut (default: `Option+Space` on Mac, `Alt+Space` on Windows)
- **Hardware-Accelerated Transcription** — Parakeet runs on the **Apple Neural Engine** (CoreML) on Apple Silicon (~150× real-time on typical dictation) and on the **DirectML GPU** on Windows, each with automatic fallback to an optimized CPU path, then Whisper
- **Native Paste-to-Target** — Transcriptions instantly pasted into your active app via native Win32 FFI (11ms on Windows) or consolidated AppleScript (~50ms on Mac)
- **Transcription History** — Timestamped log of all dictations with click-to-copy, individual delete, and clear all
- **Always-on-Top Widget** — Minimal floating bar with mic button, waveform visualization, and expandable history panel
- **Guided First-Run Setup** — Model download progress bar followed by permission requests
- **Tray Icon** — Lives in the system tray/menu bar for quick access
- **Launch on Login** — Optional toggle to start automatically when you log in
- **Multi-Language** — 25 European languages via Parakeet, 100+ via Whisper, with auto-detect and translate-to-English mode
- **Auto-Stop** — Configurable silence detection to automatically stop recording (toggle mode only)

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
| Speed | ~150x real-time (Mac, Apple Neural Engine), 19–53x (Windows GPU) |
| Model Size | ~470 MB (CoreML, macOS) / ~890 MB (INT8 ONNX, Windows & fallback) |

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

**Parakeet TDT:**
1. **Encoding** — FastConformer encoder. macOS runs it on the Apple Neural Engine (CoreML); Windows runs it on the DirectML GPU; both fall back to CPU.
2. **TDT Decoding** — Token-and-Duration Transducer greedy decode, with the prediction network cached across silence frames and DirectML collapse recovery.
3. **Result Assembly** — Clean, continuous transcription output

> **macOS (Apple Silicon)**: the CoreML Neural Engine sidecar is the default and chunks long audio internally (15s windows, 2s overlap). It falls back to ONNX-CPU (single-pass ≤60s, then Silero VAD segmentation), then Whisper. **Windows/Linux**: single-pass on the GPU first, with batched VAD-segment encoding as an automatic fallback for very long or truncated audio.

**Whisper:**
1. **Silero VAD** — Same speech boundary detection
2. **Chunked Transcription** — Each segment processed independently
3. **Context Prompting** — Last sentence of chunk N feeds into chunk N+1 for coherent flow
4. **Hallucination Detection** — If looping detected, retries with adjusted temperature
5. **Overlap Dedup** — Removes repeated words at segment boundaries
6. **Result Assembly** — Clean, continuous transcription output

## Requirements

- **macOS** 12.0+ (Apple Silicon)
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

That's the whole flow on **both macOS and Windows** — no extra steps, **no compiler or CUDA toolkit required**, and **both engines work out of the box**. On **Windows**, `npm install` drops in a committed prebuilt `smart-whisper` binary (no Visual Studio needed) and auto-downloads the Whisper GPU backend DLLs (~17 MB Vulkan bundle, works on any GPU); the Parakeet encoder runs on the **DirectML GPU**. On **macOS (Apple Silicon)**, `npm run dev` automatically builds the native CoreML sidecar the first time (subsequent launches are instant), and the app uses the **Apple Neural Engine** engine. The AI models (~470 MB CoreML / ~1.5 GB Whisper / ~890 MB Parakeet) download on first use. If anything is missing the app degrades gracefully (CoreML → ONNX → Whisper) and still runs.

> **macOS prerequisite for the ANE engine:** Xcode 16+ / Swift 6 (for the one-time sidecar build). Without it, `npm run dev` still launches and falls back to the ONNX engine automatically.

### Windows GPU DLLs (for the Whisper engine)

The Whisper engine needs the whisper.cpp GPU backend DLLs. These are gitignored (the CUDA set is ~570 MB — too large for git), so `npm install` **downloads them automatically** from the [`win-gpu-dlls`](https://github.com/laloquidity/clarity-scribe/releases/tag/win-gpu-dlls) release into `resources/win-gpu/`. By default it pulls the **Vulkan** bundle (~17 MB, works on NVIDIA/AMD/Intel, no toolkit). Nothing to do — it just works.

**Optional — NVIDIA CUDA backend** (marginally faster on NVIDIA; requires the [CUDA Toolkit](https://developer.nvidia.com/cuda-toolkit) installed for `nvrtc`/`nvJitLink`):

```powershell
node scripts/download-win-gpu.js cuda
```

<details>
<summary>Building the GPU DLLs from source instead (maintainers)</summary>

```powershell
# Build whisper.cpp with CUDA (requires CUDA Toolkit + Visual Studio Build Tools)
git clone https://github.com/ggerganov/whisper.cpp C:\whisper-build
cd C:\whisper-build
cmake -B build-cuda -DGGML_CUDA=ON -DBUILD_SHARED_LIBS=ON
cmake --build build-cuda --config Release
```

Copy `whisper.dll, ggml.dll, ggml-base.dll, ggml-cpu.dll, ggml-cuda.dll` plus the CUDA runtime DLLs (`cublas64_*.dll, cublasLt64_*.dll, cudart64_*.dll`) into `resources/win-gpu/cuda/`. Re-host the bundles with `scripts/upload-win-gpu-dlls.sh`.

</details>

### Regenerating the prebuilt `smart-whisper` binary (maintainers)

End users never need this — they get the committed `prebuilt/win32-x64/smart-whisper.node` automatically via `postinstall`. Regenerate it only after bumping Electron or refreshing the CUDA `whisper.dll`. After step 1 above produces `whisper.lib`:

```powershell
$env:BYOL = "C:/whisper-build/build-cuda/src/Release/whisper.lib"
npm run build:prebuilt:win   # patches headers, BYOL-rebuilds, updates prebuilt/win32-x64/ — then commit it
```

<details>
<summary>Manual equivalent (if you'd rather run the steps yourself)</summary>

```powershell
$env:BYOL = "C:/whisper-build/build-cuda/src/Release/whisper.lib"
node scripts/patch-smart-whisper.js
# use your installed Electron version for the headers dir:
npx node-gyp rebuild --directory=node_modules/smart-whisper --nodedir=$env:USERPROFILE/.electron-gyp/<electron-version> --arch=x64
```

</details>

### Build Installers

Production installers that bundle everything and work after install (AI models download on first run):

```bash
# macOS .dmg (Apple Silicon) — also builds + bundles the CoreML ANE sidecar
npm run build:mac

# Windows .exe installer (run on Windows)
npm run build:win
```

Build output goes to the `release/` directory.

> The macOS build is **unsigned** (no Apple Developer account needed). A `.dmg` you build yourself opens normally on your own machine. If you hand the `.dmg` to someone else, they'll need to right-click → **Open** the first time — or run `xattr -dr com.apple.quarantine "/Applications/Clarity Scribe.app"` — because it isn't notarized.

## Architecture

```
clarity-scribe/
├── electron/              # Main process
│   ├── main.ts            # Window, tray, IPC, paste logic
│   ├── hotkeyService.ts   # Unified hotkey handler (toggle + hold-to-talk)
│   ├── nativeWhisper.ts   # Engine router, Whisper, GPU detection, chunking
│   ├── vadService.ts      # Silero VAD speech detection (ONNX Runtime)
│   ├── parakeetService.ts # Parakeet engine router (CoreML sidecar / ONNX) + batched long-audio path
│   ├── parakeetCore.ts    # Pure DSP + TDT decode (mel/FFT, decoder caching, collapse recovery) — unit-tested
│   ├── parakeetSidecar.ts # CoreML ANE sidecar manager (spawn/protocol/model download, macOS)
│   ├── winPaste.ts        # Native Win32 paste via koffi FFI (Windows)
│   ├── tdtDecoder.ts      # Token-and-Duration Transducer beam search
│   └── preload.ts         # Context bridge (IPC API)
├── native/
│   └── parakeet-sidecar/  # Swift CoreML/ANE Parakeet sidecar (built for macOS bundles)
├── src/                   # Renderer (React)
│   ├── App.tsx            # Main shell with setup/widget/history/settings/dictionary
│   ├── components/
│   │   ├── Widget.tsx             # Floating bar with mic, waveform, progress
│   │   ├── HistoryPanel.tsx       # Transcription history with delete
│   │   ├── SettingsPanel.tsx      # Recording mode, hotkey, mic, language, auto-stop
│   │   ├── PersonalDictionary.tsx # Word correction CRUD panel
│   │   └── SetupScreen.tsx        # First-run download + permissions
│   ├── hooks/
│   │   ├── useAudioRecording.ts  # AudioWorklet recording pipeline + no-audio guard
│   │   └── useSettings.ts        # Settings state management
│   ├── utils/
│   │   └── cleanTranscription.ts # Filler removal + personal dictionary post-processing
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

This is the engine used on Windows, and the fallback on macOS. The Parakeet encoder runs on the GPU (DirectML on Windows) while the decoder/joiner run on CPU. On macOS the default is instead the CoreML sidecar with the encoder on the Apple Neural Engine (see Performance above). The hybrid ONNX routing was benchmarked faster than running everything on any single provider:

**Windows (RTX 3090):**

With **live streaming transcription** (v3.0, default on), segments are processed during recording — perceived stop→text latency is **~100–380 ms at any recording length**. The batch numbers below apply when streaming is off or the fallback engages:

| Config | 7.3s Audio | 30s Audio | 60s Audio |
|--------|-----------|-----------|-----------|
| **v3.0 batch (sparse mel + parallel decode)** | **~170ms (43x)** | **~560ms (54x)** | **~810ms (74x)** |
| v2.9 batch (same hardware) | 173ms (42x) | 650ms (46x) | 1,033ms (58x) |
| CPU (all) | 336ms enc-only (22x) | 1,400ms enc-only (21x) | 3,172ms enc-only (19x) |

*Paste latency: 2–3ms (native Win32 FFI via koffi). Windows tries single-pass first, with batched VAD-segment encoding as an automatic fallback for very long or truncated audio. FP16/FP32 encoder variants were benchmarked on DirectML and rejected (≤15% gain for 2× the download); CUDA EP is not available in onnxruntime-node on Windows (Linux-only per the official support matrix).*

**macOS (Apple Silicon M-series):**

The default engine is the CoreML sidecar with the encoder on the Apple Neural Engine. Measured on an M-series Mac:

| Audio | Engine | Total | RTF |
|-------|--------|-------|-----|
| 25.3s | **CoreML ANE (default)** | **167ms** | **~151x** |
| 74.1s | **CoreML ANE (default)** | **526ms** | **~141x** |
| 7.3s | CoreML ANE (default) | 62ms | ~118x |
| 7.3s | ONNX-CPU (fallback) | 162ms | ~45x |

*Real-time factor climbs with longer audio as the fixed per-call overhead amortizes. The ANE sidecar chunks long audio internally (15s windows, 2s overlap). The ONNX-CPU fallback uses single-pass ≤60s, then Silero VAD segmentation.*

**Why hybrid wins on Windows:** The encoder benefits from GPU parallelism (processes entire audio at once), but the decoder runs hundreds of sequential inference calls per transcription — GPU kernel launch overhead dominates for these tiny operations, making CPU 3–6x faster for the decoder.

| Platform | Encoder | Decoder/Joiner |
|----------|---------|----------------|
| Windows (NVIDIA/AMD/Intel GPU) | DirectML | CPU |
| Windows (no GPU) | CPU | CPU |
| macOS (Apple Silicon) | Apple Neural Engine (CoreML) → CPU | CPU |
| Linux | CUDA / CPU | CPU |

### Whisper Large V3 Turbo (whisper.cpp)

Uses CUDA, Vulkan, or Metal depending on platform. GPU DLLs are loaded automatically from `resources/win-gpu/{cuda,vulkan}/` on Windows.

## Privacy

- **Fully offline** — No audio or text ever leaves your machine
- **No telemetry** — Zero analytics, tracking, or network calls (except one-time model downloads from Hugging Face)
- **No accounts** — No sign-up, no cloud, no server
- **Local storage only** — Settings and history stored via `electron-store` on disk

## License

[AGPL v3 + Commons Clause](./LICENSE) — Free for personal use. Commercial use prohibited. Forks must remain open source under the same license.
