/**
 * Cost of the hybrid bias path (opt-in): BENCH=1 npx vitest run test/hybrid-perf.test.ts
 *
 * Compares the sidecar decoding end-to-end on the Neural Engine against the
 * hybrid split (ANE encode -> ONNX decode) that engages when the user has
 * Personal Dictionary terms. Measurement artifact, not an assertion.
 */
import { describe, it } from 'vitest';
import * as ort from 'onnxruntime-node';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import * as core from '../electron/parakeetCore';

const BENCH = !!process.env.BENCH;
const MODEL_DIR = join(homedir(), '.smart-whisper', 'models', 'parakeet-tdt-0.6b-v3');
const COREML_DIR = join(homedir(), '.smart-whisper', 'models', 'parakeet-tdt-0.6b-v3-coreml');
const BIN = join(process.cwd(), 'native', 'parakeet-sidecar', '.build', 'release', 'parakeet-sidecar');
const AUDIO = join(__dirname, 'fixtures', 'sample-16k.f32');

const runnable = BENCH && process.platform === 'darwin' && existsSync(BIN) &&
    existsSync(join(COREML_DIR, 'Encoder.mlmodelc', 'weights', 'weight.bin')) &&
    existsSync(join(MODEL_DIR, 'decoder.int8.onnx'));
const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];

describe('hybrid bias path cost', () => {
    it.skipIf(!runnable)('sidecar end-to-end vs ANE encode + ONNX decode', async () => {
        process.env.SCRIBE_PARAKEET_COREML_DIR = COREML_DIR;
        const sidecar = await import('../electron/parakeetSidecar');
        await sidecar.init();
        const buf = readFileSync(AUDIO);
        const audio = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
        const dur = audio.length / 16000;

        const decoder = await ort.InferenceSession.create(join(MODEL_DIR, 'decoder.int8.onnx'), core.smallModelSessionOptions());
        const joiner = await ort.InferenceSession.create(join(MODEL_DIR, 'joiner.int8.onnx'), core.smallModelSessionOptions());
        const vocab = core.loadTokens(join(MODEL_DIR, 'tokens.txt'));
        const bias = core.buildBiasContext(['Postgres', 'ChatGPT', 'Kubernetes'], vocab, core.DEFAULT_BIAS_BOOST);
        const base = {
            decoderSession: decoder, joinerSession: joiner, vocabulary: vocab,
            blankId: core.BLANK_ID, predRnnLayers: 2, predHidden: 640,
        };

        const native: number[] = [], encs: number[] = [], decs: number[] = [], hybrids: number[] = [];
        for (let r = 0; r < 5; r++) {
            let t = Date.now();
            await sidecar.transcribe(audio);
            native.push(Date.now() - t);

            t = Date.now();
            const enc = await sidecar.encode(audio);
            const tEnc = Date.now(); encs.push(tEnc - t);
            const tensor = new ort.Tensor('float32', enc.data, [1, enc.hidden, enc.frames]);
            await core.transducerGreedyDecode(tensor, enc.frames, { ...base, bias });
            decs.push(Date.now() - tEnc);
            hybrids.push(Date.now() - t);
        }
        sidecar.cleanup();

        const n = median(native), h = median(hybrids);
        console.log(`\n[BENCH] Hybrid bias cost (${dur.toFixed(1)}s audio, median of 5):`);
        console.log(`  sidecar end-to-end (no dictionary terms) : ${n}ms = ${(dur / (n / 1000)).toFixed(0)}x`);
        console.log(`  hybrid: ANE encode ${median(encs)}ms + biased ONNX decode ${median(decs)}ms = ${h}ms = ${(dur / (h / 1000)).toFixed(0)}x`);
        console.log(`  delta  : ${h - n >= 0 ? '+' : ''}${h - n}ms per window\n`);
    });
});
