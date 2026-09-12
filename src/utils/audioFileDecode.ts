/**
 * Audio file decoding for the file-transcription endpoint.
 *
 * WHY this lives in the renderer: the transcription engines need 16 kHz mono
 * float samples, but the endpoint is handed an `.m4a` off a phone, an `.mp3`,
 * an `.ogg`. Decoding those means real codecs. Electron already ships them —
 * Chromium's media stack, including the proprietary AAC/MP3 decoders in the
 * official builds — but only the renderer can reach it, through Web Audio.
 * The main process has no audio codecs at all.
 *
 * The alternative was bundling FFmpeg (tens of megabytes on top of an installer
 * that is already ~913 MB, plus a per-platform binary to sign and ship) or a
 * pure-JS decoder per format. Using the decoder that is already in the box
 * costs nothing and covers every container the endpoint advertises.
 *
 * WHY Web Audio does the resampling too: `decodeAudioData` resamples to the
 * context's sample rate, and rendering through an `OfflineAudioContext`
 * downmixes to mono by the spec's rules. Both steps run in Chromium's native
 * code with a proper anti-aliasing filter. Hand-rolling that in JavaScript
 * would be slower and would fold everything above 8 kHz back into the speech
 * band, which costs accuracy on exactly the consonants that carry meaning.
 */

/** What the engines consume. Fixed by the model, not a preference. */
export const TARGET_SAMPLE_RATE = 16000;

/**
 * Decode an encoded audio file into 16 kHz mono float samples.
 *
 * Throws with a message written for a human — the HTTP layer hands it straight
 * to the caller's user, so "the file is not audio Scribe can read" beats
 * "EncodingError".
 */
export async function decodeAudioToMono16k(bytes: Uint8Array, mimeHint = ''): Promise<Float32Array> {
    // `decodeAudioData` detaches the buffer it is given, so hand it a copy —
    // otherwise a retry (or the caller's own bytes) would see an empty buffer.
    const arrayBuffer = bytes.slice().buffer as ArrayBuffer;

    // A 1-frame context is enough to decode into: `decodeAudioData` sizes its
    // own output and only reads the context's SAMPLE RATE, which is what makes
    // it resample for us in a single native pass.
    const probeCtx = new OfflineAudioContext(1, 1, TARGET_SAMPLE_RATE);

    let decoded: AudioBuffer;
    try {
        decoded = await probeCtx.decodeAudioData(arrayBuffer);
    } catch (e: any) {
        const detail = e?.message ? ` (${e.message})` : '';
        throw new Error(
            `Could not decode the audio${mimeHint ? ` (sent as ${mimeHint})` : ''}. ` +
            `The file may be corrupt, truncated, or in a codec this system cannot play${detail}.`
        );
    }

    if (decoded.length === 0) {
        throw new Error('The audio file decoded to zero samples — it contains no audio.');
    }

    // Already exactly what the engines want: skip the render pass entirely.
    // This is the common case for machine-generated 16 kHz mono WAV.
    if (decoded.sampleRate === TARGET_SAMPLE_RATE && decoded.numberOfChannels === 1) {
        return decoded.getChannelData(0).slice();
    }

    // Otherwise render through a mono 16 kHz context. This does the channel
    // downmix (stereo averages L and R; more exotic layouts follow the Web
    // Audio downmix rules) and, if `decodeAudioData` handed back something at
    // another rate, the resample as well.
    const frames = Math.max(1, Math.ceil((decoded.length / decoded.sampleRate) * TARGET_SAMPLE_RATE));
    const ctx = new OfflineAudioContext(1, frames, TARGET_SAMPLE_RATE);
    const source = ctx.createBufferSource();
    source.buffer = decoded;
    source.connect(ctx.destination);
    source.start();

    const rendered = await ctx.startRendering();
    return rendered.getChannelData(0).slice();
}
