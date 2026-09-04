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
// Appended-only: earlier entries' ids are asserted by index below. The ▁de*
// family exists so one start token is genuinely branchy (9 pieces share "▁de"),
// mirroring the real inventory where "▁de" is shared by 32.
const PIECES = [
    '▁hello', '▁he', 'llo', '▁world', '▁K', 'ub', 'ern', 'et', 'es',
    '▁Kub', '▁chat', 'G', 'PT', '▁', 'a', 'b', 'c', '<unk>',
    '▁de', '▁dec', '▁dep', '▁del', '▁dea', '▁dee', '▁def', '▁deg', '▁deh',
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

    // Regression: a term-start id is boosted on EVERY frame, so a start that
    // many pieces share drags ordinary speech into the term — the real word is
    // truncated and the custom term replaces it mid-sentence. Such a term must
    // not enter the trie AT ALL: left in, an organically emitted start would
    // still collect the 2x continuation pull and complete the term.
    it('refuses terms whose first token is shared by too many pieces', () => {
        // 9 pieces begin '▁de'; only 1 begins '▁Kub'.
        expect(core.buildBiasContext(['de'], PIECES)).toBeNull();

        const mixed = core.buildBiasContext(['Kubernetes', 'de'], PIECES)!;
        expect(mixed.termCount).toBe(1);
        expect(mixed.rejectedTerms).toEqual(['de']);
        // The generic start must be absent from the trie root, not merely unboosted.
        expect(mixed.root.children.has(pieceMap.get('▁de')!)).toBe(false);
        expect(mixed.root.children.has(pieceMap.get('▁Kub')!)).toBe(true);
    });

    // Length is not the discriminator: two-character starts range from one
    // shared piece to more than thirty. A short start is fine when it is rare —
    // rejecting on length alone would have gutted the feature.
    it('keeps a short start token when few pieces share it', () => {
        const ctx = core.buildBiasContext(['hello'], PIECES)!;
        expect(ctx.termCount).toBe(1);
        expect(ctx.rejectedTerms).toEqual([]);
    });

    // …except a single bare letter, which is never specific however few pieces
    // share it: it is the spelling route for every unknown word starting with
    // that letter. Only two pieces begin '▁K' here, and it is still refused.
    // Real case: 'USDC' (▁U|S|D|C) turned every "uh"/"use" into "US" and
    // "user" into "USDC" (dictation, 2026-09-04).
    it('refuses a term that opens on a single bare letter', () => {
        // "Kab" → ▁K(4) a(14) b(15)
        expect(core.tokenizeTerm('Kab', pieceMap, MAX_LEN)).toEqual([4, 14, 15]);
        expect(core.buildBiasContext(['Kab'], PIECES)).toBeNull();
        const mixed = core.buildBiasContext(['Kab', 'Kubernetes'], PIECES)!;
        expect(mixed.termCount).toBe(1);
        expect(mixed.rejectedTerms).toEqual(['Kab']);
        expect(mixed.root.children.has(pieceMap.get('▁K')!)).toBe(false);
    });
});

// ── Live decode integration (models required; skipped otherwise) ────────────
const MODEL_DIR = join(homedir(), '.smart-whisper', 'models', 'parakeet-tdt-0.6b-v3');
const hasModels = existsSync(join(MODEL_DIR, 'decoder.int8.onnx'));
const ENC_FIXTURE = join(__dirname, 'fixtures', 'encoder-output.f32');
const ENC_META = join(__dirname, 'fixtures', 'encoder-output.json');
const AUDIO_FIXTURE = join(__dirname, 'fixtures', 'sample-16k.f32');

describe('real vocabulary term safety', () => {
    // Against the real SentencePiece inventory rather than the synthetic one.
    // A term opening on a single letter, or on a heavily shared two-letter
    // piece, is the shape that corrupted real dictations.
    it.skipIf(!hasModels)('rejects terms opening on a widely shared token', () => {
        const vocab = core.loadTokens(join(MODEL_DIR, 'tokens.txt'));
        // '▁D' is shared by ~28 pieces, '▁N' by ~20.
        expect(core.buildBiasContext(['D-Link'], vocab)).toBeNull();
        expect(core.buildBiasContext(['Nginx'], vocab)).toBeNull();
        // '▁U' is shared by only 8 — and is still a bare letter (USDC → ▁U|S|D|C).
        expect(core.buildBiasContext(['USDC'], vocab)).toBeNull();

        const ctx = core.buildBiasContext(['D-Link', 'Nginx', 'Kubernetes'], vocab)!;
        expect(ctx.termCount).toBe(1);
        expect(ctx.rejectedTerms.sort()).toEqual(['D-Link', 'Nginx']);
    });

    // Rare starts must survive — these are what the feature exists for.
    it.skipIf(!hasModels)('keeps rare-start terms', () => {
        const vocab = core.loadTokens(join(MODEL_DIR, 'tokens.txt'));
        for (const t of ['Kubernetes', 'Postgres', 'Zanzibar', 'Helsinki']) {
            const ctx = core.buildBiasContext([t], vocab);
            expect(ctx, `${t} should still be biased`).not.toBeNull();
        }
    });
});

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

    // The shipped boost is high enough to overturn a confident common word in
    // favour of a rare custom term, which is the whole point of it. This pins
    // the other half: at that same strength, terms the audio does not contain
    // must not bleed into a clean transcript.
    it.skipIf(!hasModels || !existsSync(ENC_FIXTURE))(
        'at the shipped default boost, unrelated terms do not corrupt the transcript',
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

            // Names and jargon that never occur in the fixture speech, including
            // one that begins like a word that does ("quick" → "Quixote").
            const absent = core.buildBiasContext(
                ['Postgres', 'Kubernetes', 'Quixote', 'Zanzibar'], vocab, core.DEFAULT_BIAS_BOOST);
            expect(absent).not.toBeNull();
            const biased = await core.transducerGreedyDecode(encoderOut, meta.encoderLen, { ...base, bias: absent });
            expect(biased.text).toBe(plain.text);
        }
    );

    // Regression: every term-start id is boosted on every frame, so a boost
    // strong enough to beat blank will spray custom terms across a pause and
    // then cascade through the trie (the term sprayed ahead of the first
    // real word). Silence is where that shows up, so decode some.
    it.skipIf(!hasModels || !existsSync(join(MODEL_DIR, 'encoder.int8.onnx')) || !existsSync(AUDIO_FIXTURE))(
        'bias never emits into silence, however many terms are configured',
        async () => {
            const encoder = await ort.InferenceSession.create(
                join(MODEL_DIR, 'encoder.int8.onnx'), core.encoderSessionOptions(['cpu']));
            const decoder = await ort.InferenceSession.create(join(MODEL_DIR, 'decoder.int8.onnx'), core.smallModelSessionOptions());
            const joiner = await ort.InferenceSession.create(join(MODEL_DIR, 'joiner.int8.onnx'), core.smallModelSessionOptions());
            const vocab = core.loadTokens(join(MODEL_DIR, 'tokens.txt'));

            // 1.5s of silence, then the speech fixture: the boost has a long
            // stretch of nothing to hallucinate into before any real audio.
            const buf = readFileSync(AUDIO_FIXTURE);
            const speech = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
            const padded = new Float32Array(24_000 + speech.length);
            padded.set(speech, 24_000);

            const { features, nFrames, validFrames } = core.computeMelSpectrogram(padded, 16000);
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
            const plain = await core.transducerGreedyDecode(encoderOut, encoderLen, base);

            // A realistic dictionary: several terms, none of them spoken here.
            const bias = core.buildBiasContext(
                ['Postgres', 'Zanzibar', 'Helsinki', 'ChatGPT', 'Kubernetes'], vocab, core.DEFAULT_BIAS_BOOST);
            expect(bias).not.toBeNull();
            const biased = await core.transducerGreedyDecode(encoderOut, encoderLen, { ...base, bias });
            expect(biased.text).toBe(plain.text);
        }
    );
});
