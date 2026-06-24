/**
 * Cross-platform postinstall. Goal: a clean `npm install` succeeds on every
 * platform with NO compiler / CUDA toolkit required.
 *
 *   - Windows: drop in the committed prebuilt smart-whisper.node (NAPI, so it's
 *     ABI-stable across Electron minor versions). No Visual Studio, no node-gyp.
 *     `onnxruntime-node` (Parakeet) and `uiohook-napi` already ship prebuilt
 *     binaries, so nothing else needs building.
 *   - macOS / Linux: build native deps from source via electron-builder
 *     (smart-whisper compiles with Metal/CPU using its own bundled headers — no
 *     patch needed for the default build).
 *
 * Never hard-fails: a missing prebuilt or a failed source build just means the
 * Whisper engine is unavailable; Parakeet (the primary engine) still works, so
 * `npm run dev` always launches.
 */
const { execSync } = require('child_process');
const { existsSync, mkdirSync, copyFileSync } = require('fs');
const { join } = require('path');

const ROOT = join(__dirname, '..');

if (process.platform === 'win32') {
    const prebuilt = join(ROOT, 'prebuilt', 'win32-x64', 'smart-whisper.node');
    const destDir = join(ROOT, 'node_modules', 'smart-whisper', 'build', 'Release');

    if (existsSync(prebuilt)) {
        mkdirSync(destDir, { recursive: true });
        copyFileSync(prebuilt, join(destDir, 'smart-whisper.node'));
        console.log('[postinstall] ✓ Installed prebuilt smart-whisper.node (no build tools required).');
    } else {
        console.warn('[postinstall] No prebuilt smart-whisper.node found — Whisper engine will be');
        console.warn('[postinstall]   unavailable. Parakeet (the primary engine) still works.');
        console.warn('[postinstall]   To regenerate the prebuilt: npm run build:prebuilt:win');
    }

    // Fetch the Whisper GPU backend DLLs (gitignored — too large for git) so the
    // Whisper engine works out of the box. Vulkan by default: ~58 MB, any GPU, no
    // CUDA toolkit. Skipped if already present; non-fatal if offline.
    try {
        execSync('node scripts/download-win-gpu.js vulkan', { cwd: ROOT, stdio: 'inherit' });
    } catch {
        console.warn('[postinstall] Whisper GPU DLL download skipped — Parakeet still works.');
    }
    process.exit(0);
}

// macOS / Linux: build native deps from source. smart-whisper compiles against
// its own bundled headers here, so the GPU header patch must NOT be applied.
try {
    console.log('[postinstall] Building native deps (electron-builder install-app-deps)…');
    execSync('electron-builder install-app-deps', { cwd: ROOT, stdio: 'inherit' });
    console.log('[postinstall] ✓ Native deps ready.');
} catch (e) {
    console.warn('[postinstall] Native dep build failed — Whisper may be unavailable; Parakeet still works.');
    console.warn('        ', e.message);
}
process.exit(0);
