/**
 * Upload sniffing tests.
 *
 * The endpoint's error text is shown to a human verbatim, so these tests are as
 * much about the MESSAGE as the verdict: "that file looks like a PDF" is the
 * whole reason this module exists rather than letting the decoder fail with
 * "EncodingError".
 *
 * The other half of the contract is restraint — sniffing must not refuse a file
 * the decoder could have handled. Raw MP3 and ADTS-AAC have no dependable magic
 * number, so "unrecognized but plausibly named" has to pass through.
 */
import { describe, it, expect } from 'vitest';
import {
    sniffContainer,
    checkAudioUpload,
    extensionOf,
    mimeForContainer,
    SUPPORTED_EXTENSIONS,
} from '../electron/audioFile';

/** A buffer that starts with `head` and is padded past the minimum size gate. */
function file(head: number[] | string, size = 4096): Buffer {
    const buf = Buffer.alloc(size, 0x5a);
    const bytes = typeof head === 'string' ? Buffer.from(head, 'latin1') : Buffer.from(head);
    bytes.copy(buf, 0);
    return buf;
}

/** An MPEG-4 file: 4 size bytes, then the `ftyp` box. */
function mp4(brand = 'M4A '): Buffer {
    const buf = Buffer.alloc(4096, 0x11);
    buf.writeUInt32BE(24, 0);
    buf.write('ftyp', 4, 'latin1');
    buf.write(brand, 8, 'latin1');
    return buf;
}

describe('extensionOf', () => {
    it('lowercases and strips the dot', () => {
        expect(extensionOf('Call.M4A')).toBe('m4a');
        expect(extensionOf('recording.mp3')).toBe('mp3');
    });

    it('uses only the last segment of a path', () => {
        expect(extensionOf('C:\\Users\\me\\my.notes\\call.wav')).toBe('wav');
        expect(extensionOf('/home/me/calls/2026.06/call.flac')).toBe('flac');
    });

    it('returns empty for a name with no usable extension', () => {
        expect(extensionOf('recording')).toBe('');
        expect(extensionOf('.hidden')).toBe('');
        expect(extensionOf('trailing.')).toBe('');
        expect(extensionOf(undefined)).toBe('');
    });
});

describe('sniffContainer', () => {
    it('identifies containers by magic number', () => {
        const wav = Buffer.alloc(64);
        wav.write('RIFF', 0, 'latin1');
        wav.write('WAVE', 8, 'latin1');
        expect(sniffContainer(wav)).toBe('wav');

        expect(sniffContainer(file('fLaC'))).toBe('flac');
        expect(sniffContainer(file('OggS'))).toBe('ogg');
        expect(sniffContainer(file([0x1a, 0x45, 0xdf, 0xa3]))).toBe('webm');
        expect(sniffContainer(mp4())).toBe('mp4');
        expect(sniffContainer(file('ID3'))).toBe('mp3');
    });

    it('identifies AIFF, which shares the FORM header with other IFF files', () => {
        const aiff = Buffer.alloc(64);
        aiff.write('FORM', 0, 'latin1');
        aiff.write('AIFF', 8, 'latin1');
        expect(sniffContainer(aiff)).toBe('aiff');
    });

    it('recognizes a bare MP3 frame sync', () => {
        // 0xFF 0xFB = MPEG-1 Layer III, the usual encoder output.
        expect(sniffContainer(file([0xff, 0xfb, 0x90, 0x64]))).toBe('mp3');
    });

    it('does not claim MP3 from a reserved layer or version field', () => {
        expect(sniffContainer(file([0xff, 0xe9, 0x00, 0x00]))).toBe('unknown'); // layer = 00
        expect(sniffContainer(file([0xff, 0xf9, 0x00, 0x00]))).toBe('unknown'); // version = 01
    });

    it('returns unknown for arbitrary bytes', () => {
        expect(sniffContainer(file([0x12, 0x34, 0x56, 0x78]))).toBe('unknown');
    });

    it('does not read past the end of a very short buffer', () => {
        expect(() => sniffContainer(Buffer.alloc(0))).not.toThrow();
        expect(sniffContainer(Buffer.from([0xff]))).toBe('unknown');
        expect(sniffContainer(Buffer.from('RIF', 'latin1'))).toBe('unknown');
    });
});

describe('checkAudioUpload', () => {
    it('accepts every container it can identify', () => {
        expect(checkAudioUpload(mp4(), 'call.m4a')).toMatchObject({ ok: true, container: 'mp4' });
        expect(checkAudioUpload(file('OggS'), 'call.ogg')).toMatchObject({ ok: true, container: 'ogg' });
        expect(checkAudioUpload(file('fLaC'), 'call.flac')).toMatchObject({ ok: true, container: 'flac' });
        expect(checkAudioUpload(file([0xff, 0xfb]), 'call.mp3')).toMatchObject({ ok: true, container: 'mp3' });
    });

    it('accepts an unrecognized file that carries a plausible extension', () => {
        // Raw ADTS-AAC and some MP3 variants have no dependable signature.
        // Refusing them here would break files the decoder handles fine.
        const check = checkAudioUpload(file([0x00, 0x11, 0x22, 0x33]), 'voice-memo.m4a');
        expect(check.ok).toBe(true);
    });

    it('accepts a file whose extension disagrees with its bytes', () => {
        // Phones do this constantly — AAC written under an .mp3 name. The bytes
        // decide, and the decoder is told what they actually are.
        const check = checkAudioUpload(mp4(), 'call.mp3');
        expect(check).toMatchObject({ ok: true, container: 'mp4', extension: 'mp3' });
    });

    it('names the wrong file type when someone uploads a document or image', () => {
        expect(checkAudioUpload(file('%PDF-1.7'), 'notes.pdf')).toMatchObject({
            ok: false,
            reason: expect.stringContaining('PDF'),
        });
        expect(checkAudioUpload(file([0x89, 0x50, 0x4e, 0x47]), 'shot.png')).toMatchObject({
            ok: false,
            reason: expect.stringContaining('PNG'),
        });
        expect(checkAudioUpload(file([0x50, 0x4b, 0x03, 0x04]), 'brief.docx')).toMatchObject({
            ok: false,
            reason: expect.stringMatching(/ZIP|docx/),
        });
    });

    it('rejects an empty upload and says it is empty', () => {
        expect(checkAudioUpload(Buffer.alloc(0), 'call.m4a')).toMatchObject({
            ok: false,
            reason: expect.stringContaining('empty'),
        });
    });

    it('rejects a file far too small to hold audio, and gives its size', () => {
        const check = checkAudioUpload(Buffer.alloc(12, 1), 'call.m4a');
        expect(check.ok).toBe(false);
        expect((check as { reason: string }).reason).toContain('12 bytes');
    });

    it('names an unsupported codec and says what to send instead', () => {
        const check = checkAudioUpload(file([0x30, 0x26, 0xb2, 0x75]), 'call.wma');
        expect(check.ok).toBe(false);
        expect((check as { reason: string }).reason).toMatch(/Windows Media Audio/);
        expect((check as { reason: string }).reason).toMatch(/\.m4a|\.mp3|\.wav/);
    });

    it('rejects AMR by its header even when the name lies', () => {
        const check = checkAudioUpload(file('#!AMR\n'), 'voice.m4a');
        expect(check.ok).toBe(false);
        expect((check as { reason: string }).reason).toContain('AMR');
    });

    it('rejects unidentifiable bytes that arrive with no filename at all', () => {
        const check = checkAudioUpload(file([0x00, 0x01, 0x02, 0x03]), undefined);
        expect(check.ok).toBe(false);
        expect((check as { reason: string }).reason).toMatch(/no recognizable audio header/i);
    });

    it('gives every rejection a complete sentence, since the user reads it', () => {
        const rejections = [
            checkAudioUpload(Buffer.alloc(0), 'a.m4a'),
            checkAudioUpload(Buffer.alloc(12), 'a.m4a'),
            checkAudioUpload(file('%PDF'), 'a.pdf'),
            checkAudioUpload(file([0x30, 0x26]), 'a.wma'),
            checkAudioUpload(file([0x00, 0x01]), undefined),
        ];
        for (const r of rejections) {
            expect(r.ok).toBe(false);
            const reason = (r as { reason: string }).reason;
            expect(reason.length).toBeGreaterThan(20);
            expect(reason).toMatch(/\.$/); // ends in a full stop
            expect(reason).not.toMatch(/^[a-z_]+$/); // never a bare error code
        }
    });
});

describe('mimeForContainer', () => {
    it('maps a sniffed container to a type Chromium understands', () => {
        expect(mimeForContainer('wav', 'wav')).toBe('audio/wav');
        expect(mimeForContainer('mp3', 'mp3')).toBe('audio/mpeg');
        expect(mimeForContainer('ogg', 'ogg')).toBe('audio/ogg');
        expect(mimeForContainer('flac', 'flac')).toBe('audio/flac');
        expect(mimeForContainer('webm', 'webm')).toBe('audio/webm');
    });

    it('distinguishes an audio-only .m4a from a .mp4 that may carry video', () => {
        expect(mimeForContainer('mp4', 'm4a')).toBe('audio/mp4');
        expect(mimeForContainer('mp4', 'mp4')).toBe('video/mp4');
    });

    it('falls back to the extension when the container is unknown', () => {
        expect(mimeForContainer('unknown', 'mpga')).toBe('audio/mpeg');
        expect(mimeForContainer('unknown', 'aac')).toBe('audio/mp4');
        expect(mimeForContainer('unknown', 'opus')).toBe('audio/ogg');
    });

    it('returns an empty hint rather than a wrong one when it cannot tell', () => {
        // Empty means "Chromium, sniff it yourself" — better than a bad guess.
        expect(mimeForContainer('unknown', '')).toBe('');
    });
});

describe('the advertised format list', () => {
    it('covers every extension the endpoint documents', () => {
        for (const ext of ['m4a', 'mp3', 'wav', 'webm', 'ogg', 'oga', 'flac', 'mp4', 'mpga']) {
            expect(SUPPORTED_EXTENSIONS).toContain(ext);
        }
    });
});
