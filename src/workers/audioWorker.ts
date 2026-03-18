/**
 * Audio Processing Worker — resampling, trimming, normalization
 * Copied from Clarity, unchanged.
 */

function resampleAudio(audio: Float32Array, fromSampleRate: number, toSampleRate: number): Float32Array {
    if (fromSampleRate === toSampleRate) return audio;
    const ratio = fromSampleRate / toSampleRate;
    const newLength = Math.round(audio.length / ratio);
    const result = new Float32Array(newLength);
    for (let i = 0; i < newLength; i++) {
        const position = i * ratio;
        const index = Math.floor(position);
        const t = position - index;
        const y0 = audio[Math.max(0, index - 1)];
        const y1 = audio[index];
        const y2 = audio[Math.min(audio.length - 1, index + 1)];
        const y3 = audio[Math.min(audio.length - 1, index + 2)];
        const c0 = y1;
        const c1 = 0.5 * (y2 - y0);
        const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
        const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
        result[i] = ((c3 * t + c2) * t + c1) * t + c0;
    }
    return result;
}

function trimSilence(audio: Float32Array, threshold = 0.002): Float32Array {
    let start = 0;
    let end = audio.length;
    while (start < end && Math.abs(audio[start]) < threshold) start++;
    while (end > start && Math.abs(audio[end - 1]) < threshold) end--;
    if (start >= end) return new Float32Array(0);
    const padding = 1600;
    return audio.slice(Math.max(0, start - padding), Math.min(audio.length, end + padding));
}

function normalizeAudio(data: Float32Array): Float32Array | null {
    const trimmed = trimSilence(data);
    if (trimmed.length < 500) return null;
    let max = 0;
    for (let i = 0; i < trimmed.length; i++) {
        const val = Math.abs(trimmed[i]);
        if (val > max) max = val;
    }
    if (max < 0.0001) return null;
    const multiplier = 0.95 / max;
    const result = new Float32Array(trimmed.length);
    for (let i = 0; i < trimmed.length; i++) result[i] = trimmed[i] * multiplier;
    return result;
}

self.onmessage = (event: MessageEvent) => {
    const { audioData, sampleRate } = event.data;
    const inputAudio = audioData instanceof Float32Array ? audioData : new Float32Array(audioData);
    let processed = inputAudio;
    if (sampleRate !== 16000) {
        processed = resampleAudio(inputAudio, sampleRate, 16000);
    }
    const normalized = normalizeAudio(processed);
    if (!normalized) {
        self.postMessage({ success: false, error: 'silent' });
        return;
    }
    (self as unknown as Worker).postMessage(
        { success: true, processedAudio: normalized },
        [normalized.buffer]
    );
};
