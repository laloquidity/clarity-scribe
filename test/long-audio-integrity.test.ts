/**
 * Long-audio integrity — does our ONNX path drop words in long recordings?
 *
 * WHY THIS EXISTS. FluidAudio issue #760 reports that the Parakeet v3 **CoreML**
 * export drops or mangles a word when ~4s or more of audio follows it inside
 * the encoder's fixed 15s non-causal window. We ship two different engines:
 *
 *   · macOS  — the CoreML ANE sidecar, which "handles its own 15s chunking
 *              internally" (parakeetService.ts) — i.e. FluidAudio's code, the
 *              exact component #760 is filed against.
 *   · Windows — ONNX Runtime, fed WHOLE VAD segments with a dynamic length
 *              tensor. No 15s window, no window composition.
 *
 * So the mechanism plausibly doesn't exist on ONNX — but "plausibly" isn't
 * evidence, and this is a correctness bug in shipping software. This test
 * settles it for the engine we can actually execute here: transcribe known
 * speech alone, then transcribe it embedded in a recording long enough to
 * cross the 15s boundary, and assert the words survive.
 *
 * Opt-in (RUN_E2E=1) because it loads real models and runs the full pipeline.
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
const SR = 16000;

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

/** Concatenate clips with `gapSec` of digital silence between them. */
function concat(clips: Float32Array[], gapSec: number): Float32Array {
    const gap = Math.round(gapSec * SR);
    const total = clips.reduce((n, c) => n + c.length, 0) + gap * (clips.length - 1);
    const out = new Float32Array(total);
    let at = 0;
    clips.forEach((c, i) => {
        out.set(c, at);
        at += c.length + (i < clips.length - 1 ? gap : 0);
    });
    return out;
}

/** Full pipeline: mel → encoder → greedy TDT decode. Mirrors production. */
async function transcribe(audio: Float32Array): Promise<string> {
    const encoder = await ort.InferenceSession.create(
        join(MODEL_DIR, 'encoder.int8.onnx'), core.encoderSessionOptions(['cpu']));
    const { features, nFrames, validFrames } = core.computeMelSpectrogram(audio, SR);
    const inputs: Record<string, ort.Tensor> = {};
    inputs[encoder.inputNames[0]] = new ort.Tensor('float32', features, [1, 128, nFrames]);
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

/** Content words only — punctuation/casing differences aren't word loss. */
function words(s: string): string[] {
    return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

describe.skipIf(!RUN_E2E || !ready)('long-audio integrity (FluidAudio #760 on our ONNX path)', () => {
    it('transcribes the reference clip correctly on its own (baseline)', async () => {
        const text = await transcribe(loadAudio());
        const golden = JSON.parse(readFileSync(GOLDEN, 'utf-8'));
        expect(text).toBe(String(golden.text).trim());
    }, 180_000);

    it('does NOT drop words when the same speech sits inside a >15s recording', async () => {
        const clip = loadAudio();
        const golden = JSON.parse(readFileSync(GOLDEN, 'utf-8'));
        const expected = words(String(golden.text));

        // ~19.7s: clip · 5s silence · clip. Crosses the 15s window boundary that
        // #760 implicates, and every word of copy 1 has >4s of audio after it.
        const long = concat([clip, clip], 5);
        expect(long.length / SR).toBeGreaterThan(15);

        const text = await transcribe(long);
        const got = words(text);

        // Both copies must survive intact.
        for (let i = 0; i < 2; i++) {
            const slice = got.slice(i * expected.length, (i + 1) * expected.length);
            expect(slice, `copy ${i + 1} of the utterance was altered\n  full: "${text}"`).toEqual(expected);
        }
    }, 240_000);

    it('does NOT drop the leading words of a long continuous recording', async () => {
        // #760's signature is loss EARLY in the window when a lot follows.
        // Three back-to-back copies ≈ 24s with short gaps: the first copy has
        // ~16s of audio after it.
        const clip = loadAudio();
        const golden = JSON.parse(readFileSync(GOLDEN, 'utf-8'));
        const expected = words(String(golden.text));
        const long = concat([clip, clip, clip], 0.4);

        const text = await transcribe(long);
        const got = words(text);
        expect(got.slice(0, expected.length),
            `the FIRST utterance was altered in a ${(long.length / SR).toFixed(1)}s recording\n  full: "${text}"`)
            .toEqual(expected);
        expect(got.length, 'total word count suggests dropped speech').toBe(expected.length * 3);
    }, 300_000);
});
