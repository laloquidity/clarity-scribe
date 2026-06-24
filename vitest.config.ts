import { defineConfig } from 'vitest/config';

// Node-environment tests for the Electron-side transcription core and the
// renderer-side text utilities. Native modules (onnxruntime-node) are loaded
// via require at runtime, so they must not be transformed/externalized.
export default defineConfig({
    test: {
        environment: 'node',
        include: ['test/**/*.test.ts'],
        // Model-backed regression tests load ONNX sessions and can take a few
        // seconds; give them headroom. Pure unit tests finish instantly.
        testTimeout: 120_000,
        hookTimeout: 120_000,
    },
    server: {
        deps: {
            // onnxruntime-node is a native addon — never inline/transform it.
            external: ['onnxruntime-node'],
        },
    },
});
