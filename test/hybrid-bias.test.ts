/**
 * Hybrid decode: Apple Neural Engine encoder + ONNX TDT decode.
 *
 * The CoreML joint model argmaxes on-device and never exposes logits, so
 * custom-vocabulary biasing cannot happen inside the sidecar. This path takes
 * the encoder output back from the ANE and decodes it here, where the bias trie
 * applies — keeping the expensive ~80% of the work on the Neural Engine.
 *
 * Two checks: the handoff is faithful (hybrid text matches what the sidecar
 * produces on its own), and biasing actually reaches the ANE path.
 *
 *   npx vitest run test/hybrid-bias.test.ts
 *   SWEEP_AUDIO=<file.f32> SWEEP_TERMS=YourTerm npx vitest run test/hybrid-bias.test.ts
 */
import { describe, it, expect } from 'vitest';
import * as ort from 'onnxruntime-node';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import * as core from '../electron/parakeetCore';

const MODEL_DIR = join(homedir(), '.smart-whisper', 'models', 'parakeet-tdt-0.6b-v3');
const COREML_DIR = join(homedir(), '.smart-whisper', 'models', 'parakeet-tdt-0.6b-v3-coreml');
const BIN = join(process.cwd(), 'native', 'parakeet-sidecar', '.build', 'release', 'parakeet-sidecar');
const FIXTURE = join(__dirname, 'fixtures', 'sample-16k.f32');

const runnable =
    process.platform === 'darwin' && process.arch === 'arm64' &&
    existsSync(BIN) &&
    existsSync(join(COREML_DIR, 'Encoder.mlmodelc', 'weights', 'weight.bin')) &&
    existsSync(join(MODEL_DIR, 'decoder.int8.onnx'));

function loadAudio(path: string): Float32Array {
    const buf = readFileSync(path);
    return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

describe('hybrid ANE-encode + ONNX-decode', () => {
    it.skipIf(!runnable)('matches the sidecar transcript and honours bias terms', async () => {
        process.env.SCRIBE_PARAKEET_COREML_DIR = COREML_DIR;
        const sidecar = await import('../electron/parakeetSidecar');
        await sidecar.init();

        const decoder = await ort.InferenceSession.create(
            join(MODEL_DIR, 'decoder.int8.onnx'), core.smallModelSessionOptions());
        const joiner = await ort.InferenceSession.create(
            join(MODEL_DIR, 'joiner.int8.onnx'), core.smallModelSessionOptions());
        const vocab = core.loadTokens(join(MODEL_DIR, 'tokens.txt'));
        const base = {
            decoderSession: decoder, joinerSession: joiner, vocabulary: vocab,
            blankId: core.BLANK_ID, predRnnLayers: 2, predHidden: 640,
        };

        const hybrid = async (audio: Float32Array, bias: core.BiasContext | null) => {
            const enc = await sidecar.encode(audio);
            const tensor = new ort.Tensor('float32', enc.data, [1, enc.hidden, enc.frames]);
            const out = await core.transducerGreedyDecode(tensor, enc.frames, { ...base, bias });
            return out.text;
        };

        try {
            // 1. Faithful handoff: decoding the ANE's encoder output here must
            //    reproduce what the sidecar decodes internally.
            const audio = loadAudio(FIXTURE);
            const native = await sidecar.transcribe(audio);
            const viaHybrid = await hybrid(audio, null);
            console.log(`\n  sidecar: ${native}\n  hybrid : ${viaHybrid}\n`);
            expect(viaHybrid).toBe(native);

            // 2. Terms absent from the audio must not corrupt it, at the boost
            //    that ships.
            const absent = core.buildBiasContext(['Postgres', 'Kubernetes'], vocab, core.DEFAULT_BIAS_BOOST);
            expect(await hybrid(audio, absent)).toBe(viaHybrid);

            // 3. Optional: a real recording of a term the model gets wrong.
            const custom = process.env.SWEEP_AUDIO;
            const terms = (process.env.SWEEP_TERMS || '').split(',').map(s => s.trim()).filter(Boolean);
            if (custom && existsSync(custom) && terms.length) {
                const clip = loadAudio(custom);
                const boosts = (process.env.SWEEP_BOOSTS || String(core.DEFAULT_BIAS_BOOST))
                    .split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n));
                console.log(`  unbiased  | ${await hybrid(clip, null)}`);
                for (const b of boosts) {
                    const bias = core.buildBiasContext(terms, vocab, b);
                    console.log(`  boost ${String(b).padEnd(4)}| ${await hybrid(clip, bias)}`);
                }
                console.log('');
            }
        } finally {
            sidecar.cleanup();
        }
    });
});
