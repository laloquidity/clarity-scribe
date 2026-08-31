# Clarity Scribe

A lightweight, standalone desktop dictation app powered by dual transcription engines: **NVIDIA Parakeet TDT 0.6B-v3** and **OpenAI Whisper Large V3 Turbo**. Press a global hotkey — or hold a key to talk — and your transcription is instantly pasted into whatever app you're using. With **live streaming transcription** (v3), speech is processed *while you talk*, so text lands **about half a second after you stop, no matter how long you spoke** — up to **1212× real-time** on Windows (RTX 3090, measured across 160 real dictations) and **1055× on Apple Silicon** ([the numbers](#speed)).

Built with Electron and React, with CoreML (Apple Neural Engine) on macOS and ONNX Runtime (DirectML GPU) on Windows, for fully offline, hardware-accelerated speech-to-text.

## ⬇️ Download

| Platform | Install |
|----------|---------|
| **Windows** (x64) | [**Clarity Scribe Setup 3.1.0 (Windows)**](https://github.com/laloquidity/clarity-scribe/releases/download/v3.1.0/Clarity.Scribe.Setup.3.1.0.exe) (~913 MB — live streaming engine, GPU backends bundled) |
| **macOS** (Apple Silicon) | Clone and run from source — see [Getting Started](#getting-started) |

> On first launch, the app downloads the Whisper AI model (~1.5 GB). Parakeet TDT (~890 MB) is downloaded on first use when engine is set to Auto or Parakeet. Fully offline after model downloads.

## Features

- **Dual Transcription Engine** — Auto-selects the best engine: Parakeet TDT for English/European languages (fast, fully on-device), Whisper for all others. Manual override available in settings.
- **Live Streaming Transcription** — Speech is transcribed *while you talk*: segments are processed at natural pauses in the background, and at stop only the last phrase remains, so **text lands about half a second after you stop no matter how long you spoke** — up to **1212× real-time** (Windows RTX 3090, a 2 m 53 s recording pasted 143 ms after stop, measured across 160 real dictations) and **1055× on Apple Silicon** (an 8 m 38 s dictation pasted 491 ms after stop) ([full numbers](#speed)). A live transcript box grows under the widget as you speak (capped, newest words pinned). Automatic fallback to classic batch processing if anything fails. (Parakeet engine; toggle in Settings.)
- **Per-Dictation Stats** — Every history entry shows `45.3s audio · 396ms transcribe · 114× real-time`: audio length, true stop→pasted latency, and speed vs real time.
- **Smart Formatting (ITN)** (opt-in) — Spoken forms become written forms: "two thirty pm" → "2:30 PM", "fifty million dollars" → "$50,000,000" (with thousands separators), dates, ordinals, punctuation commands.
- **Spoken Punctuation** (opt-in) — Say "comma", "period", "new line", "question mark" — with context-aware "dot" that only activates in URLs ("google dot com" → "google.com").
- **Sound Cues** (opt-in) — Subtle generated blips on recording start/stop.
- **Personal Dictionary with decoder-level recognition** — Add custom word corrections that apply to every transcription (e.g. `Chat GPT` to `ChatGPT`), with full CRUD, Export/Import JSON, and ~12 auto-generated variants per entry. Dictionary terms also feed **shallow-fusion vocabulary biasing inside the decoder** on every platform: the model is nudged toward emitting your custom terms as it hears them, instead of only being string-replaced afterwards. Both sides of an entry are boosted where the term is specific enough to be safe, which is what makes rare words recoverable — see [Custom vocabulary](#custom-vocabulary-words-the-model-gets-wrong).
- **Local API** (opt-in) — Loopback-only HTTP API + SSE event stream: scripts and agents can start/stop dictation and consume live transcripts. See [Local API](#local-api-programmable-voice-layer).
- **MCP Server** — Scribe is callable as a tool provider from Claude Desktop, Claude Code, and any MCP-speaking agent: `dictate`, `start/stop_dictation`, `get_recent_transcripts`. See [MCP server](#mcp-server-use-scribe-from-ai-agents).
- **Command Mode** (experimental, opt-in, default OFF) — Speak commands instead of dictation: a second hotkey (F10) routes your words through a **local LLM** (llama.cpp + Gemma 4, fully offline) to actions — open apps/folders, search the web, type text, show transcripts. A **risk rulebook** governs execution: benign actions **just run**; consequential ones (launching executables, contacting people) show a Confirm/Cancel proposal that auto-cancels if unanswered; severe tiers (money, credentials, bulk deletion) refuse outright. Unsupported requests get an honest "I can't do that" instead of a wrong action. Requires `llama-server` + a Gemma 4 GGUF (auto-discovered from `C:\llama-server` / overridable via `SCRIBE_LLAMA_SERVER` + `SCRIBE_ROUTER_MODEL`).
- **Screen Agent** (experimental, part of Command Mode, Windows) — Multi-step commands drive the computer like a person would: *"open spotify and play we will rock you"* → the agent reads the app's **real controls** via the Windows **accessibility tree** (exact names + rectangles, ~100 ms, no GPU), decides one action at a time with the local LLM, and activates controls **programmatically** (so it can't misclick), falling back to computer vision (OmniParser) only for apps with no accessibility data. Live step feed with a Stop button (**Esc aborts instantly, even mid-step**); every click is re-checked against the risk rulebook mid-flight — "Send"/"Buy"/"Delete" pause for approval, credential fields are refused; a step cap + loop detection stop a wandering agent. See [Screen agent](#screen-agent-voice-driven-computer-use).
- **Hold-to-Talk Mode** — Hold a key to record, release to transcribe — or use the classic tap-to-toggle. Switch modes instantly in Settings with an Apple-style segmented control. Single function keys (F5-F12) for hold mode, modifier combos for toggle mode.
- **Filler Word Removal** — Automatically strips filled pauses (um, uh, ah, er) from transcriptions while preserving natural speech patterns
- **No-Audio Auto-Stop** — Automatically stops recording if no meaningful audio is detected for 80% of a 30-second window. Catches wrong mic selection, muted mic, and forgotten recordings.
- **Silero VAD Segmentation** — Intelligent voice activity detection splits audio at natural speech boundaries instead of arbitrary time intervals
- **Hallucination Detection** — Detects and corrects Whisper looping/repetition artifacts with automatic retry. Also suppresses the cold-start Thank You hallucination on short silent clips.
- **Context Prompting** — Maintains coherent transcription across long recordings by passing context between chunks
- **Overlap Deduplication** — Removes duplicate words at chunk boundaries for seamless output
- **Transcription Progress** — Real-time progress percentage shown during long recordings
- **Global Hotkey** — Configurable system-wide shortcut (default: `Option+Space` on Mac, `Alt+Space` on Windows)
- **Hardware-Accelerated Transcription** — Parakeet runs on the **Apple Neural Engine** (CoreML) on Apple Silicon and on the **DirectML GPU** on Windows, each with automatic fallback to an optimized CPU path, then Whisper
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
| Speed | stop→text ~0.5s at any length — up to **1571× real-time** streaming (Windows RTX 3090) / **1055×** (Apple Silicon); ~74× batch (Windows GPU) |
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

## Speed

Measured from **160 real dictations** — 63 minutes of actual speech, 1.3 s to
2 m 53 s — on a Windows RTX 3090 with the Parakeet engine (DirectML):

| You spoke for | Dictations | Up To |
|---|---|---|
| Under 10 s | 58 | **122×** |
| 10–30 s | 60 | **304×** |
| 30–60 s | 30 | **432×** |
| Over a minute | 12 | **1212×** |

\* **× real-time** = how much audio you recorded, divided by how long you waited
— measured from **the moment you stop speaking to the text appearing in your
app**, paste included. Current record: an **11 m 39 s** recording that landed
**445 ms** after the stop key — **1571× real-time**.

**The longer you speak, the higher the multiple climbs** — that's the streaming
architecture working. Your speech is transcribed *as you talk*, at natural
pauses, so when you stop there's only the last phrase left to process. The wait
stays roughly constant no matter how long you spoke — about half a second, and
the longest wait across all 160 dictations was 0.9 s — so a longer recording
simply divides that same short wait into a bigger number.

The same architecture runs on **Apple Silicon** (CoreML / Apple Neural Engine):
an 8 m 38 s dictation there landed **491 ms after the stop key — 1055×
real-time**, end-to-end.

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
│   ├── parakeetCore.ts    # Pure DSP + TDT decode (mel/FFT, decoder caching, collapse recovery, vocabulary bias) — unit-tested
│   ├── parakeetSidecar.ts # CoreML ANE sidecar manager (spawn/protocol/model download, encode-only handoff, macOS)
│   ├── streamingTranscriber.ts # Transcribe-while-recording: RMS segmenter, segment queue, partials — unit-tested
│   ├── localApi.ts        # Loopback SSE event stream + record/command control (opt-in) — unit-tested
│   ├── llmRouter.ts       # Resident llama-server lifecycle + local command routing (Gemma 4)
│   ├── commandTools.ts    # Command-mode tool registry with safety tiers — unit-tested
│   ├── commandMode.ts     # Voice→action stage machine with confirmation gating — unit-tested
│   ├── winPaste.ts        # Native Win32 paste via koffi FFI with foreground verification (Windows)
│   ├── tdtDecoder.ts      # Token-and-Duration Transducer beam search
│   └── preload.ts         # Context bridge (IPC API)
├── mcp/
│   ├── scribe-mcp.mjs     # MCP stdio server: dictate/start/stop/status/history tools
│   └── scribeApi.mjs      # Local-API client core the bridge is built on — unit-tested
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
│   │   ├── cleanTranscription.ts  # Filler removal + personal dictionary post-processing
│   │   ├── itn.ts                 # Smart formatting: numbers, currency ($50,000,000), times, dates — unit-tested
│   │   └── spokenPunctuation.ts   # Spoken punctuation commands with URL-aware "dot" — unit-tested
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

**Windows (RTX 3090) — real-world dictation measurements (v3, streaming on):**

With **live streaming transcription** (default on), segments are processed *during* recording, so the wait after you stop speaking is only the final phrase — **length-independent**. Measured across **160 real dictations** (stop → text pasted, end-to-end including paste) — see [Speed](#speed) for the full breakdown:

| You spoke for | Dictations | Typical stop→text | Up To |
|---|---|---|---|
| Under 10s | 58 | ~490ms | **122×** |
| 10–30s | 60 | ~460ms | **304×** |
| 30–60s | 30 | ~500ms | **432×** |
| Over a minute | 12 | ~580ms | **1212×** |

*Across all 160: **p50 490 ms · p90 677 ms · p99 888 ms** — a three-minute dictation lands as fast as a three-second one. Longest wait ever recorded: 0.9 s. Current single-dictation record, set after this dataset: **11 m 39 s of audio pasted 445 ms after the stop key — 1571× real-time**.*

Batch-mode numbers (streaming off, or when the fallback engages) on the same hardware:

| Config | 7.3s Audio | 30s Audio | 60s Audio |
|--------|-----------|-----------|-----------|
| **v3 batch (sparse mel + parallel decode)** | **~170ms (43x)** | **~560ms (54x)** | **~810ms (74x)** |
| v2.9 batch (same hardware) | 173ms (42x) | 650ms (46x) | 1,033ms (58x) |
| CPU (all) | 336ms enc-only (22x) | 1,400ms enc-only (21x) | 3,172ms enc-only (19x) |

*Paste latency: 2–3ms (native Win32 FFI via koffi, with foreground verification). Windows tries single-pass first, with batched VAD-segment encoding as an automatic fallback for very long or truncated audio. FP16/FP32 encoder variants were benchmarked on DirectML and rejected (≤15% gain for 2× the download); CUDA EP is not available in onnxruntime-node on Windows (Linux-only per the official support matrix).*

**macOS (Apple Silicon M-series):**

The default engine is the CoreML sidecar with the encoder on the Apple Neural Engine. With **live streaming transcription** on (default), the same length-independent wait applies as on Windows — an **8 m 38 s dictation landed 491 ms after the stop key: 1055× real-time**, end-to-end including paste.

Engine-only throughput (streaming off, audio in → text ready), measured on the same M-series Mac:

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

## Custom vocabulary (words the model gets wrong)

Speech models collapse rare words onto common ones they have seen far more
often, so an unusual name or product term can lose every time to a common
near-homophone. Fixing that afterwards with a find-and-replace does not work:
a rule broad enough to catch the mistake also rewrites the common word the
model was getting right.

Scribe biases the decoder instead. Personal Dictionary terms are tokenized into
the model's SentencePiece inventory and stored in a trie; while decoding, any
token that would extend one of your terms gets a logit boost before the argmax.
Three rules keep it contained:

- The boost only reaches ids that share a token prefix with your terms, so an
  unrelated transcript is untouched.
- The boost may redistribute among words, never create one. If the model was
  going to emit silence, silence wins untouched. Without that rule a strong
  enough boost sprays custom terms across pauses.
- A term is biased only if **few vocabulary pieces share its first token**. That
  token is boosted on every frame, so it is only as safe as it is specific — and
  specificity is not length. Two-character starts range from one shared piece to
  more than thirty, depending on how common the opening letters are. Measured on
  real recordings, terms starting with a widely shared token pull ordinary words
  into the term mid-sentence, truncating the real word; terms with a rare start
  stay clean well above the shipped boost. Terms over the threshold are dropped
  from the trie entirely — not merely left unboosted, since an organically
  emitted start token would otherwise still collect the continuation pull and
  complete the term.

All three are pinned by regression tests, including one that decodes a padded
clip to prove nothing appears in the silence.

**Entries are `original → replacement`, where the original is a spelling the
model can actually produce.** For an ordinary fix (`Chat GPT` → `ChatGPT`) the
model already writes both. For a word it never writes at all, use the nearest
spelling it does reach, and pick one rare enough that rewriting it is safe.
Both sides of an entry are boosted where they qualify: the decoder is steered
toward the reachable spelling, and the replacement is what lands in your text.
An entry whose start token is too common still works as a post-processing
replacement — the variants list already catches whatever the model writes — so
only its decoder biasing is declined, and the startup log names any term this
applies to.

The boost is global, so a term needing an unusually strong pull cannot get one
without over-firing the rest. If a rare word keeps losing to a common
near-homophone, add the spelling the model actually produces as the entry's
`original` rather than raising the boost; the sweep harness below tells you what
that spelling is.

Near-homophones are the limit of this approach. Biasing can recover a word the
model would otherwise collapse into a commoner neighbour, but the boost is
context-free — it pulls equally whether you meant the custom term or the
everyday word that sounds like it. Where the two occur in the same sentence,
expect the occasional wrong pick in either direction, and note that lowering the
boost trades misses for false hits rather than removing the error.

The boost is a logit addend, so the useful range depends on the gap between
your term and whatever common word competes with it. Measured against real
recordings, an intended term starts winning around 4, the competing common word
holds until about 8, and past that the boost begins overriding words it should
have left alone. The shipped default is 6. Retune against your own audio rather
than guessing:

```bash
SWEEP_AUDIO=clip.f32 SWEEP_TERMS=YourTerm SWEEP_BOOSTS=0,4,6,8 npx vitest run test/bias-sweep.test.ts
```

Capture a clip with `SCRIBE_DUMP_AUDIO=<dir> npm run dev`, and override the
shipped value with `SCRIBE_BIAS_BOOST`.

**How this works on Apple Silicon.** The CoreML joint model takes its own argmax
on the Neural Engine and never exposes logits, so nothing inside the sidecar can
be biased. When you have dictionary terms, Scribe takes the encoder output back
from the ANE and runs the decode itself, where the bias applies. The encoder is
~80% of the work and stays on the Neural Engine; only the decode moves, and that
is 19 ms for 7 s of audio against 123 ms for the encoder. It needs the two small
ONNX models (~18 MB), never the 622 MB ONNX encoder. With no dictionary terms
the sidecar runs end-to-end exactly as before, and windows longer than 15 s stay
on the sidecar's own chunking.

Expect improvement rather than perfection. In ordinary speech the intended term
is recovered most of the time while its common neighbour is preserved. Isolated
repetitions with no surrounding context can push the multilingual model into
another script entirely, and no boost recovers that.

## Local API (programmable voice layer)

Clarity Scribe can expose a small **loopback-only** HTTP API so scripts, agents,
and automations can drive dictation and observe transcription in real time. This
is the integration seam for building agent/automation workflows on top of your
voice — start/stop recording programmatically and stream partial and final
transcripts as they happen.

Disabled by default. Enable it in Settings ("Local API") and restart the app.
When on, it binds `127.0.0.1:5111` (never reachable off your machine) and issues
a random bearer token on first start, stored locally (copy it from Settings).

### Auth

Every request requires the token, supplied either way:

- Header: `Authorization: Bearer <token>`
- Query param: `?token=<token>` (needed for `EventSource`, which can't set headers)

Requests without a valid token get `401`.

### Endpoints

| Method | Path                    | Description                                             |
| ------ | ----------------------- | ------------------------------------------------------- |
| GET    | `/v1/events`            | SSE stream of live events (see below)                   |
| POST   | `/v1/record/start`      | Start recording. `200 {ok:true}` or `409` if already on |
| POST   | `/v1/record/stop`       | Stop recording. `200 {ok:true}` or `409` if not on      |
| GET    | `/v1/status`            | `{recording, engine, version}`                          |
| GET    | `/v1/history?limit=N`   | `{entries:[…]}` — recent transcripts, newest first      |

Unknown routes return a JSON `404`. All responses are `application/json` except
the event stream.

### Event stream (SSE)

`GET /v1/events` holds open a `text/event-stream`. Each event is a JSON object on
a `data:` line, with a `ts` (epoch ms):

- `{type:"hello", version, ts}` — sent once on connect
- `{type:"partial", text, ts}` — live in-progress transcript
- `{type:"result", text, ts}` — finalized transcript
- `{type:"state", state:"RECORDING"|"PROCESSING"|"IDLE", ts}` — recording lifecycle

A heartbeat comment is sent every 15s to keep the connection alive.

### Example (curl)

```bash
TOKEN=<your-token>

# Start recording
curl -X POST http://127.0.0.1:5111/v1/record/start \
  -H "Authorization: Bearer $TOKEN"

# Check status
curl http://127.0.0.1:5111/v1/status -H "Authorization: Bearer $TOKEN"

# Stream live events (Ctrl-C to stop)
curl -N "http://127.0.0.1:5111/v1/events?token=$TOKEN"
```

Browser / EventSource:

```js
const es = new EventSource(`http://127.0.0.1:5111/v1/events?token=${TOKEN}`);
es.onmessage = (e) => console.log(JSON.parse(e.data));
```

## MCP server (use Scribe from AI agents)

Scribe ships a [Model Context Protocol](https://modelcontextprotocol.io) server —
the standard way AI agents discover and call an app's capabilities. Any MCP host
(Claude Desktop, Claude Code, the Claude Agent SDK, agent runtimes that speak
MCP) can use Scribe as its **voice input**: an agent calls `dictate`, you speak,
the agent gets your words back as a tool result.

Tools exposed: `dictate` (start recording + wait for the final transcript),
`start_dictation` / `stop_dictation`, `get_status`, `get_recent_transcripts`.

**Setup**

1. Enable **Local API** in Scribe's Settings and restart the app (the MCP server
   is a thin stdio bridge over it; it auto-discovers the port and token from
   Scribe's config).
2. Register the bridge with your MCP host. Claude Desktop
   (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "clarity-scribe": {
      "command": "node",
      "args": ["<repo>/mcp/scribe-mcp.mjs"]
    }
  }
}
```

From a source checkout use `mcp/scribe-mcp.mjs` (after `npm install`). Installed
builds ship a self-contained bundle at
`<install dir>/resources/scribe-mcp.mjs` — point `args` there instead (no
`node_modules` needed).

Example: in Claude Desktop, ask *"use clarity-scribe to let me dictate my
answer"* — Claude calls `dictate`, you talk, hit your stop hotkey, and your
words arrive in the conversation. The same tools work from any agent framework
that speaks MCP, which is the foundation for the voice-command roadmap.

## Screen agent (voice-driven computer use)

Commands are dispatched in tiers, cheapest first:

| Tier | How it decides | Typical latency |
|---|---|---|
| **Recipe** | a known multi-step flow, replayed deterministically | **~instant + app speed** |
| **Fast path** | pattern match → deep link / launch / URL. **No LLM.** | **~90–190 ms** |
| **Routed** | the local LLM picks one tool | ~0.6–2.5 s |
| **Agent** | full perceive→decide→act loop | seconds per step |

The commands people repeat all day — *"open my downloads folder"*, *"search the
web for…"*, *"play X on spotify"* — never touch the model: they're matched
deterministically and dispatched directly (Spotify via its `spotify:` deep
link, so no clicking at all). Anything ambiguous falls through to the LLM, and
genuinely novel multi-step work falls through to the agent below. Fast-path
commands work even before the model has finished loading.

When a request *does* need to act inside an app, it runs through a local
**accessibility-first** perceive→decide→act loop (modeled on Microsoft's
[UFO²](https://github.com/microsoft/UFO) Windows agent):

1. **Perceive** — a native **UI Automation** reader (`uia-probe.exe`) returns
   the focused window's *real* controls — exact names, exact screen
   rectangles, and which support programmatic activation — in ~100–200 ms with
   no GPU. It's one bulk `FindAll` + `CacheRequest`, so reads don't become
   slow cross-process round-trips. Chromium/Electron apps (Spotify, Discord)
   build their tree *lazily*, so a sparse first read is retried with backoff
   rather than written off. Only a window that still exposes no useful tree
   (games, canvas UIs) falls back to **OmniParser v2** vision (YOLO +
   Florence-2 on the GPU), scoped to that window.
2. **Decide** — the same local Gemma model that routes commands picks exactly
   one next action from the numbered control list: click a control, type into a
   field, press keys, scroll, launch an app, wait, or declare done/impossible.
3. **Act** — **programmatically first** (`InvokePattern`/`ValuePattern`): the OS
   activates the exact control, so the cursor never moves and can't misclick.
   Physical `SendInput` is a fallback, and only fires once the target window is
   verified foreground.

Say *"open spotify and play we will rock you"* and the agent launches Spotify
(resolving the real install path, not guessing), finds and focuses its window,
then searches and plays the result — narrating every step in the widget.

**Guardrails** (the same risk rulebook that governs one-shot commands, applied
at two levels):

| Level | AUTO | CONFIRM (card, ↵/Esc) | REFUSE |
|---|---|---|---|
| Goal (before anything runs) | benign in-app tasks | messaging/emailing/posting *as you* | purchases, money transfer, credentials, sign-in, bulk deletion |
| Each click (mid-task) | ordinary controls | "Send", "Buy now", "Delete", "Post"… | password / card-number fields |

Plus mechanical limits: a **true kill switch** — global **Esc aborts instantly,
even mid-perceive or mid-decision** — one agent at a time, window-scoped actions
(a click can't wander onto the desktop), a hard step cap, a wall-clock deadline,
and stuck-loop detection. Unanswered mid-task confirmations auto-cancel — an
agent never acts on silence.

**Setup (Windows):** the accessibility reader (`native/uia-probe/uia-probe.exe`)
ships prebuilt and needs nothing — it works out of the box for standard
Win32/WPF apps. The **vision fallback** (for Chromium/canvas apps) is optional:
clone [OmniParser](https://github.com/microsoft/OmniParser) with its v2 weights
into `C:\Users\<you>\tools\OmniParser` (or set `SCRIBE_OMNIPARSER_DIR`) with a
`.venv` of its requirements. The Settings panel shows
`Screen agent: native accessibility ✓ · vision fallback ✓`. Everything —
accessibility, vision, reasoning, input — runs locally; nothing ever leaves your
machine.

## Recipes — learn once, replay fast

The agent can drive any app, but pays a model call per step, so a six-step
task costs tens of seconds. Most of that work is identical every time: the
steps to message someone are the same today as yesterday — only the contact
and the words change. A **recipe** captures that structure so the next run
replays deterministically.

Scribe ships a deliberately tiny curated pack (`recipes/builtin.json` — one
recipe today, Spotify) and records new ones locally from successful agent
runs. **A recipe only ships once it has been watched working**: every builtin
carries a `verified` note citing a dated, observed run, and a test enforces
it. Reasoning that a recipe *should* work — "it's only a URL", "the selectors
look right" — explicitly does not count, because an unproven recipe is a
false promise that just fails until it quarantines itself. The pack grows one
verified entry at a time.

Apps with poor accessibility support need the vision fallback rather than a
recipe — Telegram Desktop, for instance, exposes no usable tree on Windows.

Two invariants make this safe:

**1. Structure, never values.** A recipe may reference `{{message}}`; it can
never contain the message. *"message Daniel are you good for lunch Tuesday?"*
is stored as `type {{message}} into the composer` — the words never reach
disk. This is enforced mechanically, not by convention: anything the agent
typed that came from your words is slotted away, and any other literal must
pass a personal-data check (paths, emails, phone numbers, credentials, long
free text) or **the recipe is rejected rather than saved**. Learned recipes
stay on your machine; export re-runs the same gate.

**2. Selectors resolve live, never positionally.** Steps address controls by
label against the accessibility tree ("the button named Send"), matched on
whole-word boundaries so `Play` never matches `Start Playback`. A recipe
recorded when Send was the 5th control will never press "whatever is 5th"
later.

**When an app updates**, that second invariant turns a hazard into a routine
event. A renamed or moved control simply fails to resolve — ambiguity counts
as failure too — so replay **misses cleanly instead of clicking the wrong
thing**. Then: it aborts rather than improvising, falls back to the agent
(which can look at the new layout and still get your outcome), and counts the
miss. After repeated failures the recipe is quarantined so it stops costing
time, and a later successful agent run is recorded as a fresh recipe that
supersedes it. The system repairs itself instead of rotting.

Replay is **not** a trust bypass: every click is re-assessed against the risk
rulebook at replay time, because a control that was harmless when recorded may
be a "Send" today. Recipes that touch irreversible actions deliberately stop
short — the shipped Telegram recipe fills your message and leaves it for you
to send.

## iOS

Not built yet. The architecture is worked out and written down in
[docs/ios-architecture.md](docs/ios-architecture.md) — including the three
platform walls that shape it (a keyboard extension cannot access the
microphone, cannot start a recording in the background, and gets ~77 MB of
memory), the session model that works around them, and a two-tier on-device
ASR plan that lets someone dictate immediately while the Parakeet model
downloads in the background.

## Privacy

- **Fully offline** — No audio or text ever leaves your machine
- **No telemetry** — Zero analytics, tracking, or network calls (except one-time model downloads from Hugging Face)
- **No accounts** — No sign-up, no cloud, no server
- **Local storage only** — Settings and history stored via `electron-store` on disk

## License

[AGPL v3 + Commons Clause](./LICENSE) — Free for personal use. Commercial use prohibited. Forks must remain open source under the same license.
