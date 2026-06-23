/**
 * Builds the macOS CoreML ANE Parakeet sidecar before `npm run dev` / `build:mac`.
 *
 * Cross-platform and non-fatal by design:
 *   - On Windows/Linux it is an instant no-op (the sidecar is macOS-only).
 *   - On macOS without a Swift toolchain it warns and continues (the app falls
 *     back to the ONNX engine automatically).
 *   - It NEVER fails the parent command — a missing/broken sidecar just means the
 *     ONNX engine is used instead, so `npm run dev` always launches.
 *
 * `swift build` is incremental, so repeat dev launches are ~instant once built.
 */
const { execSync } = require('child_process');
const { existsSync } = require('fs');
const { join } = require('path');

if (process.platform !== 'darwin') process.exit(0); // sidecar is macOS-only

const dir = join(__dirname, '..', 'native', 'parakeet-sidecar');
if (!existsSync(join(dir, 'Package.swift'))) process.exit(0);

try {
    execSync('swift --version', { stdio: 'ignore' });
} catch {
    console.warn('[sidecar] No Swift toolchain (install Xcode) — skipping CoreML build; the app will use the ONNX engine.');
    process.exit(0);
}

try {
    console.log('[sidecar] Building CoreML ANE sidecar (swift build -c release)…');
    execSync('swift build -c release', { cwd: dir, stdio: 'inherit' });
    console.log('[sidecar] ✓ CoreML sidecar ready.');
} catch (e) {
    console.warn('[sidecar] Build failed — the app will fall back to the ONNX engine.\n        ', e.message);
}

process.exit(0); // never block dev/build
