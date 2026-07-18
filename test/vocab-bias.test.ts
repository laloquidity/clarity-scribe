/**
 * Decoder-level custom vocabulary (shallow-fusion biasing) — unit tests with a
 * synthetic SentencePiece inventory (no models needed), plus a live decode
 * test against the real models when present.
 */
import { describe, it, expect } from 'vitest';
import * as ort from 'onnxruntime-node';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import * as core from '../electron/parakeetCore';

// Synthetic piece inventory (id = array index).
const PIECES = [
    '▁hello', '▁he', 'llo', '▁world', '▁K', 'ub', 'ern', 'et', 'es',
    '▁Kub', '▁chat', 'G', 'PT', '▁', 'a', 'b', 'c', '<unk>',
];
const pieceMap = new Map(PIECES.map((p, i) => [p, i] as [string, number]));
const MAX_LEN = Math.max(...PIECES.map(p => p.length));

describe('tokenizeTerm', () => {
    it('greedy longest-match picks the longest piece first', () => {
        // "▁Kubernetes" → ▁Kub(9) ern(6) et(7) es(8), NOT ▁K + ub + ...
        expect(core.tokenizeTerm('Kubernetes', pieceMap, MAX_LEN)).toEqual([9, 6, 7, 8]);
    });
    it('tokenizes multi-word phrases with word markers', () => {
        expect(core.tokenizeTerm('hello world', pieceMap, MAX_LEN)).toEqual([0, 3]);
    });
    it('falls back to shorter pieces when needed', () => {
        // "▁chatGPT" → ▁chat(10) G(11) PT(12)
        expect(core.tokenizeTerm('chatGPT', pieceMap, MAX_LEN)).toEqual([10, 11, 12]);
    });
    it('returns null when a character is not representable', () => {
        expect(core.tokenizeTerm('héllo', pieceMap, MAX_LEN)).toBeNull();
        expect(core.tokenizeTerm('', pieceMap, MAX_LEN)).toBeNull();
        expect(core.tokenizeTerm('   ', pieceMap, MAX_LEN)).toBeNull();
    });
});

describe('buildBiasContext', () => {
    it('returns null for empty or untokenizable input', () => {
        expect(core.buildBiasContext([], PIECES)).toBeNull();
        expect(core.buildBiasContext(['ñññ'], PIECES)).toBeNull();
    });
    it('builds a trie containing the term sequence', () => {
        const ctx = core.buildBiasContext(['Kubernetes'], PIECES, 2.0)!;
        expect(ctx).not.toBeNull();
        expect(ctx.termCount).toBe(1);
        // Walk the trie: 9 → 6 → 7 → 8(terminal)
        let node: any = ctx.root;
        for (const id of [9, 6, 7]) {
            node = node.children.get(id);
            expect(node).toBeDefined();
            expect(node.terminal).toBe(false);
        }
        node = node.children.get(8);
        expect(node.terminal).toBe(true);
    });
    it('adds a Capitalized variant for all-lowercase terms', () => {
        // "hello" → ▁hello AND "Hello" → ▁he?? "▁Hello" has no pieces here, so
        // only the lowercase variant lands; but "kubernetes" gains "Kubernetes".
        const ctx = core.buildBiasContext(['kubernetes'], PIECES)!;
        expect(ctx).not.toBeNull();
        // Capitalized variant tokenizes via ▁Kub...; lowercase variant fails
        // (no lowercase pieces) — term still counts.
        expect(ctx.root.children.has(9)).toBe(true);
    });
    it('counts only tokenizable terms', () => {
        const ctx = core.buildBiasContext(['Kubernetes', 'ñ'], PIECES)!;
        expect(ctx.termCount).toBe(1);
    });
});

// ── Live decode integration (models required; skipped otherwise) ────────────
const MODEL_DIR = join(homedir(), '.smart-whisper', 'models', 'parakeet-tdt-0.6b-v3');
const hasModels = existsSync(join(MODEL_DIR, 'decoder.int8.onnx'));
const ENC_FIXTURE = join(__dirname, 'fixtures', 'encoder-output.f32');
const ENC_META = join(__dirname, 'fixtures', 'encoder-output.json');

describe('biased decode (real models)', () => {
    it.skipIf(!hasModels || !existsSync(ENC_FIXTURE))(
        'empty bias is bit-identical to unbiased; active bias decodes cleanly',
        async () => {
            const decoder = await ort.InferenceSession.create(join(MODEL_DIR, 'decoder.int8.onnx'), core.smallModelSessionOptions());
            const joiner = await ort.InferenceSession.create(join(MODEL_DIR, 'joiner.int8.onnx'), core.smallModelSessionOptions());
            const vocab = core.loadTokens(join(MODEL_DIR, 'tokens.txt'));
            const meta = JSON.parse(readFileSync(ENC_META, 'utf-8'));
            const buf = readFileSync(ENC_FIXTURE);
            const encData = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
            const encoderOut = new ort.Tensor('float32', encData, meta.dims);

            const base = {
                decoderSession: decoder, joinerSession: joiner, vocabulary: vocab,
                blankId: core.BLANK_ID, predRnnLayers: 2, predHidden: 640,
            };
            const plain = await core.transducerGreedyDecode(encoderOut, meta.encoderLen, base);
            const nullBias = await core.transducerGreedyDecode(encoderOut, meta.encoderLen, { ...base, bias: null });
            expect(nullBias.text).toBe(plain.text);

            // Bias toward words already in the golden text — argmax winners
            // stay winners, so the text must not change.
            const sameBias = core.buildBiasContext(['quick', 'lazy dog'], vocab, 2.0);
            expect(sameBias).not.toBeNull();
            const biased = await core.transducerGreedyDecode(encoderOut, meta.encoderLen, { ...base, bias: sameBias });
            expect(biased.text).toBe(plain.text);
        }
    );
});
