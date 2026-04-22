# Changelog

## v2.6.0 — Personal Dictionary, No-Audio Auto-Stop & Whisper Hallucination Guard (2026-04-22)

### 🚀 New Features

- **Personal Dictionary** — Add custom word corrections that apply automatically to every transcription. Maps "what was written" → "what you meant" (e.g. `Chat GPT` → `ChatGPT`). Accessible via the new Book icon in the widget bar, which opens a full CRUD panel with Add, Edit, batch Delete, Select All, Export JSON, and Import JSON. Each entry auto-generates ~12 case/hyphen/space variants using the built-in variant engine so corrections match regardless of how the ASR chose to capitalize or hyphenate the word. Persisted to disk via `electron-store` with a migration guard for any previously stored legacy formats. Dictionary corrections are applied in the post-processing pipeline after filler/stutter removal and before final capitalization.

- **No-Audio Auto-Stop** — If a recording exceeds 30 seconds and more than 80% of that time contains no meaningful audio (energy below the frequency-domain threshold), the recording automatically stops and the widget displays "No audio detected — Stopped recording". Uses the same AnalyserNode frequency-domain approach as the existing silence detection (`avg > 10` threshold), sampled 5× per second for ~150 data points over the 30-second window. Handles wrong mic selection, muted mic, and "forgot to stop" scenarios. Fully independent of the existing per-pause silence detection — both features coexist without conflict.

### 🐛 Bug Fixes

- **Whisper "Thank you" hallucination suppression** — When Parakeet returns empty on a clip shorter than 2 seconds and Whisper lazy-loads cold for the fallback, Whisper would frequently hallucinate "Thank you." as its entire output. Added a targeted guard in `nativeWhisper.ts` that detects this exact code path (`parakeetWasEmpty && durationSeconds < 2`) and suppresses the output if the entire result matches a known thank-you phrase variant. Genuine "thank you" at the end of a real utterance is unaffected because it would appear in a longer clip alongside other transcribed content.

---

## v2.5.0 — Feature Extraction Hardening & Post-Processing Fixes (2026-04-12)

### 🛡️ Quality Improvements

- **Feature Extraction Pipeline — 6 Bugs Fixed** — Line-by-line audit against the [onnx-asr `NemoPreprocessorNumpy`](https://github.com/istupakov/onnx-asr/blob/main/src/onnx_asr/preprocessors/numpy_preprocessor.py) reference implementation revealed six deviations from the model's training-time feature extraction. All six corrected:
  1. **Missing preemphasis** — Added 0.97 first-order high-pass filter (`y[n] = x[n] - 0.97·x[n-1]`). Boosts consonant energy; without it every frame had wrong spectral tilt
  2. **Wrong mel filterbank scale** — Replaced HTK mel scale (20–7600 Hz) with Slaney mel scale + Slaney area normalization (0–8000 Hz). Every one of 128 mel channels was mapping to the wrong frequency band
  3. **Wrong window type** — Replaced periodic Hann with symmetric Hann (`cos(2πn/(N-1))`) centered in a 512-sample FFT frame (56 zero-padded samples each side), matching `np.hanning(400)` in the reference
  4. **Wrong zero-padding** — Replaced reflect-padding by `windowSize/2` with zero-padding by `n_fft/2 = 256` on each side, matching `np.pad(..., n_fft // 2)` in the reference
  5. **Wrong CMVN variance** — Replaced population variance (`/ N`) with Bessel's correction (`/ (N-1)`), with frame masking that excludes STFT edge-padding frames from statistics and zeros non-valid frames post-normalization
  6. **Wrong log guard** — Corrected `2^-23` to `2^-24 ≈ 5.96e-8`, matching the NeMo reference exactly
- **Correct encoder length tensor** — Encoder input length now uses `validFrames = audio.length // hopLength` (matching reference `features_lens` calculation) instead of total spectrogram frames including edge-padding
- **Removed replication padding hack** — Artificial 50-frame tail replication removed from `transcribeSinglePass`. Was distorting encoder attention on the final tokens; VAD `speechPadMs` provides natural trailing context

### 🐛 Bug Fixes

- **Token-to-text subword space handling** — Ported [onnx-asr `DECODE_SPACE_PATTERN`](https://github.com/istupakov/onnx-asr/blob/main/src/onnx_asr/asr.py#L113) regex to fix spaces being incorrectly inserted at subword boundaries. Spaces are now stripped before non-word-boundaries and preserved only at real word boundaries
- **Contraction corruption** — `FALSE_START_PATTERN` (stutter removal) was matching single-character fragments from contractions: `'s` + `say` → `'say`, producing output like `let'say`. Fixed by requiring minimum 2-character fragment length
- **Rogue mid-sentence capitalization** — Removed per-segment force-capitalization from `tokensToText()`. The model produces correctly-cased output from training; force-capitalizing each VAD segment caused spurious capitals after every thinking pause (e.g. `toggle the question Open`, `Into A toggle list`). `cleanTranscription` handles first-letter capitalization of the final joined output

---

## v2.4.0 — Hold-to-Talk & Post-Processing (2026-04-06)

### 🚀 New Features

- **Hold-to-Talk Mode** — New recording mode: hold down a key to record, release to stop and transcribe. Choose between "Tap to Toggle" (existing behavior) and "Hold to Talk" in Settings. Uses [`uiohook-napi`](https://github.com/nickhardwareiot/uiohook-napi) for cross-platform global key-down/key-up detection (`SetWindowsHookEx` on Windows, `CGEventTap` on macOS)
- **Recording Mode Selector** — Apple-style segmented control in Settings for switching between modes. Shortcut picker adapts contextually: modifier combos for toggle mode, single function keys (F5–F12) for hold mode
- **Filler Word Removal** — Post-processing pipeline strips filled pauses (um, uh, ah, er, like, so) from transcriptions while preserving natural discourse markers and hedge words
- **Trailing Space** — All transcriptions automatically end with a trailing space so consecutive dictations concatenate naturally

### 🐛 Bug Fixes

- **TDT Decoder Truncation** — Fixed intermittent transcription truncation by aligning decoder to the [sherpa-onnx `DecodeOneTDT`](https://github.com/k2-fsa/sherpa-onnx) reference. Three bugs: (1) frame advancement used `else-if` instead of three separate `if`-blocks, causing blank-fallback checks to be skipped; (2) `maxTokensPerFrame` was 10 instead of the reference's 5; (3) initial skip was 1 instead of 0
- **Window restore on recording** — App no longer forces itself to the foreground when starting/stopping recording while minimized
- **"INITIALIZING" status race condition** — Widget now correctly shows "Ready" after engine initialization instead of remaining stuck on "INITIALIZING"
- **Transparent corner artifacts** — Resolved via `thickFrame: false` and CSS border-radius propagation on Windows

### ⚡ Improvements

- **Silence detection disabled in Hold mode** — Redundant when the user controls stop via key release
- **Auto-stop silence setting hidden in Hold mode** — Cleaner settings UI when the option doesn't apply
- **Audio pipeline cleanup** — Removed `trimSilence` and `normalizeAudio` preprocessing to prevent word-initial consonant clipping and noise amplification. Pipeline now only resamples 48kHz→16kHz
- **VAD tuning** — Increased `minSilenceDurationMs` from 500ms to 700ms to reduce over-segmentation

### 📦 Dependencies

- Added `uiohook-napi` ^1.5.4 — Cross-platform global keyboard hook (prebuilt binaries, no runtime compilation)

---

## v2.3.0 — Long-Form Parakeet Stabilization (2026-04-03)

### 🐛 Bug Fixes

- **SIGTRAP crash on long audio** — 8+ minute recordings no longer crash the app. Root cause: Silero VAD v5 context prepend was missing (input should be `[1, 576]` = 64 context + 512 audio, we sent `[1, 512]`), making VAD non-functional and forcing the encoder to process minutes of audio in a single O(n²) attention pass
- **Transcription truncation** — Removed artificial `maxSkip=3` cap in TDT decoder that caused incomplete output on longer recordings. No such cap exists in any reference implementation
- **Windows performance regression** — VAD segmentation was being applied globally; now macOS-only. Windows/Linux use single-pass for any audio length (no encoder overhead)

### ⚡ Improvements

- **VAD-based segmentation for Parakeet (macOS)** — Long audio (>60s) is split at silence boundaries via Silero VAD, with each segment transcribed independently and results concatenated. Short audio (≤60s) still uses zero-overhead single-pass
- **Segment merging** — Ported [onnx-asr `_merge_segments`](https://github.com/istupakov/onnx-asr/blob/main/src/onnx_asr/vad.py#L59-L86) logic: adjacent segments merge up to 20s, drops segments <250ms, hysteresis threshold (0.35 off / 0.5 on). Produces ~11 segments from 90s (was 25)
- **TDT decoder aligned to production reference** — Matched [onnx-asr](https://github.com/istupakov/onnx-asr) implementation: `maxTokensPerFrame` 5→10, uncapped duration predictions, corrected elif pattern. A/B tested: no quality difference
- **Silero VAD v5 API** — Updated from v4 API (`h`, `c` state tensors) to v5 (`state` tensor `[2, 1, 128]` + 64-sample context prepend)

### 📊 Benchmarks (macOS Apple Silicon)

| Audio | Time | RTF | Method |
|-------|------|-----|--------|
| 4.2s | 111ms | 37.4x | Single-pass |
| 15.9s | 404ms | 39.2x | Single-pass |
| 90.0s | 1,963ms | 45.8x | 11 VAD segments |
| **486.4s** | **11,073ms** | **43.9x** | **85 VAD segments** |

---

## v2.1.0 — Parakeet GPU Acceleration (2026-03-27)

### 🚀 New Features

- **Parakeet TDT GPU Acceleration** — Tiered GPU provider strategy for Parakeet encoder:
  - CUDA → DirectML → CPU on Windows (20–40x real-time on GPU)
  - CoreML → CPU on macOS Apple Silicon
  - Verified 29x real-time on RTX 3090 via DirectML
- **Self-Hosted Parakeet Models** — Parakeet ONNX models now served from GitHub Releases (`laloquidity/clarity-scribe/releases/tag/parakeet-models`) for reliable, consistent downloads

### 🛡️ Quality Improvements

- **Corrected TDT Greedy Decode** — Rewrote transducer decode to match sherpa-onnx reference implementation:
  - Duration skip now applies to both blank and non-blank tokens (fixes truncated words)
  - Added `max_tokens_per_frame=5` safety limit
  - Proper blank+skip=0 handling (force advance 1 frame)
- **NeMo-Standard Mel Spectrogram** — Matched sherpa-onnx/Kaldi feature extraction:
  - No dithering, no preemphasis (matching Kaldi defaults)
  - Correct filterbank: `low_freq=20`, `high_freq=7600`
  - Reflect padding (`snip_edges=false`)
  - Per-feature normalization (zero mean, unit variance)
- **Post-Processing** — Clean transcription output:
  - Strip leading silence artifacts (dots from noise)
  - Collapse multiple periods into single period
  - Auto-append sentence-ending period when missing
  - Capitalize first letter

---

## v2.0.0 — Frontier-Lab Transcription Pipeline (2026-03-23)

### 🚀 New Features

- **Dual Transcription Engine** — Added NVIDIA Parakeet TDT 0.6B-v3 alongside Whisper Large V3 Turbo
  - Parakeet: 6.05% WER (English), 25 European languages, ~20x real-time on CPU
  - Auto-selection: Parakeet for supported languages, Whisper for all others
  - INT8-quantized ONNX model (~890MB), downloaded on first use
- **Engine Settings** — New "Engine" dropdown in Settings: Auto / Whisper Only / Parakeet TDT Only
- **Silero VAD Segmentation** — Intelligent voice activity detection via ONNX Runtime
  - Splits audio at natural speech pauses instead of arbitrary 28s intervals
  - Merges short segments (<300ms gaps), splits long ones at quietest points
  - Falls back to fixed chunking if VAD unavailable
- **Transcription Progress** — Widget shows "Processing 43%..." during multi-chunk transcription

### 🛡️ Quality Improvements

- **Hallucination Detection & Retry** — Detects when Whisper loops the same phrase (4+ words repeated 3+ times), retries with temperature=0.2, cleans output if both attempts fail
- **Context Prompting** — Last sentence of each chunk is passed as `initial_prompt` to the next chunk, maintaining coherent punctuation, casing, and flow across boundaries
- **Overlap Deduplication** — Removes duplicate words at chunk boundaries caused by 1s audio overlap (compares last 15 words of chunk N with first words of chunk N+1)

### 📦 Dependencies

- Added `onnxruntime-node` for ONNX Runtime inference (Silero VAD + Parakeet TDT)

---

## v1.4.0 — Hardened Chunking (2026-03-23)

### 🛡️ Quality Improvements

- **Hallucination Detection & Retry** — First implementation of hallucination detection
- **Context Prompting** — Cross-chunk context prompting for coherent transcription
- **Overlap Deduplication** — Chunk boundary dedup for clean output

---

## v1.3.1 — Long Recording Fix (2026-03-22)

### 🐛 Bug Fixes

- Fixed custom hotkey capture UX — Customize button always available, can re-capture hotkey
- Fixed long recordings (2+ minutes) producing repeated sentences by implementing 28s chunking

---

## v1.3.0 — Hotkey Overhaul (2026-03-22)

### 🚀 Features

- Hotkey settings redesign with presets dropdown + Customize button
- Preset hotkeys: Alt+Space, Ctrl+Shift+Space, Ctrl+Shift+R, F8
- Custom hotkey capture with 3-key combo support

---

## v1.2.0 — Initial Release (2026-03-21)

### 🚀 Features

- GPU-accelerated transcription (CUDA / Vulkan / CPU fallback on Windows, Metal on macOS)
- Global hotkey toggle recording (Alt+Space / Option+Space)
- Paste-to-target with active app detection
- Transcription history with timestamped entries
- Always-on-top floating widget with waveform visualization
- Auto silence detection (2s, 3s, 5s, 10s)
- Launch on login toggle
- Multi-language support (100+ via Whisper)
- First-run setup wizard with model download + permissions
