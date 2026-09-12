/**
 * multipart/form-data parser — zero dependencies, binary-safe.
 *
 * WHY hand-rolled: the Local API is deliberately dependency-free (stock Node
 * `http`, see localApi.ts), and it needs exactly one thing from the multipart
 * spec — pull a handful of named parts, one of which is an audio file, out of a
 * body we already hold in memory. Pulling in busboy/formidable would add a
 * dependency tree (and a streaming abstraction we don't use) to read four
 * fields.
 *
 * WHY Buffer-only, never strings: audio bytes are not text. Converting the body
 * to a UTF-8 string to `split()` on the boundary corrupts every byte that isn't
 * valid UTF-8 — which is most of a compressed audio file. Every operation here
 * works on `Buffer`, and `data` is returned as a `subarray` (a view, not a
 * copy) so a 25 MB upload isn't duplicated on the way through.
 *
 * Scope: parses a COMPLETE body that is already buffered. It does not stream,
 * does not spill to disk, and does not support nested `multipart/mixed`. That
 * matches the caller, which enforces a size cap before it ever gets here.
 */

/** One decoded form part. `data` is a view into the caller's body buffer. */
export interface MultipartPart {
    /** The `name=` from Content-Disposition. Empty string if absent. */
    name: string;
    /** The `filename=` from Content-Disposition, if the part is a file. */
    filename?: string;
    /** The part's own Content-Type header, if it declared one. */
    contentType?: string;
    /** Raw bytes of the part body, with the trailing CRLF removed. */
    data: Buffer;
}

/** Bytes of the two-character `--` sequence, checked by value below. */
const DASH = 0x2d;
const CR = 0x0d;
const LF = 0x0a;

/**
 * Pull the boundary token out of a `Content-Type` header value.
 *
 * Returns null when the header is absent, is not multipart/form-data, or
 * carries no boundary — all of which are client errors the caller reports as
 * such rather than guessing at.
 *
 * Handles the quoted form (`boundary="---x"`), which clients are allowed to
 * send and which some HTTP libraries emit for boundaries containing `=`.
 */
export function parseBoundary(contentType: string | undefined): string | null {
    if (!contentType) return null;
    if (!/^\s*multipart\/form-data\b/i.test(contentType)) return null;

    // `boundary` is case-insensitive as a parameter name. Accept a quoted or
    // bare token; a bare token ends at the next `;` or whitespace.
    const m = /;\s*boundary\s*=\s*(?:"([^"]*)"|([^;\s]+))/i.exec(contentType);
    const boundary = m ? (m[1] ?? m[2]) : null;
    return boundary && boundary.length > 0 ? boundary : null;
}

/**
 * Split a buffered multipart body into its parts.
 *
 * Throws `Error` with a human-readable message on a malformed body — the caller
 * surfaces that text to the client, so the message must read like an
 * explanation and not like an internal assertion.
 */
export function parseMultipart(body: Buffer, boundary: string): MultipartPart[] {
    // Per RFC 2046 the delimiter is `--` + boundary. The first one sits at the
    // very start of the body (no leading CRLF); every later one is preceded by
    // the CRLF that terminates the previous part's data. Searching for the bare
    // delimiter handles both, and we strip that trailing CRLF from the data.
    const delimiter = Buffer.from(`--${boundary}`, 'latin1');

    let cursor = body.indexOf(delimiter);
    if (cursor < 0) {
        throw new Error('Malformed multipart body: the boundary from the Content-Type header does not appear in the body.');
    }
    cursor += delimiter.length;

    const parts: MultipartPart[] = [];

    // Hard ceiling on part count. A body crafted with thousands of empty parts
    // would otherwise spin here; no legitimate caller sends more than a few.
    const MAX_PARTS = 64;

    while (parts.length <= MAX_PARTS) {
        // Right after a delimiter we are at one of two places: the closing
        // delimiter's `--`, or the CRLF that introduces this part's headers.
        if (body[cursor] === DASH && body[cursor + 1] === DASH) {
            return parts; // closing delimiter — done, trailing epilogue ignored
        }

        // Skip the line break after the delimiter. CRLF is the spec; accept a
        // bare LF too, because some hand-rolled clients emit it and rejecting
        // an otherwise-readable body helps nobody.
        if (body[cursor] === CR && body[cursor + 1] === LF) cursor += 2;
        else if (body[cursor] === LF) cursor += 1;
        else throw new Error('Malformed multipart body: expected a line break after a part boundary.');

        // Headers run to the first blank line. Try CRLFCRLF first (the spec),
        // then LFLF, so a bare-LF client parses rather than erroring.
        let headerEnd = body.indexOf('\r\n\r\n', cursor, 'latin1');
        let headerSkip = 4;
        const lfEnd = body.indexOf('\n\n', cursor, 'latin1');
        if (headerEnd < 0 || (lfEnd >= 0 && lfEnd < headerEnd)) {
            headerEnd = lfEnd;
            headerSkip = 2;
        }
        if (headerEnd < 0) {
            throw new Error('Malformed multipart body: a part has no blank line between its headers and its content.');
        }

        // Header names/values are ASCII by spec; latin1 keeps every byte
        // one-to-one so a stray high byte can't throw off the offsets.
        const headers = body.toString('latin1', cursor, headerEnd);
        const dataStart = headerEnd + headerSkip;

        // The next delimiter terminates this part's data. A legitimate client
        // picks a boundary that does not occur in the payload — that is the
        // whole contract of the boundary, and every multipart parser relies on
        // it.
        const nextDelimiter = body.indexOf(delimiter, dataStart);
        if (nextDelimiter < 0) {
            throw new Error('Malformed multipart body: the upload ended before its closing boundary (truncated request?).');
        }

        // Trim the CRLF (or bare LF) that belongs to the delimiter, not the data.
        let dataEnd = nextDelimiter;
        if (body[dataEnd - 2] === CR && body[dataEnd - 1] === LF) dataEnd -= 2;
        else if (body[dataEnd - 1] === LF) dataEnd -= 1;

        const disposition = headerValue(headers, 'content-disposition');
        parts.push({
            name: headerParam(disposition, 'name') ?? '',
            filename: headerParam(disposition, 'filename'),
            contentType: headerValue(headers, 'content-type') || undefined,
            // subarray, not slice: a view, so a 25 MB file is not copied here.
            data: body.subarray(dataStart, Math.max(dataStart, dataEnd)),
        });

        cursor = nextDelimiter + delimiter.length;
    }

    throw new Error(`Malformed multipart body: more than ${MAX_PARTS} parts.`);
}

/** Find one header's value in a raw part-header block, case-insensitively. */
function headerValue(headers: string, name: string): string {
    for (const line of headers.split(/\r?\n/)) {
        const colon = line.indexOf(':');
        if (colon < 0) continue;
        if (line.slice(0, colon).trim().toLowerCase() === name) {
            return line.slice(colon + 1).trim();
        }
    }
    return '';
}

/**
 * Read one parameter out of a header value (`name="file"`, `filename=call.m4a`).
 *
 * Prefers RFC 5987's `name*=UTF-8''...` extended form when present, because
 * that is the only form that carries non-ASCII filenames correctly — a phone
 * recording named with an accented word arrives that way. Falls back to the
 * quoted form, then a bare token.
 */
function headerParam(headerVal: string, name: string): string | undefined {
    const ext = new RegExp(`;\\s*${name}\\*\\s*=\\s*([^;]+)`, 'i').exec(headerVal);
    if (ext) {
        // charset'language'percent-encoded-value — we only need the value.
        const raw = ext[1].trim();
        const quote = String.fromCharCode(39); // apostrophe, as the RFC separator
        const encoded = raw.split(quote).pop() ?? raw;
        try {
            return decodeURIComponent(encoded);
        } catch {
            return encoded; // malformed escape: hand back what was sent
        }
    }

    const m = new RegExp(`;\\s*${name}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([^;]+))`, 'i').exec(headerVal);
    if (!m) return undefined;
    if (m[1] !== undefined) return m[1].replace(/\\(.)/g, '$1'); // unescape \" and \\
    return m[2].trim();
}

/** Convenience: the first part with this `name`, or undefined. */
export function findPart(parts: MultipartPart[], name: string): MultipartPart | undefined {
    return parts.find((p) => p.name === name);
}

/** Convenience: a named part's content decoded as a UTF-8 field value. */
export function fieldValue(parts: MultipartPart[], name: string): string | undefined {
    const part = findPart(parts, name);
    return part ? part.data.toString('utf8').trim() : undefined;
}
