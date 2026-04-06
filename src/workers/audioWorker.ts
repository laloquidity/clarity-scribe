/**
 * Audio Processing Worker — resampling only
 *
 * Previously included trimSilence (clipped word-initial consonants) and
 * normalizeAudio (amplified background noise to near-max levels).
 * Both were removed: the browser's getUserMedia already provides clean
 * [-1,1] float audio, and Whisper/Parakeet are trained on natural audio
 * with silence and varying dynamics.
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

self.onmessage = (event: MessageEvent) => {
    const { audioData, sampleRate } = event.data;
    const inputAudio = audioData instanceof Float32Array ? audioData : new Float32Array(audioData);
    let processed = inputAudio;
    if (sampleRate !== 16000) {
        processed = resampleAudio(inputAudio, sampleRate, 16000);
    }

    // Reject silent/empty audio (< 0.5s or near-zero energy)
    if (processed.length < 8000) {
        self.postMessage({ success: false, error: 'silent' });
        return;
    }
    let maxAbs = 0;
    for (let i = 0; i < processed.length; i++) {
        const v = Math.abs(processed[i]);
        if (v > maxAbs) maxAbs = v;
    }
    if (maxAbs < 0.001) {
        self.postMessage({ success: false, error: 'silent' });
        return;
    }

    (self as unknown as Worker).postMessage(
        { success: true, processedAudio: processed },
        [processed.buffer]
    );
};
