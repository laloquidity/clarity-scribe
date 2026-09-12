/**
 * File-transcription orchestration tests.
 *
 * This is the layer between the HTTP endpoint and the engines: it hands the
 * bytes to a renderer for decoding, reassembles the chunked reply, runs the
 * engines, and sends the text back for cleanup. Electron never appears — the
 * renderer is a fake that speaks the same message protocol, which is the point
 * of the injected `sendToRenderer`.
 *
 * The cases that matter are the ones that would otherwise show up as a hung
 * request or a wrong transcript: a chunked transfer reassembled out of order, a
 * dictation holding the engines, a window that never answers, and a decode
 * failure that has to surface as the caller's error text rather than a 500.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    transcribeUploadedFile,
    handleRendererMessage,
    JOB_REQUEST_CHANNEL,
    __resetFileTranscription,
} from '../electron/fileTranscription';
import type { FileTranscriptionDeps } from '../electron/fileTranscription';

/** A minimal but valid-looking WAV header, padded past the size gate. */
function wavBytes(size = 4096): Buffer {
    const buf = Buffer.alloc(size, 0x20);
    buf.write('RIFF', 0, 'latin1');
    buf.writeUInt32LE(size - 8, 4);
    buf.write('WAVE', 8, 'latin1');
    return buf;
}

/** Samples that are easy to assert on: value === index. */
function ramp(n: number): Float32Array {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = i;
    return out;
}

interface FakeRenderer {
    /** Every job the main process sent down. */
    jobs: Array<any>;
    deps: FileTranscriptionDeps;
    transcribeCalls: Array<{ samples: number; language?: string }>;
}

/**
 * Build deps whose renderer answers automatically: decode jobs return `pcm`
 * split across `chunks` messages, postprocess jobs return the text uppercased
 * so a test can prove the cleanup step actually ran.
 */
function makeDeps(opts: {
    pcm?: Float32Array;
    chunks?: number;
    transcript?: string;
    decodeError?: string;
    postprocessError?: string;
    busy?: string | null;
    ready?: boolean;
    autoRespond?: boolean;
    windowPresent?: boolean;
} = {}): FakeRenderer {
    const {
        pcm = ramp(16000),
        chunks = 1,
        transcript = 'so what does the onboarding look like',
        decodeError,
        postprocessError,
        busy = null,
        ready = true,
        autoRespond = true,
        windowPresent = true,
    } = opts;

    const fake: FakeRenderer = { jobs: [], deps: null as any, transcribeCalls: [] };

    fake.deps = {
        sendToRenderer: (channel, payload: any) => {
            expect(channel).toBe(JOB_REQUEST_CHANNEL);
            if (!windowPresent) return false;
            fake.jobs.push(payload);
            if (!autoRespond) return true;

            // Answer on a later turn, the way a real renderer would.
            queueMicrotask(() => {
                if (payload.kind === 'decode') {
                    if (decodeError) {
                        handleRendererMessage({ jobId: payload.jobId, kind: 'error', message: decodeError });
                        return;
                    }
                    handleRendererMessage({ jobId: payload.jobId, kind: 'begin', totalSamples: pcm.length });
                    const per = Math.ceil(pcm.length / chunks);
                    for (let offset = 0; offset < pcm.length; offset += per) {
                        handleRendererMessage({
                            jobId: payload.jobId,
                            kind: 'chunk',
                            offset,
                            samples: pcm.slice(offset, Math.min(offset + per, pcm.length)),
                        });
                    }
                    handleRendererMessage({ jobId: payload.jobId, kind: 'done' });
                    return;
                }
                if (payload.kind === 'postprocess') {
                    if (postprocessError) {
                        handleRendererMessage({ jobId: payload.jobId, kind: 'error', message: postprocessError });
                        return;
                    }
                    handleRendererMessage({ jobId: payload.jobId, kind: 'text', text: payload.text.toUpperCase() });
                }
            });
            return true;
        },
        transcribe: async (samples, language) => {
            fake.transcribeCalls.push({ samples: samples.length, language });
            return transcript;
        },
        busyReason: () => busy,
        engineReady: () => ready,
    };

    return fake;
}

beforeEach(() => __resetFileTranscription());
afterEach(() => {
    __resetFileTranscription();
    vi.useRealTimers();
});

describe('transcribeUploadedFile — the happy path', () => {
    it('decodes, transcribes, cleans up, and reports the duration', async () => {
        const fake = makeDeps({ pcm: ramp(32000) }); // 2 seconds at 16 kHz
        const result = await transcribeUploadedFile({ bytes: wavBytes(), filename: 'call.wav' }, fake.deps);

        expect(result.text).toBe('SO WHAT DOES THE ONBOARDING LOOK LIKE'); // cleanup ran
        expect(result.durationSec).toBeCloseTo(2, 5);
        expect(fake.jobs.map((j) => j.kind)).toEqual(['decode', 'postprocess']);
    });

    it('reassembles a chunked decode into the exact original samples', async () => {
        const pcm = ramp(100_000);
        const fake = makeDeps({ pcm, chunks: 7 });

        let delivered: Float32Array | null = null;
        fake.deps.transcribe = async (samples) => {
            delivered = samples.slice();
            return 'text';
        };

        await transcribeUploadedFile({ bytes: wavBytes(), filename: 'call.wav' }, fake.deps);

        expect(delivered).not.toBeNull();
        expect(delivered!.length).toBe(pcm.length);
        // Spot-check the seams, then the whole array.
        expect(Array.from(delivered!.slice(0, 4))).toEqual([0, 1, 2, 3]);
        expect(delivered![pcm.length - 1]).toBe(pcm.length - 1);
        expect(delivered!).toEqual(pcm);
    });

    it('passes the caller’s language through to the engines', async () => {
        const fake = makeDeps();
        await transcribeUploadedFile({ bytes: wavBytes(), filename: 'c.wav', language: 'de' }, fake.deps);
        expect(fake.transcribeCalls[0].language).toBe('de');
    });

    it('tells the renderer what kind of audio it is decoding', async () => {
        const fake = makeDeps();
        await transcribeUploadedFile({ bytes: wavBytes(), filename: 'call.wav' }, fake.deps);
        expect(fake.jobs[0].mime).toBe('audio/wav');
        expect(fake.jobs[0].bytes).toBeInstanceOf(Uint8Array);
    });

    it('returns an empty transcript for silence instead of failing', async () => {
        // Silence legitimately transcribes to nothing, and the contract has a
        // place for that. Erroring would make a quiet recording look broken.
        const fake = makeDeps({ transcript: '   ' });
        const result = await transcribeUploadedFile({ bytes: wavBytes(), filename: 'c.wav' }, fake.deps);
        expect(result.text).toBe('');
        expect(fake.jobs.map((j) => j.kind)).toEqual(['decode']); // no cleanup needed
    });

    it('releases the single-job slot so the next upload succeeds', async () => {
        const fake = makeDeps();
        await transcribeUploadedFile({ bytes: wavBytes(), filename: 'a.wav' }, fake.deps);
        await expect(transcribeUploadedFile({ bytes: wavBytes(), filename: 'b.wav' }, fake.deps)).resolves.toBeTruthy();
    });
});

describe('transcribeUploadedFile — refusals carry an HTTP status', () => {
    it('refuses with 409 while a dictation is recording', async () => {
        const fake = makeDeps({ busy: 'Clarity Scribe is recording a dictation right now.' });
        await expect(transcribeUploadedFile({ bytes: wavBytes(), filename: 'c.wav' }, fake.deps))
            .rejects.toMatchObject({ status: 409, message: expect.stringContaining('dictation') });
    });

    it('refuses with 409 when another upload is already running', async () => {
        const fake = makeDeps({ autoRespond: false });
        const first = transcribeUploadedFile({ bytes: wavBytes(), filename: 'first.wav' }, fake.deps);

        await expect(transcribeUploadedFile({ bytes: wavBytes(), filename: 'second.wav' }, fake.deps))
            .rejects.toMatchObject({ status: 409, message: expect.stringContaining('first.wav') });

        // Let the first one finish so the test leaves no dangling job.
        const job = fake.jobs[0];
        handleRendererMessage({ jobId: job.jobId, kind: 'error', message: 'cancelled' });
        await expect(first).rejects.toThrow();
    });

    it('refuses with 503 while the engines are still loading', async () => {
        const fake = makeDeps({ ready: false });
        await expect(transcribeUploadedFile({ bytes: wavBytes(), filename: 'c.wav' }, fake.deps))
            .rejects.toMatchObject({ status: 503, message: expect.stringMatching(/still loading/i) });
    });

    it('refuses with 503 when there is no window to decode with', async () => {
        const fake = makeDeps({ windowPresent: false });
        await expect(transcribeUploadedFile({ bytes: wavBytes(), filename: 'c.wav' }, fake.deps))
            .rejects.toMatchObject({ status: 503, message: expect.stringMatching(/not available|must be running/i) });
    });

    it('refuses with 400 and the sniffer’s wording when the file is not audio', async () => {
        const fake = makeDeps();
        const pdf = Buffer.alloc(4096, 0x20);
        pdf.write('%PDF-1.7', 0, 'latin1');

        await expect(transcribeUploadedFile({ bytes: pdf, filename: 'notes.pdf' }, fake.deps))
            .rejects.toMatchObject({ status: 400, message: expect.stringContaining('PDF') });

        expect(fake.jobs).toHaveLength(0); // rejected before any decode work
    });

    it('surfaces the decoder’s own message as a 400 when decoding fails', async () => {
        // A corrupt file is the caller's to fix. A 500 would read as a Scribe
        // bug and invite retries that can never succeed.
        const fake = makeDeps({ decodeError: 'Could not decode the audio. The file may be corrupt.' });
        await expect(transcribeUploadedFile({ bytes: wavBytes(), filename: 'c.wav' }, fake.deps))
            .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/may be corrupt/) });
    });

    it('refuses with 400 when the decode yields essentially no audio', async () => {
        const fake = makeDeps({ pcm: ramp(4) }); // 0.25 ms
        await expect(transcribeUploadedFile({ bytes: wavBytes(), filename: 'c.wav' }, fake.deps))
            .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/no audio/i) });
    });

    it('frees the single-job slot after a failure, not just a success', async () => {
        const fake = makeDeps({ decodeError: 'boom' });
        await expect(transcribeUploadedFile({ bytes: wavBytes(), filename: 'a.wav' }, fake.deps)).rejects.toThrow();

        const ok = makeDeps();
        await expect(transcribeUploadedFile({ bytes: wavBytes(), filename: 'b.wav' }, ok.deps)).resolves.toBeTruthy();
    });
});

describe('transcribeUploadedFile — degrading rather than failing', () => {
    it('returns the raw engine text when the cleanup step fails', async () => {
        // The expensive work is already done; losing filler removal is a far
        // better outcome than losing the transcript.
        const fake = makeDeps({ postprocessError: 'renderer blew up', transcript: 'the raw words' });
        const result = await transcribeUploadedFile({ bytes: wavBytes(), filename: 'c.wav' }, fake.deps);
        expect(result.text).toBe('the raw words');
    });

    it('returns the raw engine text when cleanup comes back empty', async () => {
        const fake = makeDeps({ transcript: 'the raw words' });
        const base = fake.deps.sendToRenderer;
        fake.deps.sendToRenderer = (channel, payload: any) => {
            if (payload.kind === 'postprocess') {
                queueMicrotask(() => handleRendererMessage({ jobId: payload.jobId, kind: 'text', text: '   ' }));
                return true;
            }
            return base(channel, payload);
        };
        const result = await transcribeUploadedFile({ bytes: wavBytes(), filename: 'c.wav' }, fake.deps);
        expect(result.text).toBe('the raw words');
    });
});

describe('handleRendererMessage — protocol robustness', () => {
    it('ignores replies for jobs it does not know about', () => {
        expect(() => handleRendererMessage({ jobId: 'never-issued', kind: 'done' })).not.toThrow();
        expect(() => handleRendererMessage(null)).not.toThrow();
        expect(() => handleRendererMessage({ kind: 'chunk' })).not.toThrow();
    });

    it('rejects a chunk that would overrun the declared length', async () => {
        const fake = makeDeps({ autoRespond: false });
        const promise = transcribeUploadedFile({ bytes: wavBytes(), filename: 'c.wav' }, fake.deps);
        await vi.waitFor(() => expect(fake.jobs).toHaveLength(1));

        const { jobId } = fake.jobs[0];
        handleRendererMessage({ jobId, kind: 'begin', totalSamples: 100 });
        handleRendererMessage({ jobId, kind: 'chunk', offset: 90, samples: ramp(50) });

        await expect(promise).rejects.toThrow(/larger than the renderer declared/i);
    });

    it('keeps a short transfer rather than padding it with silence', async () => {
        // If chunks go missing, the audio we hand the engines must be the audio
        // we actually received — trailing zeros would transcribe as silence and
        // quietly lengthen the recording.
        const fake = makeDeps({ autoRespond: false });
        let delivered: Float32Array | null = null;
        fake.deps.transcribe = async (samples) => { delivered = samples.slice(); return 'text'; };

        // The decode is driven by hand below, but the cleanup job still has to
        // be answered or the request waits on the liveness watchdog.
        const queued = fake.deps.sendToRenderer;
        fake.deps.sendToRenderer = (channel, payload: any) => {
            const sent = queued(channel, payload);
            if (payload.kind === 'postprocess') {
                queueMicrotask(() => handleRendererMessage({ jobId: payload.jobId, kind: 'text', text: payload.text }));
            }
            return sent;
        };

        const promise = transcribeUploadedFile({ bytes: wavBytes(), filename: 'c.wav' }, fake.deps);
        await vi.waitFor(() => expect(fake.jobs).toHaveLength(1));

        const { jobId } = fake.jobs[0];
        handleRendererMessage({ jobId, kind: 'begin', totalSamples: 32000 });
        handleRendererMessage({ jobId, kind: 'chunk', offset: 0, samples: ramp(16000) });
        handleRendererMessage({ jobId, kind: 'done' });

        await promise;
        expect(delivered!.length).toBe(16000);
    });

    it('fails the request when the renderer reports a zero-length decode', async () => {
        const fake = makeDeps({ autoRespond: false });
        const promise = transcribeUploadedFile({ bytes: wavBytes(), filename: 'c.wav' }, fake.deps);
        await vi.waitFor(() => expect(fake.jobs).toHaveLength(1));

        handleRendererMessage({ jobId: fake.jobs[0].jobId, kind: 'begin', totalSamples: 0 });
        await expect(promise).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/zero samples/i) });
    });
});

describe('transcribeUploadedFile — a renderer that stops answering', () => {
    it('fails with 504 instead of holding the caller open', async () => {
        vi.useFakeTimers();
        const fake = makeDeps({ autoRespond: false });

        const promise = transcribeUploadedFile({ bytes: wavBytes(), filename: 'c.wav' }, fake.deps);
        const assertion = expect(promise).rejects.toMatchObject({
            status: 504,
            message: expect.stringMatching(/stopped responding/i),
        });

        await vi.advanceTimersByTimeAsync(181_000);
        await assertion;
    });
});
