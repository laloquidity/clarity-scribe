/**
 * Custom-vocabulary bias sweep (opt-in tuning harness, not an assertion test).
 *
 *   SWEEP_AUDIO=/path/to/dictation.f32 SWEEP_TERMS=Rayyan \
 *     npx vitest run test/bias-sweep.test.ts
 *
 * Encodes a real recording once, then re-runs the TDT decode at a range of
 * shallow-fusion boost values and prints what each one produces. The point is
 * to find a boost where a rare term wins when it was spoken WITHOUT stealing
 * words that merely sound like it — so record both and read the table.
 *
 * Capture audio with SCRIBE_DUMP_AUDIO=<dir> npm run dev (see main.ts).
 */
import { describe, it } from 'vitest';
import * as ort from 'onnxruntime-node';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import * as core from '../electron/parakeetCore';

const MODEL_DIR = join(homedir(), '.smart-whisper', 'models', 'parakeet-tdt-0.6b-v3');
const AUDIO = process.env.SWEEP_AUDIO;
const TERMS = (process.env.SWEEP_TERMS || '').split(',').map(s => s.trim()).filter(Boolean);
const BOOSTS = (process.env.SWEEP_BOOSTS || '0,2,4,6,8,10,12,15,20')
    .split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n));

const runnable = !!AUDIO && existsSync(AUDIO) && existsSync(join(MODEL_DIR, 'encoder.int8.onnx'));

describe('bias boost sweep', () => {
    it.skipIf(!runnable)('decodes one recording across boost values', async () => {
        const buf = readFileSync(AUDIO!);
        const audio = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
        console.log(`\naudio: ${AUDIO} (${(audio.length / 16000).toFixed(1)}s)`);
        console.log(`terms: ${TERMS.join(', ') || '(none)'}\n`);

        const encoder = await ort.InferenceSession.create(
            join(MODEL_DIR, 'encoder.int8.onnx'), core.encoderSessionOptions(['cpu']));
        const decoder = await ort.InferenceSession.create(
            join(MODEL_DIR, 'decoder.int8.onnx'), core.smallModelSessionOptions());
        const joiner = await ort.InferenceSession.create(
            join(MODEL_DIR, 'joiner.int8.onnx'), core.smallModelSessionOptions());
        const vocab = core.loadTokens(join(MODEL_DIR, 'tokens.txt'));

        // Encode once — the bias only affects decoding, so this is shared.
        const { features, nFrames, validFrames } = core.computeMelSpectrogram(audio, 16000);
        const inputs: Record<string, ort.Tensor> = {};
        inputs[encoder.inputNames[0]] = new ort.Tensor('float32', features, [1, 128, nFrames]);
        inputs[encoder.inputNames[1]] = new ort.Tensor('int64', BigInt64Array.from([BigInt(validFrames)]), [1]);
        const res = await encoder.run(inputs);
        const encoderOut = res[encoder.outputNames[0]] as ort.Tensor;
        const encoderLen = Number((res[encoder.outputNames[1]] as ort.Tensor).data[0]);

        const base = {
            decoderSession: decoder, joinerSession: joiner, vocabulary: vocab,
            blankId: core.BLANK_ID, predRnnLayers: 2, predHidden: 640,
        };

        for (const boost of BOOSTS) {
            const bias = boost === 0 ? null : core.buildBiasContext(TERMS, vocab, boost);
            const out = await core.transducerGreedyDecode(encoderOut, encoderLen, { ...base, bias });
            const label = boost === 0 ? 'unbiased' : `boost ${boost}`;
            console.log(`${label.padEnd(12)} | ${out.text}`);
        }
        console.log('');
    });
});
