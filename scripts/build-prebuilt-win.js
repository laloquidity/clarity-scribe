/**
 * Maintainer-only: regenerate prebuilt/win32-x64/smart-whisper.node.
 *
 * Run this on Windows after bumping Electron or refreshing the CUDA whisper
 * build. End users never run this — they get the committed prebuilt via
 * `postinstall`. Requires Visual Studio Build Tools.
 *
 * The binary is built with BYOL ("bring your own library"): instead of
 * compiling smart-whisper's bundled whisper.cpp, only its 4 binding files are
 * compiled and linked against an external CUDA-built whisper import lib. The
 * header patch swaps in headers matching that external library.
 *
 * Configure the import lib via the BYOL env var (defaults to the standard
 * whisper.cpp CUDA build location from the README):
 *   $env:BYOL = "C:/whisper-build/build-cuda/src/Release/whisper.lib"
 *   npm run build:prebuilt:win
 */
const { execSync } = require('child_process');
const { existsSync, mkdirSync, copyFileSync } = require('fs');
const { join } = require('path');

const ROOT = join(__dirname, '..');

if (process.platform !== 'win32') {
    console.error('[prebuilt] This script only builds the Windows binary. Run it on Windows.');
    process.exit(1);
}

const byol = process.env.BYOL || 'C:/whisper-build/build-cuda/src/Release/whisper.lib';
if (!existsSync(byol)) {
    console.error(`[prebuilt] BYOL import lib not found: ${byol}`);
    console.error('[prebuilt] Build whisper.cpp with CUDA first (see README "Regenerating the prebuilt"),');
    console.error('[prebuilt] then set $env:BYOL to the resulting whisper.lib.');
    process.exit(1);
}

// Derive the installed Electron version so the node-gyp headers always match
// (no more hardcoded version drift).
const electronVersion = require(join(ROOT, 'node_modules', 'electron', 'package.json')).version;
const nodedir = join(process.env.USERPROFILE, '.electron-gyp', electronVersion);
console.log(`[prebuilt] Electron ${electronVersion} — headers at ${nodedir}`);

// 1. Patch headers/binding to match the external CUDA whisper library.
console.log('[prebuilt] Patching smart-whisper headers…');
execSync('node scripts/patch-smart-whisper.js', { cwd: ROOT, stdio: 'inherit' });

// 2. BYOL rebuild: compile only the binding, link against the external lib.
console.log('[prebuilt] Rebuilding smart-whisper (BYOL)…');
execSync(
    `npx node-gyp rebuild --directory=node_modules/smart-whisper --nodedir="${nodedir}" --arch=x64`,
    { cwd: ROOT, stdio: 'inherit', env: { ...process.env, BYOL: byol } }
);

// 3. Copy the freshly built binary into the committed prebuilt location.
const built = join(ROOT, 'node_modules', 'smart-whisper', 'build', 'Release', 'smart-whisper.node');
const destDir = join(ROOT, 'prebuilt', 'win32-x64');
mkdirSync(destDir, { recursive: true });
copyFileSync(built, join(destDir, 'smart-whisper.node'));
console.log('[prebuilt] ✓ Updated prebuilt/win32-x64/smart-whisper.node — commit it.');
