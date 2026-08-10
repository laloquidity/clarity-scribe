/**
 * Does padding the encoder input to the ONE fixed shape change the transcript?
 *
 * WHY IT MATTERS. Established by direct experiment (RTX 3090, DirectML): the
 * DirectML provider compiles its fused graph for the FIRST input shape a
 * session runs and re-JITs on every run whose shape differs — two sessions
 * interleaving shapes 600/1000 each kept ONLY their warmup shape fast (~62ms
 * vs ~410ms), exactly inverted between the sessions. Every dictation used to
 * be a unique shape, so every dictation paid the recompile.
 *
 * The fix pads all inputs to FIXED_ENCODER_FRAMES. That is only legitimate if
 * padding does NOT change what the model outputs — and the fill value is the
 * subtle part: zero-fill and edge-replication both shifted punctuation; the
 * per-bin silence floor reproduces the unpadded transcript exactly. This test
 * guards that on real audio through the real pipeline.
 *
 * Opt-in (RUN_E2E=1): loads real models and runs the full pipeline.
 */
import { describe, it, expect } from 'vitest';
import * as ort from 'onnxruntime-node';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import * as core from '../electron/parakeetCore';

const MODEL_DIR = join(homedir(), '.smart-whisper', 'models', 'parakeet-tdt-0.6b-v3');
const FIX = join(__dirname, 'fixtures');
const AUDIO = join(FIX, 'sample-16k.f32');
const GOLDEN = join(FIX, 'golden.json');
const PRED_LAYERS = 2;
const PRED_HIDDEN = 640;

const RUN_E2E = !!process.env.RUN_E2E;
const ready =
    existsSync(join(MODEL_DIR, 'encoder.int8.onnx')) &&
    existsSync(join(MODEL_DIR, 'decoder.int8.onnx')) &&
    existsSync(join(MODEL_DIR, 'joiner.int8.onnx')) &&
    existsSync(AUDIO);

function loadAudio(): Float32Array {
    const buf = readFileSync(AUDIO);
    return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

/**
 * Full pipeline, with the mel features optionally zero-padded out to
 * `padToFrames`. `validFrames` is left untouched — that is the input telling
 * the encoder how much of the tensor is real audio.
 */
async function transcribe(audio: Float32Array, padToFixed: boolean): Promise<string> {
    const { features, nFrames, validFrames } = core.computeMelSpectrogram(audio, 16000);
    const padded = padToFixed
        ? core.padMelToWidth(features, nFrames, 128)
        : { features, frames: nFrames };
    const feats = padded.features;
    const frames = padded.frames;

    const encoder = await ort.InferenceSession.create(
        join(MODEL_DIR, 'encoder.int8.onnx'), core.encoderSessionOptions(['cpu']));
    const inputs: Record<string, ort.Tensor> = {};
    inputs[encoder.inputNames[0]] = new ort.Tensor('float32', feats, [1, 128, frames]);
    inputs[encoder.inputNames[1]] = new ort.Tensor('int64', BigInt64Array.from([BigInt(validFrames)]), [1]);
    const res = await encoder.run(inputs);
    const encOut = res[encoder.outputNames[0]] as ort.Tensor;
    const encLen = Number((res[encoder.outputNames[1]] as ort.Tensor).data[0]);

    const decoder = await ort.InferenceSession.create(join(MODEL_DIR, 'decoder.int8.onnx'), core.smallModelSessionOptions());
    const joiner = await ort.InferenceSession.create(join(MODEL_DIR, 'joiner.int8.onnx'), core.smallModelSessionOptions());
    const { text } = await core.transducerGreedyDecode(encOut, encLen, {
        decoderSession: decoder, joinerSession: joiner,
        vocabulary: core.loadTokens(join(MODEL_DIR, 'tokens.txt')),
        blankId: core.BLANK_ID, predRnnLayers: PRED_LAYERS, predHidden: PRED_HIDDEN,
    });
    return text.trim();
}

describe.skipIf(!RUN_E2E || !ready)('encoder input padding', () => {
    it('produces the golden transcript unpadded (baseline)', async () => {
        const golden = JSON.parse(readFileSync(GOLDEN, 'utf-8'));
        expect(await transcribe(loadAudio(), false)).toBe(String(golden.text).trim());
    }, 180_000);

    it('produces an IDENTICAL transcript when padded to the fixed shape', async () => {
        // The whole optimisation rests on this. If it ever fails, the fill
        // value is wrong — zeros and edge-replication both shifted punctuation
        // ("…lazy dog, testing" → "…lazy dog. Testing"); the per-bin silence
        // floor is what reproduces the original exactly. This runs the exact
        // production path: 7.3s of real audio padded to FIXED_ENCODER_FRAMES.
        const golden = String(JSON.parse(readFileSync(GOLDEN, 'utf-8')).text).trim();
        expect(await transcribe(loadAudio(), true)).toBe(golden);
    }, 180_000);
});

describe('fixed-width padding (pure)', () => {
    it('pads with each bin\'s own floor, leaves real frames untouched', () => {
        const nFrames = 4, bins = 2, target = 8;
        const feats = new Float32Array([
            -1, -5, -2, -3,   // bin 0: min -5
            -10, -8, -9, -7,  // bin 1: min -10
        ]);
        const { features: out, frames } = core.padMelToWidth(feats, nFrames, bins, target);
        expect(frames).toBe(target);
        // Real frames preserved verbatim.
        expect(Array.from(out.subarray(0, 4))).toEqual([-1, -5, -2, -3]);
        expect(Array.from(out.subarray(target, target + 4))).toEqual([-10, -8, -9, -7]);
        // Padding is that bin's floor — never zero, which would be out of
        // distribution for log-mel and would change the transcript.
        expect(Array.from(out.subarray(4, target))).toEqual([-5, -5, -5, -5]);
        expect(Array.from(out.subarray(target + 4, 2 * target))).toEqual([-10, -10, -10, -10]);
    });

    it('defaults to the one fixed production width', () => {
        const nFrames = 100;
        const feats = new Float32Array(128 * nFrames).fill(-4);
        const r = core.padMelToWidth(feats, nFrames, 128);
        expect(r.frames).toBe(core.FIXED_ENCODER_FRAMES);
    });

    it('leaves audio longer than the fixed width at its natural shape', () => {
        // A >28s single-pass input pays the recompile — rare and amortized.
        // Truncating it instead would DROP SPEECH, which is never acceptable.
        const nFrames = core.FIXED_ENCODER_FRAMES + 100;
        const feats = new Float32Array(128 * nFrames).fill(-4);
        const r = core.padMelToWidth(feats, nFrames, 128);
        expect(r.frames).toBe(nFrames);
        expect(r.features).toBe(feats); // same reference — untouched
    });

    it('the fixed width covers every streaming segment', async () => {
        // Streaming hard-caps segments at MAX_SEGMENT_MS; if that cap ever
        // grows past the fixed width, segments would silently start paying
        // the per-shape recompile again. Fail loudly here instead.
        const src = await import('fs').then(f =>
            f.readFileSync('electron/streamingTranscriber.ts', 'utf-8'));
        const m = src.match(/MAX_SEGMENT_MS\s*=\s*([\d_]+)/);
        expect(m, 'MAX_SEGMENT_MS not found').toBeTruthy();
        const maxSegmentFrames = (parseInt(m![1].replace(/_/g, ''), 10) / 1000) * 100;
        expect(core.FIXED_ENCODER_FRAMES).toBeGreaterThanOrEqual(maxSegmentFrames);
    });
});
