# Changelog

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
