/**
 * Downloads the Windows GPU backend DLLs for the Whisper engine and extracts
 * them into resources/win-gpu/<backend>/. These DLLs are gitignored (570 MB of
 * CUDA libs is too large for git), so they're mirrored on GitHub Releases and
 * pulled on demand — the same pattern used for the ONNX/CoreML models.
 *
 *   node scripts/download-win-gpu.js          # vulkan (default — any GPU, 58 MB, no toolkit)
 *   node scripts/download-win-gpu.js cuda     # NVIDIA CUDA (~536 MB, needs CUDA Toolkit for max perf)
 *
 * Windows-only and non-fatal: on other platforms, an offline machine, or a
 * download error it just warns and exits 0 — Whisper is then unavailable but
 * Parakeet (the primary engine) still works.
 */
const https = require('https');
const { createWriteStream, existsSync, mkdirSync, unlinkSync, statSync } = require('fs');
const { join } = require('path');
const { execFile } = require('child_process');

const ROOT = join(__dirname, '..');
const TAG = 'win-gpu-dlls';
const BASE = `https://github.com/laloquidity/clarity-scribe/releases/download/${TAG}`;

const BACKENDS = {
    vulkan: 'win-gpu-vulkan.tar.gz',
    cuda: 'win-gpu-cuda.tar.gz',
};

function download(url, dest, redirects = 0) {
    return new Promise((resolve, reject) => {
        if (redirects > 5) return reject(new Error('too many redirects'));
        https.get(url, { headers: { 'User-Agent': 'clarity-scribe' } }, (res) => {
            if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
                res.resume();
                return resolve(download(res.headers.location, dest, redirects + 1));
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            }
            const total = parseInt(res.headers['content-length'] || '0', 10);
            let got = 0, lastPct = -1;
            const file = createWriteStream(dest);
            res.on('data', (c) => {
                got += c.length;
                if (total) {
                    const pct = Math.floor((got / total) * 100);
                    if (pct >= lastPct + 10) { lastPct = pct; process.stdout.write(`\r[win-gpu] downloading… ${pct}%`); }
                }
            });
            res.pipe(file);
            file.on('finish', () => file.close(() => { process.stdout.write('\n'); resolve(); }));
            file.on('error', reject);
        }).on('error', reject);
    });
}

function extract(tarball, destDir) {
    return new Promise((resolve, reject) => {
        execFile('tar', ['-xzf', tarball, '-C', destDir], (err) => (err ? reject(err) : resolve()));
    });
}

async function main() {
    if (process.platform !== 'win32') process.exit(0);

    const backend = (process.argv[2] || 'vulkan').toLowerCase();
    const asset = BACKENDS[backend];
    if (!asset) {
        console.error(`[win-gpu] Unknown backend "${backend}". Use: vulkan | cuda`);
        process.exit(1);
    }

    const destDir = join(ROOT, 'resources', 'win-gpu', backend);
    const sentinel = join(destDir, 'whisper.dll');
    if (existsSync(sentinel)) {
        console.log(`[win-gpu] ${backend} DLLs already present — skipping download.`);
        process.exit(0);
    }

    mkdirSync(destDir, { recursive: true });
    const tarball = join(destDir, `_${asset}`);
    try {
        console.log(`[win-gpu] Fetching ${backend} backend DLLs (${asset})…`);
        await download(`${BASE}/${asset}`, tarball);
        await extract(tarball, destDir);
        unlinkSync(tarball);
        if (!existsSync(sentinel)) throw new Error('extracted bundle missing whisper.dll');
        console.log(`[win-gpu] ✓ ${backend} DLLs ready in resources/win-gpu/${backend}/`);
    } catch (e) {
        try { if (existsSync(tarball)) unlinkSync(tarball); } catch {}
        console.warn(`[win-gpu] Could not fetch ${backend} DLLs — Whisper will be unavailable; Parakeet still works.`);
        console.warn(`          ${e.message}`);
        console.warn(`          Retry later with: node scripts/download-win-gpu.js ${backend}`);
    }
    process.exit(0);
}

main();
