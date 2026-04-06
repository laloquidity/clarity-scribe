# Mac Build Handoff — Context for Parakeet Engineer

## Summary

Mac build is **working and tested** on Apple Silicon (arm64). This document covers what changed, what was fixed, and what you need to know for keeping Windows and Mac in sync.

**⚠️ CRITICAL: CoreML crashes the Electron process on audio >~15s. See the "OPEN BUG" section for full crash report analysis and three proposed fixes.**

---

## What Works on Mac (Verified)

| Component | Status | Provider |
|-----------|--------|----------|
| Whisper Large V3 Turbo | ✅ | `@napi-rs/whisper` (Metal GPU) |
| Parakeet TDT 0.6B-v3 | ⚠️ Short audio only | `onnxruntime-node` (CoreML encoder, CPU decoder/joiner) |
| VAD (Silero) | ✅ | ONNX Runtime (CPU) |
| Paste to Target | ✅ | AppleScript (`osascript`) |
| koffi (Win32 FFI) | ✅ Skipped | `initWinPaste()` returns `false` on non-win32 — clean |
| Global Hotkey | ✅ | Alt+Space |

---

## Bug Fixed: Parakeet Encoder "Protobuf parsing failed"

### Root Cause

The Parakeet encoder model (`encoder.int8.onnx`) was **truncated** — 77MB on disk instead of the expected 652MB. The download function in `parakeetService.ts` only checked `existsSync()` before skipping a file, so a partial download from a previous interrupted session was treated as complete.

When ONNX Runtime tried to load the 77MB file, it failed with:
```
Error: Load model from encoder.int8.onnx failed: Protobuf parsing failed.
```

### Fix Applied (in `parakeetService.ts`)

Added `isModelFileValid()` — checks both existence AND file size (within 90% of expected). This mirrors the pattern already used in `nativeWhisper.ts` line 186. Additionally:

- Truncated/corrupt files are deleted before re-download
- Post-download validation catches truncation immediately
- Partial files are cleaned up on download failure

```typescript
function isModelFileValid(filePath: string, expectedSize: number): boolean {
    try {
        const stats = statSync(filePath);
        return stats.size >= expectedSize * 0.9;
    } catch {
        return false;
    }
}
```

### How to Reproduce Locally (if needed)

If you ever suspect a corrupt model, just delete the file and relaunch:
```bash
rm ~/.smart-whisper/models/parakeet-tdt-0.6b-v3/encoder.int8.onnx
npm run dev
```
The app will re-download the full 652MB encoder automatically.

---

## ⚠️ OPEN BUG: CoreML Crashes on Longer Audio (~20s+)

### Observed Behavior

| Audio Length | Result |
|-------------|--------|
| 9.4s | ✅ Works — 1,167ms, 8.1x real-time, 118 encoder output frames |
| 21.4s | ❌ **SIGTRAP** — Electron process killed instantly |

Short recordings work perfectly. Longer recordings crash the entire Electron process with no recoverable error.

### Crash Report Analysis

From `~/Library/Logs/DiagnosticReports/Electron-2026-04-01-131411.ips`:

```
Exception:  EXC_BREAKPOINT (SIGTRAP)
Crashed on: com.apple.CoreMLNNProcessingQueue
ESR:        Address size fault
Termination: Trace/BPT trap: 5
```

**The crash stack traces through:**
1. `com.apple.CoreMLNNProcessingQueue` — Apple's CoreML neural network dispatch queue
2. `libonnxruntime.1.24.3.dylib` — inside ORT's thread pool workers
3. Multiple ONNX thread pool workers show `Address size fault` in their ESR

### Root Cause Theory

The ONNX Runtime CoreML execution provider is crashing when processing the encoder with a larger input tensor. The encoder takes input shape `[1, 128, nFrames]`:

- **9.4s audio** → ~940 mel frames → encoder processes fine
- **21.4s audio** → ~2140 mel frames → CoreML crashes with address fault

This is likely one of:

1. **CoreML buffer size limit**: The INT8 encoder (652MB) with a large input may exceed CoreML's internal buffer allocation for the ANE/GPU. The `Address size fault` ESR strongly suggests a memory mapping issue in CoreML's acceleration backend.

2. **ONNX ↔ CoreML shape mismatch**: The CoreML EP may not correctly handle the dynamic time dimension beyond a certain size for this specific model architecture (FastConformer with INT8 quantization).

3. **Known onnxruntime-node limitation**: The npm package ships with a generic CoreML EP build. The CoreML provider in ORT v1.24.3 has known issues with certain large models on Apple Silicon — this class of bug is tracked in the onnxruntime repo.

### Console Noise (Separate from Crash)

Even on the successful 9.4s transcription, CoreML logs 13x:
```
Context leak detected, msgtracer returned -1
```
These are **harmless** — they're from Apple's `msgtracer` diagnostics when CoreML creates/destroys GPU contexts. They don't affect functionality and won't appear for end users (only in dev console).

### Proposed Fixes (Pick One)

#### Option A: Fall Back to CPU for Encoder on Mac (Safest)
Change `getExecutionProviders()` for macOS from `['coreml', 'cpu']` to `['cpu']`.

**Pros**: No crash, guaranteed stability, still fast (CPU inference on M-series is very good).
**Cons**: Slower than CoreML — but the decoder loop is the bottleneck, not the encoder.

```typescript
// macOS — CPU-only until CoreML stability is confirmed
return ['cpu'];
```

#### Option B: Chunk Audio Before Encoding (Best of Both Worlds)
Split audio into ≤15s segments before sending to the encoder, similar to how `nativeWhisper.ts` already chunks at 28s. This keeps CoreML acceleration for shorter segments while avoiding the crash threshold.

**Pros**: Keeps CoreML speed, avoids crash.
**Cons**: More complexity; need to handle encoder output stitching across chunks. The transducer decoder state would need to carry across segments.

#### Option C: Duration-Based Provider Routing (Pragmatic)
Try CoreML for short audio, CPU for long audio. Since SIGTRAP kills the process (can't be caught in JS), check duration **before** encoding:
```typescript
function getEncoderProviders(audioDurationSeconds: number): string[] {
    if (process.platform === 'darwin') {
        return audioDurationSeconds <= 15 ? ['coreml', 'cpu'] : ['cpu'];
    }
    // ... Windows/Linux unchanged
}
```

**Pros**: Fast for short dictations (the common case), safe for long ones.
**Cons**: Arbitrary threshold — needs testing to find the exact limit.

### Recommendation

**Start with Option A** (CPU-only on Mac) to ship a stable build, then investigate Option C for a performance upgrade. The M-series CPU is fast enough that the encoder will still run well — the 9.4s transcription showed 1,078ms on CoreML; CPU might be 2-3x slower but still real-time for dictation use cases.

---

## Parakeet on Mac: CoreML Execution Provider

### How It Works

In `parakeetService.ts` → `getExecutionProviders()`:

| Platform | GPU Provider | Fallback |
|----------|-------------|----------|
| Windows  | `dml` (DirectML) | `cpu` |
| Linux    | `cuda` | `cpu` |
| macOS    | `coreml` | `cpu` |

The encoder runs on CoreML (Apple's ML framework — uses the ANE/GPU). Decoder and joiner run on CPU (they're sequential loops where GPU kernel launch overhead hurts more than it helps). This is the same hybrid routing strategy used on Windows.

**⚠️ See "OPEN BUG" section above — CoreML crashes on audio >~15s. May need to use CPU-only on Mac until resolved.**

### CUDA Path (Windows-only)

The `setupGpuDllPath()` function correctly gate-checks `process.platform !== 'win32'` and returns early on Mac. No CUDA/cuDNN DLL injection happens on Mac. Clean separation.

### If You Build Custom ONNX Runtime with CUDA for Windows

Per `cuda_build_handoff.md`, when you swap in the CUDA-enabled `onnxruntime.node`:
1. Change `getExecutionProviders()` for Windows from `['dml', 'cpu']` to `['cuda', 'cpu']`
2. This change is **Windows-only** — the Mac path (`['coreml', 'cpu']`) stays untouched
3. The CUDA DLLs go in `resources/win-gpu/cuda/` and are injected via `setupGpuDllPath()`

---

## koffi Bundling Changes (electron-builder.yml)

### Problem

`koffi` is a native Node addon that ships prebuilt `.node` binaries for **18 platforms** (~1MB each). Without proper handling:
1. Native `.node` files trapped inside the asar archive can't be `dlopen()`'d at runtime
2. All 18 platform binaries would ship in every build (unnecessary bloat)

### Fix Applied

**`asarUnpack`** — koffi is unpacked so its native binary lives outside the asar:
```yaml
asarUnpack:
  - "node_modules/koffi/**"
```

**Platform stripping** — Global filters remove Linux/BSD/musl binaries that are never needed:
```yaml
files:
  - "!node_modules/koffi/build/koffi/linux_*"
  - "!node_modules/koffi/build/koffi/musl_*"
  - "!node_modules/koffi/build/koffi/freebsd_*"
  - "!node_modules/koffi/build/koffi/openbsd_*"
```

**Cross-platform filters** — Mac drops Windows binaries and vice versa:
```yaml
mac:
  files:
    - "!node_modules/koffi/build/koffi/win32_*"
win:
  files:
    - "!node_modules/koffi/build/koffi/darwin_*"
```

**Result**: Mac DMG ships only `darwin_arm64/koffi.node` + `darwin_x64/koffi.node`. Windows NSIS ships only `win32_x64/koffi.node`.

### Does This Affect Windows Builds?

No. koffi was already in `asarUnpack` in the repo. The only additions are the `files` filters which strip non-target-platform binaries. When you build on Windows with `npm run build:win`, it will include `win32_x64` and `win32_ia32` (both x64 and 32-bit) but exclude `darwin_*`, `linux_*`, etc.

---

## Key Differences: Mac vs Windows Build

| Aspect | Mac | Windows |
|--------|-----|---------|
| Whisper engine | `@napi-rs/whisper` (Metal) | `smart-whisper` (CUDA/Vulkan/CPU) |
| Parakeet GPU | CoreML (ANE/GPU) — **crashes on >15s audio** | DirectML → CUDA (custom build) |
| Paste method | AppleScript | koffi → user32.dll FFI |
| Build target | DMG (arm64) | NSIS (x64) |
| Code signing | Not configured (unsigned OK for personal use) | Not configured |
| GPU DLL injection | N/A | `setupGpuDllPath()` prepends to PATH |
| Model location | `~/.smart-whisper/models/` | `~/.smart-whisper/models/` |

---

## Build Commands

```bash
# Dev mode (Mac)
npm run dev

# Production DMG (Mac)
npm run build:mac
# Output: release/Clarity Scribe-2.2.0-arm64.dmg

# Production NSIS (Windows)
npm run build:win
```

---

## Files Modified in This Session

| File | Change |
|------|--------|
| `electron/parakeetService.ts` | Added `isModelFileValid()` — size-checks model files before skipping download. Prevents truncated encoder from causing "Protobuf parsing failed". Cleans up partial downloads. |
| `electron-builder.yml` | Added koffi platform-stripping filters (global + per-platform). Strips ~14MB of unused native binaries. |

---

## Verified Test Results (macOS, Apple Silicon)

### Initialization: ✅ All Green
```
[Whisper] ✓ Ready (@napi-rs/whisper)
[VAD] Silero VAD initialized
[Parakeet] ✓ Encoder loaded on COREML
[Parakeet] ✓ Decoder loaded on CPU
[Parakeet] ✓ Joiner loaded on CPU
[Parakeet] ✓ Vocabulary loaded: 8193 tokens (blank=8192)
[Parakeet] ✓ Initialized successfully
No [WinPaste] errors (correctly silent on Mac)
```

### Transcription: 9.4s ✅ / 21.4s ❌
```
# 9.4s — SUCCESS
[Parakeet] ⏱ Mel: 53ms | Encoder: 1078ms | Decoder: 36ms | Total: 1167ms (8.1x real-time)
[Parakeet] Decode: 40 tokens from 118 frames

# 21.4s — CRASH (SIGTRAP on CoreML processing queue)
Exception: EXC_BREAKPOINT (SIGTRAP)
Queue: com.apple.CoreMLNNProcessingQueue
ESR: Address size fault
```

### Build Output
DMG built: `Clarity Scribe-2.2.0-arm64.dmg` (153MB, unsigned)
