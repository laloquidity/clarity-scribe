/**
 * Debug: check joiner logit distribution with real mel features
 * Tests if the issue is mel features or the decoding loop
 */
const ort = require('onnxruntime-node');
const path = require('path');
const fs = require('fs');

const MODEL_DIR = path.join(require('os').homedir(), '.smart-whisper', 'models', 'parakeet-tdt-0.6b-v3');
const BLANK_ID = 8192;

async function main() {
    console.log('=== JOINER LOGIT DEBUG ===\n');

    const encoder = await ort.InferenceSession.create(
        path.join(MODEL_DIR, 'encoder.int8.onnx'),
        { executionProviders: ['dml', 'cpu'], logSeverityLevel: 3, graphOptimizationLevel: 'all' }
    );
    const decoder = await ort.InferenceSession.create(
        path.join(MODEL_DIR, 'decoder.int8.onnx'),
        { executionProviders: ['cpu'], logSeverityLevel: 3 }
    );
    const joiner = await ort.InferenceSession.create(
        path.join(MODEL_DIR, 'joiner.int8.onnx'),
        { executionProviders: ['cpu'], logSeverityLevel: 3 }
    );

    // Load tokens
    const tokensRaw = fs.readFileSync(path.join(MODEL_DIR, 'tokens.txt'), 'utf-8');
    const vocab = [];
    for (const line of tokensRaw.trim().split('\n')) {
        const t = line.trim(); if (!t) continue;
        const ls = t.lastIndexOf(' ');
        if (ls > 0) { const tok = t.substring(0, ls); const id = parseInt(t.substring(ls + 1), 10); if (!isNaN(id)) { vocab[id] = tok; continue; } }
        vocab.push(t);
    }

    // Generate a 2-second "speech-like" signal (multi-frequency to simulate complex audio)
    const sampleRate = 16000;
    const duration = 2;
    const numSamples = sampleRate * duration;
    const audio = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
        // Mix several frequencies to create speech-like spectrum
        audio[i] = 0.3 * Math.sin(2 * Math.PI * 200 * i / sampleRate)
                  + 0.2 * Math.sin(2 * Math.PI * 500 * i / sampleRate)
                  + 0.15 * Math.sin(2 * Math.PI * 1000 * i / sampleRate)
                  + 0.1 * Math.sin(2 * Math.PI * 2000 * i / sampleRate)
                  + 0.05 * Math.sin(2 * Math.PI * 4000 * i / sampleRate)
                  + 0.02 * (Math.random() * 2 - 1); // noise
    }

    // Compute mel spectrogram with all NeMo preprocessing
    const nMels = 128, windowSize = 400, hopSize = 160, fftSize = 512, nBins = 257;

    // Dithering
    const ditherAmount = 1e-5;
    for (let i = 0; i < audio.length; i++) audio[i] += ditherAmount * (Math.random() * 2 - 1);

    // Preemphasis
    const processed = new Float32Array(audio.length);
    processed[0] = audio[0];
    for (let i = 1; i < audio.length; i++) processed[i] = audio[i] - 0.97 * audio[i - 1];

    const nFrames = Math.floor((processed.length - windowSize) / hopSize) + 1;

    // Periodic Hann window
    const win = new Float32Array(windowSize);
    for (let i = 0; i < windowSize; i++) win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / windowSize));

    // Mel filterbank
    const melMin = 0, melMax = 2595 * Math.log10(1 + 8000 / 700);
    const melPts = Array.from({length: nMels + 2}, (_, i) => 700 * (Math.pow(10, (melMin + (melMax - melMin) * i / (nMels + 1)) / 2595) - 1));
    const binPts = melPts.map(f => Math.floor((fftSize + 1) * f / sampleRate));
    const filters = new Float32Array(nMels * nBins);
    for (let m = 0; m < nMels; m++) {
        for (let i = 0; i < nBins; i++) {
            if (i >= binPts[m] && i <= binPts[m + 1]) filters[m * nBins + i] = (i - binPts[m]) / (binPts[m + 1] - binPts[m] + 1e-10);
            else if (i > binPts[m + 1] && i <= binPts[m + 2]) filters[m * nBins + i] = (binPts[m + 2] - i) / (binPts[m + 2] - binPts[m + 1] + 1e-10);
        }
    }

    const features = new Float32Array(nMels * nFrames);
    for (let frame = 0; frame < nFrames; frame++) {
        const start = frame * hopSize;
        const real = new Float32Array(fftSize), imag = new Float32Array(fftSize);
        for (let i = 0; i < windowSize && (start + i) < processed.length; i++) real[i] = processed[start + i] * win[i];
        
        // FFT (inline Cooley-Tukey)
        for (let i = 1, j = 0; i < fftSize; i++) { let bit = fftSize >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [real[i], real[j]] = [real[j], real[i]]; [imag[i], imag[j]] = [imag[j], imag[i]]; } }
        for (let size = 2; size <= fftSize; size <<= 1) { const hs = size >> 1, angle = -2 * Math.PI / size, wR = Math.cos(angle), wI = Math.sin(angle); for (let i = 0; i < fftSize; i += size) { let cR = 1, cI = 0; for (let j = 0; j < hs; j++) { const tR = cR * real[i+j+hs] - cI * imag[i+j+hs], tI = cR * imag[i+j+hs] + cI * real[i+j+hs]; real[i+j+hs] = real[i+j] - tR; imag[i+j+hs] = imag[i+j] - tI; real[i+j] += tR; imag[i+j] += tI; const nR = cR * wR - cI * wI; cI = cR * wI + cI * wR; cR = nR; } } }

        for (let m = 0; m < nMels; m++) {
            let energy = 0;
            for (let i = 0; i < nBins; i++) energy += filters[m * nBins + i] * (real[i] * real[i] + imag[i] * imag[i]);
            features[m * nFrames + frame] = Math.log(Math.max(energy, 1e-10));
        }
    }

    // Per-feature normalization
    for (let m = 0; m < nMels; m++) {
        let sum = 0, sumSq = 0;
        for (let t = 0; t < nFrames; t++) { const v = features[m * nFrames + t]; sum += v; sumSq += v * v; }
        const mean = sum / nFrames, std = Math.sqrt(Math.max(sumSq / nFrames - mean * mean, 1e-10));
        for (let t = 0; t < nFrames; t++) features[m * nFrames + t] = (features[m * nFrames + t] - mean) / std;
    }

    // Print feature stats
    let fMin = Infinity, fMax = -Infinity, fSum = 0;
    for (let i = 0; i < features.length; i++) { fMin = Math.min(fMin, features[i]); fMax = Math.max(fMax, features[i]); fSum += features[i]; }
    console.log(`Mel features: min=${fMin.toFixed(2)}, max=${fMax.toFixed(2)}, mean=${(fSum/features.length).toFixed(4)}`);

    // Run encoder
    const inputs = {};
    inputs[encoder.inputNames[0]] = new ort.Tensor('float32', features, [1, nMels, nFrames]);
    inputs[encoder.inputNames[1]] = new ort.Tensor('int64', BigInt64Array.from([BigInt(nFrames)]), [1]);
    const encResult = await encoder.run(inputs);
    const encOut = encResult[encoder.outputNames[0]];
    const encLen = Number(encResult[encoder.outputNames[1]].data[0]);
    console.log(`Encoder: ${JSON.stringify(encOut.dims)}, ${encLen} frames`);

    // Examine encoder output stats
    const encData = encOut.data;
    let encMin = Infinity, encMax = -Infinity, encSum = 0;
    for (let i = 0; i < encData.length; i++) { encMin = Math.min(encMin, encData[i]); encMax = Math.max(encMax, encData[i]); encSum += encData[i]; }
    console.log(`Encoder output: min=${encMin.toFixed(4)}, max=${encMax.toFixed(4)}, mean=${(encSum/encData.length).toFixed(4)}`);

    const D = encOut.dims[1]; // 1024
    const T = encOut.dims[2]; // time frames

    // Run full greedy decode with detailed logit info for first 10 timesteps
    console.log('\n--- Greedy Decode (detailed) ---');
    const predRnnLayers = 2, predHidden = 640;
    const stateSize = predRnnLayers * 1 * predHidden;
    let states = [
        new ort.Tensor('float32', new Float32Array(stateSize), [predRnnLayers, 1, predHidden]),
        new ort.Tensor('float32', new Float32Array(stateSize), [predRnnLayers, 1, predHidden]),
    ];
    let prevToken = BLANK_ID;
    const emitted = [];

    for (let t = 0; t < Math.min(encLen, 10); t++) {
        const tgt = new ort.Tensor('int32', Int32Array.from([prevToken]), [1, 1]);
        const tgtLen = new ort.Tensor('int32', Int32Array.from([1]), [1]);
        const decR = await decoder.run({
            'targets': tgt, 'target_length': tgtLen,
            'states.1': states[0], 'onnx::Slice_3': states[1],
        });
        const decOutput = decR[decoder.outputNames[0]];
        const nextStates = [decR[decoder.outputNames[2]], decR[decoder.outputNames[3]]];

        const eSlice = new Float32Array(D);
        for (let d = 0; d < D; d++) eSlice[d] = encData[d * T + t];
        const eTensor = new ort.Tensor('float32', eSlice, [1, D, 1]);

        const jR = await joiner.run({ 'encoder_outputs': eTensor, 'decoder_outputs': decOutput });
        const logits = jR[joiner.outputNames[0]].data;

        // Find top 5 tokens
        const topK = [];
        for (let i = 0; i < vocab.length; i++) topK.push({idx: i, val: logits[i]});
        topK.sort((a, b) => b.val - a.val);

        const isBlank = topK[0].idx === BLANK_ID;
        console.log(`  t=${t}: top5=[${topK.slice(0, 5).map(x => `${x.idx}:"${vocab[x.idx]}"=${x.val.toFixed(3)}`).join(', ')}] ${isBlank ? '(blank wins)' : '← EMIT'}`);
        
        // Also show blank score vs best non-blank
        const blankScore = logits[BLANK_ID];
        const bestNonBlank = topK.find(x => x.idx !== BLANK_ID);
        console.log(`         blank=${blankScore.toFixed(3)} vs bestNonBlank="${vocab[bestNonBlank.idx]}"=${bestNonBlank.val.toFixed(3)} (gap=${(blankScore - bestNonBlank.val).toFixed(3)})`);

        if (!isBlank) { emitted.push(vocab[topK[0].idx]); prevToken = topK[0].idx; }
        states = nextStates;
    }
    console.log(`\nEmitted: ${emitted.length > 0 ? emitted.join('') : '(none — all blank)'}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
