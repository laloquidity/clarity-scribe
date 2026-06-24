/**
 * Integration test for the CoreML sidecar manager (electron/parakeetSidecar.ts)
 * driving the REAL native binary on Apple Silicon. Exercises the full Electron-
 * side glue: spawn → ready handshake → temp-file audio contract → JSON response.
 *
 * Self-skips unless: macOS arm64, the release binary is built, and the CoreML
 * models are available (pointed at via SCRIBE_PARAKEET_COREML_DIR for the test).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const COREML_DIR = '/tmp/coreml-models/parakeet-tdt-0.6b-v3';
const BIN = join(process.cwd(), 'native', 'parakeet-sidecar', '.build', 'release', 'parakeet-sidecar');
const AUDIO = join(__dirname, 'fixtures', 'sample-16k.f32');

const canRun =
    process.platform === 'darwin' &&
    process.arch === 'arm64' &&
    existsSync(BIN) &&
    existsSync(join(COREML_DIR, 'Encoder.mlmodelc', 'weights', 'weight.bin')) &&
    existsSync(AUDIO);

// Point the manager at the cached CoreML models for the test.
process.env.SCRIBE_PARAKEET_COREML_DIR = COREML_DIR;

let sidecar: typeof import('../electron/parakeetSidecar');

describe('parakeet CoreML sidecar manager', () => {
    afterAll(() => { sidecar?.cleanup(); });

    it.skipIf(!canRun)('initializes, transcribes the fixture via the ANE, and reports correct text', async () => {
        sidecar = await import('../electron/parakeetSidecar');
        expect(sidecar.isSupportedPlatform()).toBe(true);
        expect(sidecar.modelsReady()).toBe(true);

        const ok = await sidecar.init();
        expect(ok).toBe(true);
        expect(sidecar.isReady()).toBe(true);

        const buf = readFileSync(AUDIO);
        const audio = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
        const text = await sidecar.transcribe(audio);

        // fp16 CoreML differs cosmetically from int8 ONNX; assert key content.
        const lc = text.toLowerCase();
        expect(lc).toContain('quick brown fox');
        expect(lc).toContain('lazy dog');
        expect(lc).toContain('speech recognition');

        // A second request on the warm process should also succeed (streaming).
        const text2 = await sidecar.transcribe(audio);
        expect(text2).toBe(text);
    });
});
