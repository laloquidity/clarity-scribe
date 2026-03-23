# Changelog

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
