/**
 * useFileJobs — services the work the file-transcription endpoint sends down.
 *
 * `POST /v1/audio/transcriptions` is served by the main process, but two steps
 * of it can only happen in a window:
 *
 *   - **decode**: turning an `.m4a`/`.mp3`/`.ogg` upload into 16 kHz mono float
 *     samples. The codecs live in Chromium, reachable only through Web Audio.
 *   - **postprocess**: filler-word removal and Personal Dictionary replacement,
 *     which live here next to the dictation pipeline. Running the same cleanup
 *     means an uploaded recording comes out reading like the app's own output
 *     rather than like raw model text.
 *
 * WHY the window never needs focus: this is an IPC listener, not UI. The app
 * has to be running — it is the process hosting the server — but it can sit
 * minimized in the tray and still answer.
 *
 * Spoken punctuation is deliberately NOT applied here. It is a dictation
 * command language ("comma" → ","), and the audio arriving at this endpoint is
 * a recording of people talking, where "period" is the ordinary noun. Applying
 * it would corrupt exactly the meeting transcripts this endpoint exists for.
 */
import { useEffect } from 'react';
import { decodeAudioToMono16k } from '../utils/audioFileDecode';
import { cleanTranscription } from '../utils/cleanTranscription';
import { applyITN } from '../utils/itn';
import type { DictionaryEntry, FileJobRequest } from '../types';

/** Samples per reply message: 4M floats = 16 MB, ~4 minutes of audio. Bounded
 *  so a 45-minute call never becomes one enormous IPC payload. */
const CHUNK_SAMPLES = 4 * 1024 * 1024;

interface Options {
    /** Current Personal Dictionary, read at job time (not at mount time). */
    dictionary: React.MutableRefObject<DictionaryEntry[]>;
    /** Whether Smart Formatting (ITN) is on, read at job time. */
    itnEnabled: React.MutableRefObject<boolean>;
}

export function useFileJobs({ dictionary, itnEnabled }: Options): void {
    useEffect(() => {
        const api = window.electronAPI;
        if (!api?.onFileJob) return;

        const handle = async (job: FileJobRequest) => {
            const emit = api.fileJobEmit;
            try {
                if (job.kind === 'decode') {
                    const pcm = await decodeAudioToMono16k(job.bytes, job.mime);
                    emit({ jobId: job.jobId, kind: 'begin', totalSamples: pcm.length });
                    for (let offset = 0; offset < pcm.length; offset += CHUNK_SAMPLES) {
                        // `slice` (a copy, not a view) so structured clone sends
                        // just this window of samples and not the whole buffer.
                        const samples = pcm.slice(offset, Math.min(offset + CHUNK_SAMPLES, pcm.length));
                        emit({ jobId: job.jobId, kind: 'chunk', offset, samples });
                    }
                    emit({ jobId: job.jobId, kind: 'done' });
                    return;
                }

                if (job.kind === 'postprocess') {
                    // Same cleanup dictation gets, minus spoken punctuation.
                    let text = cleanTranscription(job.text, dictionary.current);
                    if (itnEnabled.current) {
                        text = applyITN(text, { punctuation: false });
                    }
                    emit({ jobId: job.jobId, kind: 'text', text });
                    return;
                }
            } catch (e: any) {
                emit({
                    jobId: (job as { jobId: string }).jobId,
                    kind: 'error',
                    message: String(e?.message || 'The audio could not be processed.'),
                });
            }
        };

        return api.onFileJob(handle);
    }, [dictionary, itnEnabled]);
}
