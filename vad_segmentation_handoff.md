# Handoff: VAD Segmentation Performance Regression on Windows

## Problem

An 88-second transcription on Windows took **12,883ms (6.9x real-time)** instead of the expected ~1,500ms (~50x real-time). The encoder alone took 10,944ms.

## Root Cause

A recent Mac session introduced VAD-based audio segmentation for Parakeet TDT to work around a **CoreML crash** on macOS. CoreML's execution provider crashes (`EXC_BREAKPOINT / SIGTRAP`) when the INT8 FastConformer encoder processes audio longer than ~60 seconds. The crash is unrecoverable — it kills the Electron process.

The fix on Mac: split audio >60s into speech segments via Silero VAD, transcribe each independently, concatenate results.

**The problem**: the 60-second threshold was applied **globally**, not just on macOS. On Windows (DirectML) and Linux (CUDA), the encoder handles any audio length in a single pass with no crash.

### Why This Matters

The Parakeet encoder has **fixed overhead per call** (~500-700ms on an RTX 3090) regardless of audio length — GPU warmup, memory allocation, kernel dispatch. Running the encoder once on 88s of audio costs ~700ms. Running it 23 times (once per VAD segment) costs ~11,000ms. The audio processing itself is nearly free; the overhead dominates.

| Approach | Encoder Calls | Encoder Time | Total |
|----------|--------------|-------------|-------|
| Single-pass (88s) | 1 | ~700ms | ~1,500ms |
| VAD segments (23 × ~3.8s avg) | 23 | ~10,944ms | ~12,883ms |

## What Changed

**File**: `electron/parakeetService.ts`, inside `transcribeParakeet()`

**Before** (line 767):
```typescript
// Short audio: single-pass (proven to work up to 66s at 39x+ RTF)
if (durationSeconds <= 60) {
```

**After**:
```typescript
// Single-pass threshold: platform-dependent
// Windows/Linux: encoder handles any length fine (DML/CUDA don't crash)
// macOS: CoreML crashes on audio >~60s (SIGTRAP), so segment longer audio
const singlePassLimit = process.platform === 'darwin' ? 60 : Infinity;

if (durationSeconds <= singlePassLimit) {
```

**Effect**:
- **Windows/Linux**: Always single-pass, regardless of audio length. No VAD segmentation overhead.
- **macOS**: VAD segmentation for audio >60s (unchanged — CoreML crash workaround still needed).
- **No impact on short audio** (<60s) on any platform — was already single-pass.

## Verification

1. Restart dev server (`npm run dev`)
2. Record an 88+ second transcription on Windows
3. Confirm logs show **no** `Long audio — using VAD segmentation` message
4. Confirm encoder time is ~700-900ms (not ~11,000ms)
5. Confirm RTF is 40x+ (not 6-7x)

## Context for Future Work

If you ever need to add a single-pass limit on Windows (e.g., if DirectML develops its own crash on very long audio), change `Infinity` to the appropriate threshold in seconds. The VAD segmentation pipeline is fully implemented and works — it's just unnecessary overhead on Windows where the encoder doesn't crash.

The Mac CoreML crash is tracked in `mac_build_handoff.md` in the repo root. It's a known issue with ONNX Runtime's CoreML EP and large INT8 models. Until Apple or the ORT team fixes it, the 60s Mac threshold should stay.
