/**
 * Does padding the encoder input change the transcript?
 *
 * WHY IT MATTERS. Measured on this machine (RTX 3090, DirectML): the encoder
 * costs ~72ms when the input shape has been seen before and ~451ms when it is
 * new, and returning to an earlier shape drops back to ~76ms. DirectML
 * compiles an execution plan per input shape and caches it. Every dictation
 * has a different length, so every dictation is a new shape and pays a full
 * recompile — roughly 375ms of waste on each one.
 *
 * The fix is to round the input up to one of a few fixed sizes so the plan is
 * reused. That is only legitimate if padding does NOT change what the model
 * outputs. The encoder takes a separate `length` input for exactly this
 * reason, and our batch path already relies on it to pad segments to a common
 * width — but "already relied upon" is not the same as verified, so this test
 * checks the transcript itself.
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
async function transcribe(audio: Float32Array, bucketed: boolean): Promise<string> {
    const { features, nFrames, validFrames } = core.computeMelSpectrogram(audio, 16000);
    const padded = bucketed
        ? core.padMelToBucket(features, nFrames, 128)
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

    it('produces an IDENTICAL transcript when bucketed', async () => {
        // The whole optimisation rests on this. If it ever fails, the fill
        // value is wrong — zeros and edge-replication both shifted punctuation
        // ("…lazy dog, testing" → "…lazy dog. Testing"); the per-bin silence
        // floor is what reproduces the original exactly.
        const golden = String(JSON.parse(readFileSync(GOLDEN, 'utf-8')).text).trim();
        expect(await transcribe(loadAudio(), true)).toBe(golden);
    }, 180_000);
});

describe('encoder bucketing (pure)', () => {
    it('rounds up to the smallest bucket that fits', () => {
        expect(core.encoderBucketFrames(1)).toBe(300);
        expect(core.encoderBucketFrames(300)).toBe(300);
        expect(core.encoderBucketFrames(301)).toBe(600);
        expect(core.encoderBucketFrames(733)).toBe(1000);
        expect(core.encoderBucketFrames(2800)).toBe(2800);
    });

    it('collapses many recording lengths onto few shapes', () => {
        // The point of the exercise: 1s–28s of audio must not produce 28
        // different encoder shapes.
        const shapes = new Set<number>();
        for (let f = 50; f <= 2800; f += 7) shapes.add(core.encoderBucketFrames(f));
        expect(shapes.size).toBeLessThanOrEqual(6);
    });

    it('rounds to a fixed step beyond the largest bucket', () => {
        expect(core.encoderBucketFrames(3000)).toBe(3000);
        expect(core.encoderBucketFrames(3001)).toBe(3500);
    });

    it('pads with each bin\'s own floor, leaves real frames untouched', () => {
        const nFrames = 4, bins = 2;
        const feats = new Float32Array([
            -1, -5, -2, -3,   // bin 0: min -5
            -10, -8, -9, -7,  // bin 1: min -10
        ]);
        const { features: out, frames } = core.padMelToBucket(feats, nFrames, bins);
        expect(frames).toBe(300);
        // Real frames preserved verbatim.
        expect(Array.from(out.subarray(0, 4))).toEqual([-1, -5, -2, -3]);
        expect(Array.from(out.subarray(300, 304))).toEqual([-10, -8, -9, -7]);
        // Padding is that bin's floor — never zero, which would be out of
        // distribution for log-mel and would change the transcript.
        expect(out[4]).toBe(-5);
        expect(out[299]).toBe(-5);
        expect(out[304]).toBe(-10);
        expect(out[599]).toBe(-10);
    });

    it('returns the input untouched when it already fills a bucket', () => {
        const feats = new Float32Array(128 * 300).fill(-4);
        const r = core.padMelToBucket(feats, 300, 128);
        expect(r.frames).toBe(300);
        expect(r.features).toBe(feats); // same reference — no copy
    });
});
