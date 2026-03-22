#!/usr/bin/env node
/**
 * Patches smart-whisper's bundled whisper.cpp for GPU backend compatibility.
 *
 * This script is run as part of postinstall to:
 * 1. Replace bundled whisper.cpp/ggml headers with our CUDA-build-compatible versions
 * 2. Fix whisper_context_params initialization (use defaults instead of garbage)
 * 3. Remove references to deprecated API fields (suppress_non_speech_tokens)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SMART_WHISPER = path.join(ROOT, 'node_modules', 'smart-whisper');
const PATCH_HEADERS = path.join(__dirname, 'whisper-headers');

if (!fs.existsSync(SMART_WHISPER)) {
    console.log('[patch] smart-whisper not installed, skipping');
    process.exit(0);
}

console.log('[patch] Patching smart-whisper for GPU backend compatibility...');

// --- 1. Replace headers ---
const headerMappings = [
    { src: 'include/whisper.h', dst: 'whisper.cpp/include/whisper.h' },
];

// Copy all ggml headers
const ggmlSrc = path.join(PATCH_HEADERS, 'ggml', 'include');
const ggmlDst = path.join(SMART_WHISPER, 'whisper.cpp', 'ggml', 'include');
if (fs.existsSync(ggmlSrc) && fs.existsSync(ggmlDst)) {
    for (const file of fs.readdirSync(ggmlSrc)) {
        if (file.endsWith('.h')) {
            fs.copyFileSync(path.join(ggmlSrc, file), path.join(ggmlDst, file));
        }
    }
    console.log('[patch] ✓ Replaced ggml headers');
}

// Copy whisper.h
for (const { src, dst } of headerMappings) {
    const srcPath = path.join(PATCH_HEADERS, src);
    const dstPath = path.join(SMART_WHISPER, dst);
    if (fs.existsSync(srcPath) && fs.existsSync(path.dirname(dstPath))) {
        fs.copyFileSync(srcPath, dstPath);
        console.log(`[patch] ✓ Replaced ${dst}`);
    }
}

// --- 2. Fix model.cc: use whisper_context_default_params() ---
const modelCC = path.join(SMART_WHISPER, 'src', 'binding', 'model.cc');
if (fs.existsSync(modelCC)) {
    let content = fs.readFileSync(modelCC, 'utf8');
    const oldInit = 'whisper_context_params params;';
    const newInit = 'whisper_context_params params = whisper_context_default_params();';

    if (content.includes(oldInit)) {
        content = content.replace(oldInit, newInit);
        fs.writeFileSync(modelCC, content);
        console.log('[patch] ✓ Fixed whisper_context_params initialization in model.cc');
    } else if (content.includes(newInit)) {
        console.log('[patch] ✓ model.cc already patched');
    }
}

// --- 3. Fix transcribe.cc: remove suppress_non_speech_tokens ---
const transcribeCC = path.join(SMART_WHISPER, 'src', 'binding', 'transcribe.cc');
if (fs.existsSync(transcribeCC)) {
    let content = fs.readFileSync(transcribeCC, 'utf8');
    const pattern = /^\s*if \(o\.Has\("suppress_non_speech_tokens"\).*\n\s*params\.suppress_non_speech_tokens.*\n\s*\}/m;

    if (pattern.test(content)) {
        content = content.replace(pattern,
            '    // suppress_non_speech_tokens removed in newer whisper.cpp\n' +
            '    // (patched by scripts/patch-smart-whisper.js)'
        );
        fs.writeFileSync(transcribeCC, content);
        console.log('[patch] ✓ Removed suppress_non_speech_tokens from transcribe.cc');
    } else {
        console.log('[patch] ✓ transcribe.cc already patched');
    }
}

console.log('[patch] Done. smart-whisper is ready for BYOL rebuild.');
