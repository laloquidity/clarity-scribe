/**
 * Regression + unit tests for the Parakeet TDT core (electron/parakeetCore.ts).
 *
 * Purpose: lock the transcription OUTPUT so the speed refactors (decoder-output
 * caching, mel memoization, buffer reuse) can be proven byte-for-byte identical.
 *
 * Three layers, fastest first:
 *   1. Mel determinism — pure, no models. Hashes computeMelSpectrogram output.
 *   2. Decode invariance — loads the small decoder+joiner (~17MB) and a frozen
 *      encoder-output fixture, runs the real TDT greedy decode, asserts the text.
 *   3. Full end-to-end (RUN_E2E=1) — also loads the 622MB encoder and runs the
 *      whole pipeline from audio, asserting it reproduces the golden text.
 *
 * Capture/refresh the golden fixtures (only when intentionally changing output):
 *   UPDATE_GOLDEN=1 npx vitest run test/parakeet-core.test.ts
 *
 * Tests self-skip when the local Parakeet model is not installed.
 */
import { describe, it, expect } from 'vitest';
import * as ort from 'onnxruntime-node';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import * as core from '../electron/parakeetCore';

const MODEL_DIR = join(homedir(), '.smart-whisper', 'models', 'parakeet-tdt-0.6b-v3');
const FIX = join(__dirname, 'fixtures');
const AUDIO = join(FIX, 'sample-16k.f32');
const GOLDEN = join(FIX, 'golden.json');
const ENC_OUT = join(FIX, 'encoder-output.f32');
const ENC_META = join(FIX, 'encoder-output.json');

// Decoder LSTM state dims (matches readEncoderMetadata in parakeetService.ts)
const PRED_LAYERS = 2;
const PRED_HIDDEN = 640;

const UPDATE = !!process.env.UPDATE_GOLDEN;
const RUN_E2E = !!process.env.RUN_E2E || UPDATE;

const hasEncoder = existsSync(join(MODEL_DIR, 'encoder.int8.onnx'));
const hasSmall =
    existsSync(join(MODEL_DIR, 'decoder.int8.onnx')) &&
    existsSync(join(MODEL_DIR, 'joiner.int8.onnx')) &&
    existsSync(join(MODEL_DIR, 'tokens.txt'));
const hasAudio = existsSync(AUDIO);

function loadAudio(): Float32Array {
    const buf = readFileSync(AUDIO);
    return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}
function sha(arr: Float32Array): string {
    return createHash('sha256').update(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)).digest('hex');
}
function loadVocab(): string[] {
    return core.loadTokens(join(MODEL_DIR, 'tokens.txt'));
}

// Use the SAME session options as production so the regression reflects the
// tuned encoder/decoder/joiner configuration, not a default one.
async function loadSmall(file: string): Promise<ort.InferenceSession> {
    return ort.InferenceSession.create(join(MODEL_DIR, file), core.smallModelSessionOptions());
}

// Mirrors parakeetService.transcribeSinglePass: mel -> encoder -> (encoderOut, encoderLen).
async function runEncoder(audio: Float32Array): Promise<{ out: ort.Tensor; len: number }> {
    const encoder = await ort.InferenceSession.create(join(MODEL_DIR, 'encoder.int8.onnx'), core.encoderSessionOptions(['cpu']));
    const { features, nFrames, validFrames } = core.computeMelSpectrogram(audio, 16000);
    const audioTensor = new ort.Tensor('float32', features, [1, 128, nFrames]);
    const lengthTensor = new ort.Tensor('int64', BigInt64Array.from([BigInt(validFrames)]), [1]);
    const inputs: Record<string, ort.Tensor> = {};
    inputs[encoder.inputNames[0]] = audioTensor;
    inputs[encoder.inputNames[1]] = lengthTensor;
    const res = await encoder.run(inputs);
    const out = res[encoder.outputNames[0]] as ort.Tensor;
    const len = Number((res[encoder.outputNames[1]] as ort.Tensor).data[0]);
    return { out, len };
}

describe('parakeetCore mel frontend', () => {
    it.skipIf(!hasAudio)('computeMelSpectrogram is deterministic and matches golden', () => {
        const audio = loadAudio();
        const { features, nFrames, validFrames } = core.computeMelSpectrogram(audio, 16000);
        // determinism: same input -> identical output
        const again = core.computeMelSpectrogram(audio, 16000);
        expect(sha(again.features)).toBe(sha(features));
        expect(again.nFrames).toBe(nFrames);
        expect(again.validFrames).toBe(validFrames);

        const melSha = sha(features);
        if (UPDATE) {
            const golden = existsSync(GOLDEN) ? JSON.parse(readFileSync(GOLDEN, 'utf-8')) : {};
            golden.melSha = melSha;
            golden.nFrames = nFrames;
            golden.validFrames = validFrames;
            writeFileSync(GOLDEN, JSON.stringify(golden, null, 2));
        } else if (existsSync(GOLDEN)) {
            const golden = JSON.parse(readFileSync(GOLDEN, 'utf-8'));
            expect(melSha).toBe(golden.melSha);
            expect(nFrames).toBe(golden.nFrames);
            expect(validFrames).toBe(golden.validFrames);
        }
    });
});

describe('parakeetCore TDT decode', () => {
    // Capture: run the full pipeline once and freeze encoder output + golden text.
    it.skipIf(!(UPDATE && hasEncoder && hasSmall && hasAudio))('capture golden fixtures', async () => {
        const audio = loadAudio();
        const { out, len } = await runEncoder(audio);
        // freeze encoder output for the fast decode test
        const data = out.data as Float32Array;
        writeFileSync(ENC_OUT, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
        writeFileSync(ENC_META, JSON.stringify({ dims: out.dims, len }, null, 2));

        const vocab = loadVocab();
        const decoder = await loadSmall('decoder.int8.onnx');
        const joiner = await loadSmall('joiner.int8.onnx');
        const text = await core.transducerGreedyDecode(out, len, {
            decoderSession: decoder, joinerSession: joiner, vocabulary: vocab,
            blankId: core.BLANK_ID, predRnnLayers: PRED_LAYERS, predHidden: PRED_HIDDEN,
        });
        const golden = existsSync(GOLDEN) ? JSON.parse(readFileSync(GOLDEN, 'utf-8')) : {};
        golden.text = text;
        golden.encDims = out.dims;
        golden.encLen = len;
        writeFileSync(GOLDEN, JSON.stringify(golden, null, 2));
        expect(text.length).toBeGreaterThan(0);
    });

    // Fast invariance: decode the frozen encoder output, assert golden text.
    it.skipIf(UPDATE || !hasSmall || !existsSync(ENC_OUT) || !existsSync(GOLDEN))(
        'greedy decode of frozen encoder output reproduces golden text',
        async () => {
            const meta = JSON.parse(readFileSync(ENC_META, 'utf-8'));
            const golden = JSON.parse(readFileSync(GOLDEN, 'utf-8'));
            const buf = readFileSync(ENC_OUT);
            const data = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
            const encoderOut = new ort.Tensor('float32', data, meta.dims as number[]);
            const vocab = loadVocab();
            const decoder = await loadSmall('decoder.int8.onnx');
            const joiner = await loadSmall('joiner.int8.onnx');
            const text = await core.transducerGreedyDecode(encoderOut, meta.len, {
                decoderSession: decoder, joinerSession: joiner, vocabulary: vocab,
                blankId: core.BLANK_ID, predRnnLayers: PRED_LAYERS, predHidden: PRED_HIDDEN,
            });
            expect(text).toBe(golden.text);
        }
    );

    // Full end-to-end (opt-in): audio -> mel -> encoder -> decode -> golden text.
    it.skipIf(UPDATE || !RUN_E2E || !hasEncoder || !hasSmall || !hasAudio || !existsSync(GOLDEN))(
        'full pipeline from audio reproduces golden text',
        async () => {
            const golden = JSON.parse(readFileSync(GOLDEN, 'utf-8'));
            const audio = loadAudio();
            const { out, len } = await runEncoder(audio);
            const vocab = loadVocab();
            const decoder = await loadSmall('decoder.int8.onnx');
            const joiner = await loadSmall('joiner.int8.onnx');
            const text = await core.transducerGreedyDecode(out, len, {
                decoderSession: decoder, joinerSession: joiner, vocabulary: vocab,
                blankId: core.BLANK_ID, predRnnLayers: PRED_LAYERS, predHidden: PRED_HIDDEN,
            });
            expect(text).toBe(golden.text);
        }
    );
});
