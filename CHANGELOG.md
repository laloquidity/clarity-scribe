# Changelog

## v3.3.0 — MCP Server & Vocabulary Terms

### ✨ New Features

- **MCP server** — Scribe is now a [Model Context Protocol](https://modelcontextprotocol.io) tool provider: any MCP host (Claude Desktop, Claude Code, the Claude Agent SDK, MCP-speaking agent runtimes) can call `dictate` (start recording + await the final transcript), `start_dictation`/`stop_dictation`, `get_status`, and `get_recent_transcripts`. Implemented as a stdio bridge (`mcp/scribe-mcp.mjs`, official `@modelcontextprotocol/sdk`) over the Local API, with automatic port/token discovery from Scribe's config (env overrides supported). Packaged builds ship a self-contained bundle at `resources/scribe-mcp.mjs` (no node_modules needed). 8 tests run the bridge core against a live in-process Local API.
- **Vocabulary-only dictionary entries** — the Personal Dictionary's "What was written" field is now optional: leave it blank to add a pure vocabulary term (e.g. a name the decoder should recognize) without needing to know how the model misspells it. Such entries feed the decoder-level biasing; string replacement is a no-op for them. Corrections with a before→after pair work exactly as before — they remain the deterministic safety net behind the probabilistic decoder bias.

---

## v3.2.0 — Local API, Decoder-Level Vocabulary & Proper Icons

### ✨ New Features

- **Local API (programmable voice layer, opt-in)** — a loopback-only HTTP server (`127.0.0.1:5111`, bearer-token auth, default OFF) exposing an **SSE event stream** of live transcription (`partial` / `result` / `state` events) plus `POST /v1/record/start|stop`, `GET /v1/status`, and `GET /v1/history`. Scripts and agents can now drive dictation and consume transcripts in real time — the first brick of the voice-layer-for-agents direction. Settings shows the port and a copy-token button. 18 dedicated tests.
- **Decoder-level custom vocabulary (shallow fusion)** — Personal Dictionary terms are tokenized into the model's SentencePiece inventory and boosted inside the TDT greedy decode via a token-trie (boost applied to ids that extend a matched prefix). Custom terms are now *recognized* rather than only string-replaced afterwards. Inert when the dictionary is empty (golden decode bit-identical — regression-tested); applies to the ONNX engine (Windows/Linux + macOS fallback; the CoreML sidecar decodes in Swift and is not biased yet).
- **v3.1.0 Windows installer shipped** — `Clarity Scribe Setup 3.1.0.exe` on the [v3.1.0 release](https://github.com/laloquidity/clarity-scribe/releases/tag/v3.1.0); README download link updated.

### 🐛 Fixes

- **Windows tray icon** — the hidden-icons tray showed a garbled 16px blob; the tray now loads the real app logo from `icon.ico` (shipped as an extraResource, resolved via `process.resourcesPath` when packaged).
- **macOS menu-bar icon was blank** — the tray fed an SVG to `nativeImage.createFromBuffer`, which Electron cannot decode. Now uses the logo PNG at menu-bar size; dev runs also set the dock icon.

---

## v3.1.0 — Paste Reliability, Live Capsule & Dictation Stats

### 🐛 Fixes

- **macOS: live streaming never activated on quiet mics** — the segmenter's voice gate was a fixed RMS constant (0.006) calibrated on a boosted Windows mic; macOS applies no input boost, so speech could sit below the gate — no segment ever closed, no live preview appeared, and every dictation silently fell back to batch. The gate is now **adaptive**: it scales with the session's loudest window (clamped 0.0025–0.006), so it self-calibrates to any mic level. Finalize logs `peakRms`/`gate` for diagnosis.
- **macOS: sound cues were silent** — each cue created a fresh `AudioContext`, and CoreAudio output-stream startup takes longer than the 90 ms blip, so it finished before audio could flow. Cues now play through the app's already-warm shared AudioContext (resuming it if suspended).
- **macOS: window growth for the live capsule** — macOS refuses programmatic resizes on a `resizable: false` window; the resize handler now briefly lifts the flag (no-op on Windows).

- **False-success paste after switching apps mid-recording** — three compounding defects fixed: (1) Windows paste now **verifies the target window actually reached the foreground** before sending Ctrl+V (previously a denied `SetForegroundWindow` was ignored and the keystroke fired blind at whatever was focused, while the UI reported success); (2) the clipboard is **never cleared** after a paste — if it was empty beforehand the transcription stays on it as a safety net, so text can no longer be silently destroyed; (3) hotkey-stop now **retargets to the app under the user at stop time** (via instant FFI foreground query, off the hot path) instead of pasting at the recording-start app — switching from Claude to Telegram mid-dictation now pastes into Telegram. Widget-click stop keeps the pre-click capture (clicking the widget focuses Scribe itself). When focus can't be verified, the UI honestly reports "Copied" with the text on the clipboard.
- **Stray "." / "," after line-break commands (Smart formatting)** — "…one more thing. New line. I added…" produced `thing.\n. I added`: the ASR's punctuation attached to the *spoken command* survived the replacement. Line-break commands now absorb trailing punctuation (sentence-final punctuation before the command is kept).

### ✨ New Features

- **Per-dictation stats in history** — each history row shows the **audio length**, the **transcription + paste time** (stop → text on screen), and the **speed vs real time**, now with inline labels on their own line: `45.3s audio · 396ms transcribe · 114× real-time`. Entries recorded before this change simply omit the figures.
- **Expanding live-transcript capsule** — the live preview is no longer a one-line tail: while dictating, a highlighted transcript box grows under the widget bar as segments complete (window resizes with it), capped at ~5 lines with the newest words pinned into view. Works with the history/settings panel open (the window grows by the same amount on top), and collapses when the text is pasted.
- **Thousands separators (Smart formatting)** — `$50000000` → `$50,000,000` (currency grouped from 4 digits; bare integers from 6 digits, so years/PINs/ZIPs/spoken codes like `12345` stay untouched; fractions never grouped). Applies both to numbers ITN builds from words and digits the model emits directly.

## v3.0.0 — Live Streaming Transcription & Windows Engine Tune-Up

### ⚡ Performance

- **Live streaming transcription (transcribe-while-recording)** — Speech segments are now transcribed **while you're still talking**: the renderer streams raw audio to the main process, an RMS segmenter closes segments at natural pauses (soft-cap split at the quietest window for no-pause talkers, hard cap 28 s), and each segment runs through Parakeet immediately. At stop, only the small tail remains, so **stop→text is ~100–380 ms regardless of recording length** (previously the entire clip was processed after stop — 1 s+ for a minute of audio). Fully fault-tolerant: any streaming failure falls back to the classic full-buffer batch path, which is preserved untouched. Default on ("Live transcription" toggle); Parakeet engine only.

- **Sparse mel filterbank (all platforms)** — Each of the 128 mel filters is only nonzero over a narrow bin band; the mel matmul now skips guaranteed-zero terms. **2.9× faster mel** (337 ms → 118 ms for 60 s of audio on the bench machine), bit-identical output (verified by the golden regression tests).

- **Parallel segment decode (long audio)** — The VAD-batched path now decodes all segments in a batch concurrently instead of serially (ONNX Runtime sessions are safe for concurrent `run()`); long-recording decode wall-time drops proportionally to segment count.

- **Faster stop path** — The fixed 50 ms yield before snapshotting the recording was replaced with an ordered flush handshake with the AudioWorklet (typically <5 ms, 100 ms safety timeout).

- **Windows engine A/B verdict (RTX 3090, documented)** — Measured on real hardware: the INT8 encoder on DirectML runs 60 s of audio in ~420 ms (encoder-only ~142× RT) — the encoder was *not* the Windows bottleneck; mel + the per-frame decode loop were, and both are addressed above. FP16 and FP32 encoder variants were benchmarked on DML (FP16: ~15% faster than INT8, 2× the download) and **rejected**; INT8 stays. CUDA EP remains unavailable in `onnxruntime-node` on Windows (Linux-only per the official support matrix), so DirectML stays the GPU path with its documented mandatory settings.

### ✨ New Features

- **Live preview in the widget** — While recording, the widget shows the transcript so far (tail of the text), updating as each segment completes.
- **Spoken punctuation (opt-in)** — Say "comma", "period", "question mark", "new line", "new paragraph", "hyphen", "at sign" — and context-aware "dot" that only joins in URLs ("google dot com" → "google.com", prose "dot" untouched). Token-walk state machine, unit-tested. Default off.
- **Sound cues (opt-in)** — Subtle generated blips on recording start/stop (no audio assets). Default off.

### 🧱 Internal

- New `electron/streamingTranscriber.ts` — session management, RMS segmenter with quietest-window soft-cap splitting, serialized segment queue, partial-transcript events; unit-tested without models (10 tests). New IPC: `stream-start` / `stream-chunk` / `stream-abort` + `transcription-partial` event.
- `test/streaming.test.ts` (segmenter + session lifecycle) and `test/spoken-punctuation.test.ts` (8 cases) added; suite is now 71 tests.

---

## v2.9.0 — CoreML ANE Engine, Decoder Caching & Smart Formatting

### ⚡ Performance

- **CoreML Apple Neural Engine engine (macOS / Apple Silicon)** — A native Swift sidecar (`native/parakeet-sidecar/`) runs Parakeet TDT 0.6B v3 on the Apple Neural Engine via CoreML, becoming the **default** Parakeet engine on Apple Silicon. The encoder runs in **~30 ms** (vs ~114 ms on the ONNX-CPU path for the same 7.3 s clip); end-to-end **~118× real-time vs ~45× for the CPU path**. It chunks long audio internally (15 s windows, 2 s overlap), stays warm across the session, and falls back automatically to ONNX-CPU → Whisper. CoreML models (~470 MB) download on demand from the `parakeet-coreml-models` release. Decode algorithm + ANE memory layout ported from [FluidInference/FluidAudio](https://github.com/FluidInference/FluidAudio) (Apache-2.0). Toggle via `coreMLEnabled` (default on). `npm run dev` builds the sidecar automatically on macOS.

- **Decoder-output caching (all platforms)** — The TDT decoder no longer re-runs the prediction LSTM on blank (silence) frames where its inputs are unchanged. It computes the decoder output once and refreshes it only after a non-blank emission, matching the sherpa-onnx / FluidAudio reference. Decoder invocations now scale with emitted tokens rather than frames (e.g. 44 vs 57 on the test clip; larger savings on speech with more silence). Output is bit-identical, verified by a golden regression test. Coexists with the v2.8 DirectML decoder-collapse recovery.

- **Mel frontend + decode-loop efficiency (all platforms)** — The mel filterbank and Hann window are memoized at module scope (were rebuilt per call), and per-frame FFT/encoder-slice/decoder-target buffers are reused instead of reallocated thousands of times per clip. Byte-identical output. The decoder/joiner sessions run single-threaded with full graph optimization; the v2.7 Windows DirectML encoder settings (`basic` graph opt, mem-pattern off, sequential) are preserved.

- **Engine warmup** — A one-time warmup pass on init removes the cold-start stall on the first dictation.

### ✨ New Features

- **Inverse Text Normalization (ITN / "Smart formatting")** — Optional, fully-offline conversion of spoken forms to written forms: numbers (`twenty three` → `23`), currency (`five dollars and fifty cents` → `$5.50`), times (`two thirty pm` → `2:30 PM`), dates, ordinals, and explicit punctuation commands (`comma`, `period`, `new line`, …). Conservative and idempotent. Strictly opt-in via the **Smart formatting** toggle (default off); when off, output is unchanged.

### 🧱 Internal

- The Parakeet DSP + TDT decode were extracted into `electron/parakeetCore.ts` (no Electron dependency) so `parakeetService.ts` delegates to one canonical, unit-tested implementation. The v2.8 try-fast-fallback + batched encoder inference path is unchanged on the ONNX engine.
- **Regression test harness (vitest)** — `npm test` locks transcription output (golden text + mel hash), drives the real CoreML sidecar in an integration test, and covers 51 ITN cases. `BENCH=1` runs the ONNX-vs-ANE benchmark.

---

## v2.8.0 — Parakeet Long-Recording Optimization (2026-05-20)

### ⚡ Performance

- **Try-fast-fallback transcription architecture (Windows)** — Parakeet now always attempts single-pass encoding first for maximum speed (~40-48x real-time). After completion, the decoder coverage is checked: if the last emitted token covers less than 85% of the audio (indicating DirectML encoder tail corruption), the recording is automatically retried using VAD-based batched encoding. This gives single-pass speed on the vast majority of recordings while guaranteeing complete transcription on the rare cases where the encoder output degrades.

- **Batched encoder inference for segmented audio** — When the fallback triggers (or for audio >120s), VAD segments are now processed in batched encoder calls (up to 8 segments per GPU call), matching the [onnx-asr reference implementation](https://github.com/istupakov/onnx-asr/blob/main/src/onnx_asr/vad.py#L114-L124). This amortizes the ~300ms DirectML per-call GPU overhead across all segments in the batch, instead of paying it once per segment.

### 🔧 Technical Details

- `transducerGreedyDecode()` now returns coverage metadata (`lastTokenFrame`, `totalFrames`) alongside the transcribed text, enabling truncation detection without additional computation.
- Single-pass limit raised from 20s to 120s on Windows (macOS retains 60s hard limit for CoreML SIGTRAP prevention). The coverage check replaces the conservative fixed threshold.
- All changes are Windows-only. macOS behavior is completely unchanged.

---

## v2.7.0 — Parakeet DirectML Stability Fix (2026-05-11)

### 🐛 Bug Fixes

- **Parakeet systematic decoder collapse on Windows (DirectML)** — Identified and fixed the root cause of Parakeet producing near-zero transcriptions on Windows after multiple recordings. The encoder ONNX session was missing two settings that ONNX Runtime's DirectML execution provider **requires** per its official documentation — and that the sherpa-onnx reference implementation ([`session.cc:311-312`](https://github.com/k2-fsa/sherpa-onnx/blob/master/sherpa-onnx/csrc/session.cc)) sets unconditionally:
  - **`enableMemPattern: false`** — Without this, ORT's memory pattern optimization pre-caches GPU allocation layouts from the first inference call and reuses them on subsequent calls. DirectML manages its own GPU memory pool with device-specific alignment, so stale cached layouts produce silently corrupted encoder output tensors on later invocations with different audio lengths. The corruption was non-deterministic (depended on prior call history), explaining why the bug was intermittent and worsened over multiple recordings in the same session.
  - **`executionMode: 'sequential'`** — DirectML does not support parallel operator execution; the default parallel mode caused undefined behavior on the GPU.
  - **`graphOptimizationLevel: 'basic'`** (was `'all'`) — Aggressive graph optimization on an INT8 quantized model with DirectML risks incorrect QDQ (Quantize/Dequantize) operator fusion, compounding precision errors. Reduced to `'basic'` on Windows only; macOS/Linux keep `'all'`.

  **Before:** 10 decoder collapses in 58s (10 LSTM state resets), 82.5% blank rate, decoder stopped at 15.3s out of 58.1s, 535 unused tail frames — transcription truncated to ~25% of audio.
  **After:** 0–1 decoder collapses on typical recordings, 25.7% blank rate, last token at 65.1s out of 65.4s, 3 unused tail frames — complete transcription.

  All changes are Windows-only (`process.platform === 'win32'`). macOS and Linux sessions are completely unchanged.

---

## v2.6.0 — Personal Dictionary, No-Audio Auto-Stop & Whisper Hallucination Guard (2026-04-22)

### 🚀 New Features

- **Personal Dictionary** — Add custom word corrections that apply automatically to every transcription. Maps "what was written" → "what you meant" (e.g. `Chat GPT` → `ChatGPT`). Accessible via the new Book icon in the widget bar, which opens a full CRUD panel with Add, Edit, batch Delete, Select All, Export JSON, and Import JSON. Each entry auto-generates ~12 case/hyphen/space variants using the built-in variant engine so corrections match regardless of how the ASR chose to capitalize or hyphenate the word. Persisted to disk via `electron-store` with a migration guard for any previously stored legacy formats. Dictionary corrections are applied in the post-processing pipeline after filler/stutter removal and before final capitalization.

- **No-Audio Auto-Stop** — If a recording exceeds 30 seconds and more than 80% of that time contains no meaningful audio (energy below the frequency-domain threshold), the recording automatically stops and the widget displays "No audio detected — Stopped recording". Uses the same AnalyserNode frequency-domain approach as the existing silence detection (`avg > 10` threshold), sampled 5× per second for ~150 data points over the 30-second window. Handles wrong mic selection, muted mic, and "forgot to stop" scenarios. Fully independent of the existing per-pause silence detection — both features coexist without conflict.

### 🐛 Bug Fixes

- **Whisper "Thank you" hallucination suppression** — When Parakeet returns empty on a clip shorter than 2 seconds and Whisper lazy-loads cold for the fallback, Whisper would frequently hallucinate "Thank you." as its entire output. Added a targeted guard in `nativeWhisper.ts` that detects this exact code path (`parakeetWasEmpty && durationSeconds < 2`) and suppresses the output if the entire result matches a known thank-you phrase variant. Genuine "thank you" at the end of a real utterance is unaffected because it would appear in a longer clip alongside other transcribed content.

- **Non-ASCII script paste (Arabic, Chinese, Hebrew, Cyrillic, etc.)** — The punctuation guard introduced in v2.6.0 used `/[a-zA-Z0-9]/` to reject lone-punctuation noise from Parakeet. This inadvertently silently dropped any transcription containing zero ASCII characters — meaning Arabic, Chinese, Hebrew, Cyrillic, and all other non-Latin scripts were never pasted. Fixed by switching to the Unicode-aware `/\p{L}|\p{N}/u` which matches any letter or digit in any script.

- **macOS Continuity Camera AVFoundation warning** — Added `NSCameraUseContinuityCameraDeviceType: true` to `extendInfo` in `electron-builder.yml` so it is injected into the app's `Info.plist` at build time. Eliminates the `WARNING: Add NSCameraUseContinuityCameraDeviceType to your Info.plist` log noise emitted by Electron's Plugin helper process when AVFoundation enumerates audio devices.

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
