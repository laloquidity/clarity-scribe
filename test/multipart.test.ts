/**
 * multipart/form-data parser tests.
 *
 * The parser exists to pull an audio file out of an upload, so the cases that
 * matter are the binary ones: bytes that are not valid UTF-8, bytes that
 * contain CRLF and `--` sequences of their own, and an empty trailing part.
 * A parser that works on strings passes the text cases and silently corrupts
 * every real recording, so several tests here assert byte-for-byte equality on
 * deliberately hostile payloads.
 */
import { describe, it, expect } from 'vitest';
import { parseBoundary, parseMultipart, findPart, fieldValue } from '../electron/multipart';

const BOUNDARY = '----ScribeTestBoundary7MA4YWxkTrZu0gW';

/** Build a multipart body the way a real HTTP client would. */
function buildBody(
    parts: Array<{ name: string; value: string | Buffer; filename?: string; contentType?: string }>,
    boundary = BOUNDARY
): Buffer {
    const chunks: Buffer[] = [];
    for (const part of parts) {
        let headers = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`;
        if (part.filename !== undefined) headers += `; filename="${part.filename}"`;
        headers += '\r\n';
        if (part.contentType) headers += `Content-Type: ${part.contentType}\r\n`;
        headers += '\r\n';
        chunks.push(Buffer.from(headers, 'latin1'));
        chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value, 'utf8'));
        chunks.push(Buffer.from('\r\n', 'latin1'));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`, 'latin1'));
    return Buffer.concat(chunks);
}

describe('parseBoundary', () => {
    it('reads a bare boundary token', () => {
        expect(parseBoundary(`multipart/form-data; boundary=${BOUNDARY}`)).toBe(BOUNDARY);
    });

    it('reads a quoted boundary', () => {
        expect(parseBoundary('multipart/form-data; boundary="abc=def"')).toBe('abc=def');
    });

    it('is case-insensitive on the type and the parameter name', () => {
        expect(parseBoundary('MULTIPART/FORM-DATA; BOUNDARY=xyz')).toBe('xyz');
    });

    it('tolerates a charset parameter before the boundary', () => {
        expect(parseBoundary('multipart/form-data; charset=utf-8; boundary=xyz')).toBe('xyz');
    });

    it('rejects a non-multipart content type', () => {
        expect(parseBoundary('application/json')).toBeNull();
        expect(parseBoundary('audio/mpeg')).toBeNull();
    });

    it('rejects multipart with no boundary, and a missing header', () => {
        expect(parseBoundary('multipart/form-data')).toBeNull();
        expect(parseBoundary(undefined)).toBeNull();
    });
});

describe('parseMultipart', () => {
    it('pulls out named text fields', () => {
        const body = buildBody([
            { name: 'model', value: 'scribe' },
            { name: 'response_format', value: 'json' },
            { name: 'language', value: 'en' },
        ]);
        const parts = parseMultipart(body, BOUNDARY);
        expect(parts).toHaveLength(3);
        expect(fieldValue(parts, 'model')).toBe('scribe');
        expect(fieldValue(parts, 'response_format')).toBe('json');
        expect(fieldValue(parts, 'language')).toBe('en');
    });

    it('keeps a file part byte-for-byte, including invalid UTF-8', () => {
        // Bytes that a UTF-8 round trip would replace with U+FFFD — exactly what
        // corrupts a compressed audio file if the parser ever touches strings.
        const audio = Buffer.from([
            0xff, 0xfb, 0x90, 0x64, 0x00, 0x0f, 0xf0, 0x00, 0x80, 0xc0, 0xfe, 0xff,
            0x00, 0x00, 0xd8, 0x00, 0xdc, 0x00, 0xed, 0xa0, 0x80,
        ]);
        const body = buildBody([{ name: 'file', value: audio, filename: 'call.mp3', contentType: 'audio/mpeg' }]);

        const file = findPart(parseMultipart(body, BOUNDARY), 'file')!;
        expect(file.filename).toBe('call.mp3');
        expect(file.contentType).toBe('audio/mpeg');
        expect(Buffer.compare(file.data, audio)).toBe(0);
    });

    it('keeps payload bytes that look like line breaks and dashes', () => {
        // A real audio file will contain CRLF and `--` runs. Only the actual
        // boundary may terminate a part.
        const tricky = Buffer.concat([
            Buffer.from('\r\n--nottheboundary\r\n', 'latin1'),
            Buffer.from([0x00, 0x0d, 0x0a, 0x2d, 0x2d]),
            Buffer.from('\r\n\r\n', 'latin1'),
        ]);
        const body = buildBody([{ name: 'file', value: tricky, filename: 'a.wav' }]);
        const file = findPart(parseMultipart(body, BOUNDARY), 'file')!;
        expect(Buffer.compare(file.data, tricky)).toBe(0);
    });

    it('does not swallow a payload byte when the data ends in 0x0a', () => {
        // The trailing-CRLF trim must not eat a real final byte.
        const audio = Buffer.from([0x01, 0x02, 0x0a]);
        const body = buildBody([{ name: 'file', value: audio, filename: 'a.wav' }]);
        const file = findPart(parseMultipart(body, BOUNDARY), 'file')!;
        expect(Buffer.compare(file.data, audio)).toBe(0);
    });

    it('handles a mixed body of fields and a file in any order', () => {
        const audio = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x99, 0x88]);
        const body = buildBody([
            { name: 'model', value: 'scribe' },
            { name: 'file', value: audio, filename: 'scoping call.m4a', contentType: 'audio/mp4' },
            { name: 'response_format', value: 'json' },
        ]);
        const parts = parseMultipart(body, BOUNDARY);
        expect(parts.map((p) => p.name)).toEqual(['model', 'file', 'response_format']);
        expect(findPart(parts, 'file')!.filename).toBe('scoping call.m4a');
        expect(Buffer.compare(findPart(parts, 'file')!.data, audio)).toBe(0);
    });

    it('accepts an empty part without losing the parts after it', () => {
        const body = buildBody([
            { name: 'prompt', value: '' },
            { name: 'model', value: 'scribe' },
        ]);
        const parts = parseMultipart(body, BOUNDARY);
        expect(parts).toHaveLength(2);
        expect(fieldValue(parts, 'prompt')).toBe('');
        expect(fieldValue(parts, 'model')).toBe('scribe');
    });

    it('decodes an RFC 5987 filename with non-ASCII characters', () => {
        const raw = Buffer.concat([
            Buffer.from(
                `--${BOUNDARY}\r\n` +
                `Content-Disposition: form-data; name="file"; filename="reunion.m4a"; filename*=UTF-8''r%C3%A9union.m4a\r\n\r\n`,
                'latin1'
            ),
            Buffer.from([0x00, 0x01]),
            Buffer.from(`\r\n--${BOUNDARY}--\r\n`, 'latin1'),
        ]);
        const file = findPart(parseMultipart(raw, BOUNDARY), 'file')!;
        expect(file.filename).toBe('réunion.m4a');
    });

    it('unescapes a quoted filename containing a quote', () => {
        const raw = Buffer.concat([
            Buffer.from(
                `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="the \\"big\\" call.wav"\r\n\r\n`,
                'latin1'
            ),
            Buffer.from([0x00]),
            Buffer.from(`\r\n--${BOUNDARY}--\r\n`, 'latin1'),
        ]);
        expect(findPart(parseMultipart(raw, BOUNDARY), 'file')!.filename).toBe('the "big" call.wav');
    });

    it('reads headers case-insensitively', () => {
        const raw = Buffer.concat([
            Buffer.from(
                `--${BOUNDARY}\r\ncontent-disposition: form-data; NAME="model"\r\nCONTENT-TYPE: text/plain\r\n\r\nscribe\r\n--${BOUNDARY}--\r\n`,
                'latin1'
            ),
        ]);
        const parts = parseMultipart(raw, BOUNDARY);
        expect(fieldValue(parts, 'model')).toBe('scribe');
        expect(parts[0].contentType).toBe('text/plain');
    });

    it('parses a body that uses bare LF line breaks', () => {
        const raw = Buffer.from(
            `--${BOUNDARY}\nContent-Disposition: form-data; name="model"\n\nscribe\n--${BOUNDARY}--\n`,
            'latin1'
        );
        expect(fieldValue(parseMultipart(raw, BOUNDARY), 'model')).toBe('scribe');
    });

    it('throws a readable error when the boundary is absent from the body', () => {
        expect(() => parseMultipart(Buffer.from('not multipart at all'), BOUNDARY))
            .toThrow(/boundary .* does not appear in the body/i);
    });

    it('throws a readable error when the body is truncated mid-upload', () => {
        const full = buildBody([{ name: 'file', value: Buffer.alloc(64, 7), filename: 'a.wav' }]);
        const truncated = full.subarray(0, full.length - 40);
        expect(() => parseMultipart(truncated, BOUNDARY)).toThrow(/truncated/i);
    });

    it('throws when a part has no blank line after its headers', () => {
        const raw = Buffer.from(
            `--${BOUNDARY}\r\nContent-Disposition: form-data; name="model"\r\n`,
            'latin1'
        );
        expect(() => parseMultipart(raw, BOUNDARY)).toThrow(/blank line|truncated/i);
    });

    it('ignores an epilogue after the closing boundary', () => {
        const body = Buffer.concat([
            buildBody([{ name: 'model', value: 'scribe' }]),
            Buffer.from('trailing junk a client appended\r\n', 'latin1'),
        ]);
        const parts = parseMultipart(body, BOUNDARY);
        expect(parts).toHaveLength(1);
        expect(fieldValue(parts, 'model')).toBe('scribe');
    });

    it('returns a view into the body rather than a copy', () => {
        // A 25 MB upload must not be duplicated on the way through.
        const audio = Buffer.alloc(1024, 0xab);
        const body = buildBody([{ name: 'file', value: audio, filename: 'a.wav' }]);
        const file = findPart(parseMultipart(body, BOUNDARY), 'file')!;
        expect(file.data.buffer).toBe(body.buffer);
    });
});
