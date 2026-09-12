/**
 * Audio container sniffing for the file-transcription endpoint.
 *
 * WHY sniff at all, when the decoder would reject bad input anyway: the client
 * shows our error message to a human verbatim, so "that file is a PDF, not
 * audio" is worth far more than "Unable to decode audio data". We look at the
 * first bytes — the container's magic number — because a filename extension is
 * a claim, not evidence: a phone that writes AAC into an `.mp3` name is common,
 * and so is an `.m4a` that is really an MP4 video track.
 *
 * WHY the extension still matters: a raw MP3 or ADTS-AAC stream has no reliable
 * magic number (frame sync bytes occur in arbitrary binary), so when sniffing
 * is inconclusive we fall back to the declared extension rather than refuse a
 * file the decoder would have handled. Sniffing here is an early, friendlier
 * error — never the authority on what can be decoded.
 *
 * Pure functions over a Buffer, no Electron and no I/O, so this is unit-tested
 * directly.
 */

/** Containers we recognize by magic number, plus the catch-alls. */
export type AudioContainer =
    | 'wav'
    | 'mp3'
    | 'mp4'   // covers .m4a/.mp4 — MPEG-4 container, usually AAC or ALAC
    | 'ogg'   // covers .ogg/.oga — Vorbis or Opus
    | 'webm'  // Matroska/WebM — usually Opus
    | 'flac'
    | 'aiff'
    | 'caf'
    | 'amr'
    | 'unknown';

/**
 * File extensions the endpoint accepts. This is the list Chromium's media stack
 * can decode in the Electron renderer that does the actual work — official
 * Electron builds ship proprietary codecs (AAC, MP3), which is what makes the
 * MPEG-4 family work.
 */
export const SUPPORTED_EXTENSIONS = [
    'm4a', 'mp3', 'wav', 'webm', 'ogg', 'oga', 'opus', 'flac', 'mp4', 'mpga', 'mpeg', 'aac', 'aiff', 'aif', 'caf',
] as const;

/** Extensions a human would plausibly send that we know we cannot decode. */
const KNOWN_UNSUPPORTED: Record<string, string> = {
    wma: 'Windows Media Audio',
    amr: 'AMR (older phone voice memos)',
    aa: 'Audible',
    aax: 'Audible',
    m4p: 'a DRM-protected iTunes file',
    dss: 'Digital Speech Standard',
    ds2: 'Digital Speech Standard',
    ra: 'RealAudio',
    mid: 'MIDI (which contains no recorded audio)',
    midi: 'MIDI (which contains no recorded audio)',
};

/** Non-audio types people upload by accident, recognized by magic number. */
const NOT_AUDIO_SIGNATURES: Array<{ bytes: number[]; what: string }> = [
    { bytes: [0x25, 0x50, 0x44, 0x46], what: 'a PDF document' },      // %PDF
    { bytes: [0x50, 0x4b, 0x03, 0x04], what: 'a ZIP archive (or a .docx/.xlsx)' },
    { bytes: [0x89, 0x50, 0x4e, 0x47], what: 'a PNG image' },
    { bytes: [0xff, 0xd8, 0xff], what: 'a JPEG image' },
    { bytes: [0x47, 0x49, 0x46, 0x38], what: 'a GIF image' },
    { bytes: [0x7b, 0x22], what: 'JSON text' },                       // {"
    { bytes: [0x1f, 0x8b], what: 'a gzip archive' },
];

/** Lowercased extension of a filename, without the dot. Empty if none. */
export function extensionOf(filename: string | undefined): string {
    if (!filename) return '';
    const base = filename.split(/[\\/]/).pop() ?? filename;
    const dot = base.lastIndexOf('.');
    if (dot <= 0 || dot === base.length - 1) return '';
    return base.slice(dot + 1).toLowerCase();
}

/** True when `buf` starts with these byte values. */
function startsWith(buf: Buffer, bytes: number[], offset = 0): boolean {
    if (buf.length < offset + bytes.length) return false;
    for (let i = 0; i < bytes.length; i++) {
        if (buf[offset + i] !== bytes[i]) return false;
    }
    return true;
}

/** ASCII tag check at a byte offset — used for RIFF/ftyp/form markers. */
function tagAt(buf: Buffer, offset: number, tag: string): boolean {
    if (buf.length < offset + tag.length) return false;
    return buf.toString('latin1', offset, offset + tag.length) === tag;
}

/**
 * Identify the container from its leading bytes.
 *
 * Returns 'unknown' for anything without a dependable signature — notably raw
 * MP3 and ADTS-AAC, which the caller then accepts on the strength of the
 * extension.
 */
export function sniffContainer(buf: Buffer): AudioContainer {
    if (tagAt(buf, 0, 'RIFF') && tagAt(buf, 8, 'WAVE')) return 'wav';
    if (tagAt(buf, 0, 'fLaC')) return 'flac';
    if (tagAt(buf, 0, 'OggS')) return 'ogg';
    if (tagAt(buf, 0, 'FORM') && (tagAt(buf, 8, 'AIFF') || tagAt(buf, 8, 'AIFC'))) return 'aiff';
    if (tagAt(buf, 0, 'caff')) return 'caf';
    if (tagAt(buf, 0, '#!AMR')) return 'amr';

    // Matroska/WebM — EBML header.
    if (startsWith(buf, [0x1a, 0x45, 0xdf, 0xa3])) return 'webm';

    // MPEG-4 family: a `ftyp` box at offset 4 (.m4a, .mp4, .m4b, .mov).
    if (tagAt(buf, 4, 'ftyp')) return 'mp4';

    // MP3: an ID3v2 tag, or an MPEG audio frame sync (11 set bits). The frame
    // sync alone is weak evidence, so it stays last and only claims `mp3` when
    // the layer/bitrate nibbles are not the reserved values.
    if (tagAt(buf, 0, 'ID3')) return 'mp3';
    if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) {
        const layer = (buf[1] >> 1) & 0x03;
        const version = (buf[1] >> 3) & 0x03;
        if (layer !== 0 && version !== 1) return 'mp3';
    }

    return 'unknown';
}

/** Outcome of validating an upload: either accepted, or rejected with a reason. */
export type AudioCheck =
    | { ok: true; container: AudioContainer; extension: string }
    | { ok: false; reason: string };

/**
 * Decide whether to hand these bytes to the decoder.
 *
 * Deliberately permissive: it rejects only what we can positively identify as
 * wrong (empty body, a recognized non-audio file, a codec we know Chromium
 * cannot open). Anything merely unrecognized is passed through, because the
 * decoder is the real authority and a false refusal is worse than a decode
 * error that names the file.
 */
export function checkAudioUpload(buf: Buffer, filename?: string): AudioCheck {
    if (buf.length === 0) {
        return { ok: false, reason: 'The uploaded file is empty (0 bytes).' };
    }

    // Too small to be even a fraction of a second of any real format; almost
    // always a truncated upload or a stray text field sent as the file.
    if (buf.length < 128) {
        return { ok: false, reason: `The uploaded file is only ${buf.length} bytes — too small to contain audio.` };
    }

    for (const sig of NOT_AUDIO_SIGNATURES) {
        if (startsWith(buf, sig.bytes)) {
            return { ok: false, reason: `That file looks like ${sig.what}, not an audio recording.` };
        }
    }

    const extension = extensionOf(filename);
    const container = sniffContainer(buf);

    // A known-unsupported codec: say so by name, and say what to send instead.
    // Checked against the sniffed container first, then the extension, so a
    // mislabeled file is still caught.
    if (container === 'amr') {
        return { ok: false, reason: 'AMR audio is not supported. Convert the recording to .m4a, .mp3 or .wav first.' };
    }
    if (container === 'unknown' && KNOWN_UNSUPPORTED[extension]) {
        return {
            ok: false,
            reason: `${KNOWN_UNSUPPORTED[extension]} (.${extension}) is not supported. Convert the recording to .m4a, .mp3 or .wav first.`,
        };
    }

    // Nothing recognizable and no usable extension: refuse, because we have no
    // evidence this is audio at all and the decoder's own message would be
    // unhelpfully generic.
    if (container === 'unknown' && !extension) {
        return {
            ok: false,
            reason: 'Could not tell what kind of file this is: it has no recognizable audio header and the upload carried no filename extension.',
        };
    }

    return { ok: true, container, extension };
}

/**
 * A MIME type for the decoder's `Blob`. Chromium sniffs the bytes itself and
 * does not depend on this being right, but a correct hint avoids the occasional
 * container ambiguity (a bare `.mp4` that holds only audio, for instance).
 */
export function mimeForContainer(container: AudioContainer, extension: string): string {
    switch (container) {
        case 'wav': return 'audio/wav';
        case 'mp3': return 'audio/mpeg';
        case 'mp4': return extension === 'mp4' ? 'video/mp4' : 'audio/mp4';
        case 'ogg': return 'audio/ogg';
        case 'webm': return 'audio/webm';
        case 'flac': return 'audio/flac';
        case 'aiff': return 'audio/aiff';
        case 'caf': return 'audio/x-caf';
        default:
            // Fall back to the extension's usual type; an empty string is fine
            // and tells Chromium to rely purely on its own sniffing.
            if (extension === 'mp3' || extension === 'mpga' || extension === 'mpeg') return 'audio/mpeg';
            if (extension === 'm4a' || extension === 'aac') return 'audio/mp4';
            if (extension === 'opus') return 'audio/ogg';
            return '';
    }
}
