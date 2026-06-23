# parakeet-sidecar

A native macOS (Apple Silicon) Swift sidecar that runs **NVIDIA Parakeet TDT 0.6B v3**
speech recognition on the **Apple Neural Engine** via CoreML. It is a long-lived
process that Scribe's Electron app spawns once, keeps warm, and feeds many
transcription requests over a simple line protocol.

On an M-series Mac the encoder runs on the ANE in **~30 ms** for ~7.3 s of audio,
versus ~1400 ms for ~23 s on the previous ONNX-Runtime-CPU path.

## Building

Requires Xcode 16+ / Swift 6 and macOS 14+ (built and tested on macOS 26.5,
Swift 6.3, Apple Silicon arm64).

```sh
cd native/parakeet-sidecar
swift build -c release
# binary at: .build/release/parakeet-sidecar
```

## Models

The sidecar loads four compiled CoreML models plus a vocabulary file from a model
directory. The directory is chosen by the `SCRIBE_PARAKEET_MODELS` environment
variable, defaulting to `/tmp/coreml-models/parakeet-tdt-0.6b-v3`.

Required files in that directory:

| File | Role | Compute units |
|------|------|---------------|
| `Preprocessor.mlmodelc` | Mel-spectrogram frontend | `.cpuOnly` |
| `Encoder.mlmodelc`      | FastConformer encoder    | `.cpuAndNeuralEngine` |
| `Decoder.mlmodelc`      | RNN-T prediction LSTM    | `.cpuAndNeuralEngine` |
| `JointDecision.mlmodelc`| Joint net (emits token + duration decision) | `.cpuAndNeuralEngine` |
| `parakeet_vocab.json`   | `id -> token` map (▁ = space; blank id = 8192) | — |

`parakeet_v3_vocab.json` is accepted as a fallback name for the vocabulary.

The preprocessor is pinned to CPU and the rest run on the ANE, matching
FluidAudio's configuration. `MLModelConfiguration.allowLowPrecisionAccumulationOnGPU`
is enabled.

### Model I/O (verified from each `model.mil` / `metadata.json`)

- **Preprocessor**: in `audio_signal` f32 `[1, 240000]`, `audio_length` i32 `[1]`
  → out `mel` f32 `[1, 128, 1501]`, `mel_length` i32 `[1]`
- **Encoder**: in `mel` `[1, 128, 1501]`, `mel_length` `[1]`
  → out `encoder` f32 `[1, 1024, 188]`, `encoder_length` i32 `[1]`
- **Decoder**: in `targets` i32 `[1, 1]`, `target_length` i32 `[1]`,
  `h_in`/`c_in` f32 `[2, 1, 640]`
  → out `decoder` f32 `[1, 640, 1]`, `h_out`/`c_out` f32 `[2, 1, 640]`
- **JointDecision**: in `encoder_step` f32 `[1, 1024, 1]`, `decoder_step` f32 `[1, 640, 1]`
  → out `token_id` i32 `[1, 1, 1]`, `token_prob` f32 `[1, 1, 1]`, `duration` i32 `[1, 1, 1]`

The JointDecision model performs the token argmax (over ids `0..8192`, blank =
8192) **and** the duration argmax (5 bins → frame advances `[0,1,2,3,4]`)
internally, so the decode loop just consumes its three scalar outputs.

## Protocol

Newline-delimited JSON over stdin/stdout — one request per line, one response
line per request. stdout carries **only** JSON responses; human-readable logs go
to stderr. The process exits cleanly (code 0) on stdin EOF.

### Transcribe request

```json
{"id": "<string>", "audioPath": "<path to raw little-endian float32 mono 16kHz>"}
```

Response:

```json
{"id": "<string>",
 "text": "<transcript>",
 "tokens": [<int>, ...],
 "ms": {"mel": N, "encoder": N, "decode": N, "total": N}}
```

`tokens` are the raw emitted token ids (before detokenization). `ms` are
per-stage wall-clock timings in milliseconds.

### Health / warmup

```json
{"cmd": "ready"}
```

Response: `{"ready": true}`.

### Errors

Per-request failures (bad JSON, missing file, etc.) return a line like
`{"id": "<id>", "error": "<message>"}` and do **not** terminate the process.

### Example

```sh
SCRIBE_PARAKEET_MODELS=/tmp/coreml-models/parakeet-tdt-0.6b-v3 \
printf '{"cmd":"ready"}\n{"id":"t1","audioPath":"/path/to/audio.f32"}\n' \
  | .build/release/parakeet-sidecar
```

## Audio format

Input audio must be **raw little-endian float32, mono, 16 kHz** (no header). The
Electron side is responsible for decoding/resampling to that format before
writing the temp file referenced by `audioPath`.

## Pipeline

1. Read f32 samples from `audioPath`.
2. Chunk into ≤15 s windows (238 720-sample chunks, 2 s overlap, 80 ms left
   context prepended to non-first chunks). Audio under ~14.9 s is a single chunk.
3. Preprocessor (CPU) → mel.
4. Encoder (ANE) → encoder features.
5. TDT greedy decode (Decoder + JointDecision on ANE): blank inner-loop, decoder
   output caching across blank frames, duration-bin frame jumps, force-blank
   anti-stall, last-chunk finalization.
6. Merge per-chunk token windows (contiguous/LCS overlap alignment).
7. Detokenize: concatenate vocab strings, replace `▁` (U+2581) with space, trim.

### Verified smoke test

Fixture: `test/fixtures/sample-16k.f32` (~7.3 s, 117 222 samples).

Output:

```
The quick brown fox jumps over the lazy dog. Testing 12345. Speech recognition speed and accuracy matter.
```

Warm timings (M-series, after first-load ANE compile): mel ~1 ms, **encoder
~27–32 ms (ANE)**, decode ~33–36 ms, total ~62–69 ms.

## Attribution

The TDT greedy decode algorithm, chunking strategy, ANE-aligned memory helpers,
and the chunk token merger are ported from
[**FluidInference/FluidAudio**](https://github.com/FluidInference/FluidAudio)
(Apache License 2.0). The algorithm was reimplemented here for Scribe's protocol;
FluidAudio is **not** a dependency. See `NOTICE` for the license attribution.
```
