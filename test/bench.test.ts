/**
 * Benchmark (opt-in): BENCH=1 npx vitest run test/bench.test.ts
 *
 * Prints a side-by-side of the ONNX-Runtime-CPU pipeline vs the CoreML ANE
 * sidecar on the speech fixture. Not an assertion test — it's a measurement
 * artifact, skipped unless BENCH=1 and the models/binary are present.
 */
import { describe, it } from 'vitest';
import * as ort from 'onnxruntime-node';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import * as core from '../electron/parakeetCore';

const BENCH = !!process.env.BENCH;
const MODEL_DIR = join(homedir(), '.smart-whisper', 'models', 'parakeet-tdt-0.6b-v3');
const COREML_DIR = '/tmp/coreml-models/parakeet-tdt-0.6b-v3';
const BIN = join(process.cwd(), 'native', 'parakeet-sidecar', '.build', 'release', 'parakeet-sidecar');
const AUDIO = join(__dirname, 'fixtures', 'sample-16k.f32');
const PRED_LAYERS = 2, PRED_HIDDEN = 640;

const hasOnnx = existsSync(join(MODEL_DIR, 'encoder.int8.onnx'));
const hasCoreml = process.platform === 'darwin' && process.arch === 'arm64' && existsSync(BIN) &&
    existsSync(join(COREML_DIR, 'Encoder.mlmodelc', 'weights', 'weight.bin'));

function loadAudio(): Float32Array {
    const buf = readFileSync(AUDIO);
    return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}
const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];

describe('parakeet benchmark', () => {
    it.skipIf(!BENCH || !hasOnnx)('ONNX-CPU pipeline stage timings', async () => {
        const audio = loadAudio();
        const dur = audio.length / 16000;
        const encoder = await ort.InferenceSession.create(join(MODEL_DIR, 'encoder.int8.onnx'), core.encoderSessionOptions(['cpu']));
        const decoder = await ort.InferenceSession.create(join(MODEL_DIR, 'decoder.int8.onnx'), core.smallModelSessionOptions());
        const joiner = await ort.InferenceSession.create(join(MODEL_DIR, 'joiner.int8.onnx'), core.smallModelSessionOptions());
        const vocab = core.loadTokens(join(MODEL_DIR, 'tokens.txt'));

        const mels: number[] = [], encs: number[] = [], decs: number[] = [], tots: number[] = [];
        for (let r = 0; r < 5; r++) {
            const t0 = Date.now();
            const { features, nFrames, validFrames } = core.computeMelSpectrogram(audio, 16000);
            const t1 = Date.now();
            const inputs: Record<string, ort.Tensor> = {};
            inputs[encoder.inputNames[0]] = new ort.Tensor('float32', features, [1, 128, nFrames]);
            inputs[encoder.inputNames[1]] = new ort.Tensor('int64', BigInt64Array.from([BigInt(validFrames)]), [1]);
            const res = await encoder.run(inputs);
            const out = res[encoder.outputNames[0]] as ort.Tensor;
            const len = Number((res[encoder.outputNames[1]] as ort.Tensor).data[0]);
            const t2 = Date.now();
            await core.transducerGreedyDecode(out, len, {
                decoderSession: decoder, joinerSession: joiner, vocabulary: vocab,
                blankId: core.BLANK_ID, predRnnLayers: PRED_LAYERS, predHidden: PRED_HIDDEN,
            });
            const t3 = Date.now();
            mels.push(t1 - t0); encs.push(t2 - t1); decs.push(t3 - t2); tots.push(t3 - t0);
        }
        const tot = median(tots);
        console.log(`\n[BENCH] ONNX-CPU (${dur.toFixed(1)}s audio, median of 5 warm runs):`);
        console.log(`  mel ${median(mels)}ms | encoder ${median(encs)}ms | decode ${median(decs)}ms | total ${tot}ms = ${(dur / (tot / 1000)).toFixed(1)}x real-time`);
    });

    it.skipIf(!BENCH || !hasCoreml)('CoreML ANE sidecar timing', async () => {
        process.env.SCRIBE_PARAKEET_COREML_DIR = COREML_DIR;
        const sidecar = await import('../electron/parakeetSidecar');
        await sidecar.init();
        const audio = loadAudio();
        const dur = audio.length / 16000;
        const tots: number[] = [];
        for (let r = 0; r < 5; r++) {
            const t0 = Date.now();
            await sidecar.transcribe(audio);
            tots.push(Date.now() - t0);
        }
        const tot = median(tots);
        console.log(`\n[BENCH] CoreML ANE sidecar (${dur.toFixed(1)}s audio, median of 5 warm runs):`);
        console.log(`  total ${tot}ms = ${(dur / (tot / 1000)).toFixed(1)}x real-time (encoder runs on the Apple Neural Engine)`);
        sidecar.cleanup();
    });
});
