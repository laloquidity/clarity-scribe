/**
 * useAudioRecording — Manages audio capture, processing, and transcription
 * Simplified from Clarity: removed smart edit, LLM warming, noise suppression
 */
import { useRef, useEffect, useCallback } from 'react';
import type { Settings, AppState } from '../types';
import { retainAudioContext, releaseAudioContext } from '../utils/audioContextManager';

interface UseAudioRecordingOptions {
    settings: Settings;
    onStateChange: (state: AppState) => void;
    onError: (message: string) => void;
    skipSilenceDetection?: boolean;
}

export function useAudioRecording(options: UseAudioRecordingOptions) {
    const { settings, onStateChange, onError, skipSilenceDetection } = options;
    const settingsRef = useRef(settings);

    useEffect(() => { settingsRef.current = settings; }, [settings]);

    const audioContextRef = useRef<AudioContext | null>(null);
    const processorRef = useRef<AudioWorkletNode | null>(null);
    const audioBuffersRef = useRef<Float32Array[]>([]);
    const streamCleanupRef = useRef<MediaStream | null>(null);
    const isRecordingRef = useRef(false);
    const isToggleBusyRef = useRef(false);
    const silenceIntervalRef = useRef<number | null>(null);
    const soundContextRef = useRef<AudioContext | null>(null);
    const audioWorkerRef = useRef<Worker | null>(null);
    const maxDurationTimeoutRef = useRef<number | null>(null);
    const silenceSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
    const silenceAnalyserRef = useRef<AnalyserNode | null>(null);
    const noAudioCheckRef = useRef<number | null>(null);
    const noAudioStartRef = useRef<number>(0);
    const noAudioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
    const noAudioAnalyserRef = useRef<AnalyserNode | null>(null);
    const streamingActiveRef = useRef(false);
    const streamPendingRef = useRef<Float32Array[]>([]);
    const streamPendingSamplesRef = useRef(0);
    const flushResolveRef = useRef<(() => void) | null>(null);

    const MAX_RECORDING_DURATION_MS = 30 * 60 * 1000;
    const STREAM_CHUNK_MS = 250; // batch worklet frames into ~250ms IPC chunks
    const NO_AUDIO_WINDOW_MS = 30_000;     // Check window: 30 seconds
    const NO_AUDIO_THRESHOLD = 0.80;        // 80% silence triggers auto-stop
    const NO_AUDIO_ENERGY_THRESHOLD = 10;   // Frequency-domain avg below this = silence (same as existing silence detection)

    // Initialize worker
    useEffect(() => {
        const worker = new Worker(
            new URL('../workers/audioWorker.ts', import.meta.url),
            { type: 'module' }
        );
        audioWorkerRef.current = worker;
        return () => worker.terminate();
    }, []);

    // Sound context for silence detection
    useEffect(() => {
        soundContextRef.current = retainAudioContext();
        return () => {
            releaseAudioContext();
            soundContextRef.current = null;
        };
    }, []);

    const stopStream = useCallback(() => {
        streamCleanupRef.current?.getTracks().forEach(t => t.stop());
        streamCleanupRef.current = null;
        if (processorRef.current) {
            processorRef.current.port.postMessage({ command: 'stop' });
            processorRef.current.disconnect();
            processorRef.current = null;
        }
        if (audioContextRef.current) {
            releaseAudioContext();
            audioContextRef.current = null;
        }
        if (silenceIntervalRef.current) {
            window.clearInterval(silenceIntervalRef.current);
            silenceIntervalRef.current = null;
        }
        if (maxDurationTimeoutRef.current) {
            window.clearTimeout(maxDurationTimeoutRef.current);
            maxDurationTimeoutRef.current = null;
        }
        if (noAudioCheckRef.current) {
            window.clearInterval(noAudioCheckRef.current);
            noAudioCheckRef.current = null;
        }
        if (noAudioSourceRef.current) {
            noAudioSourceRef.current.disconnect();
            noAudioSourceRef.current = null;
        }
        if (noAudioAnalyserRef.current) {
            noAudioAnalyserRef.current.disconnect();
            noAudioAnalyserRef.current = null;
        }
        if (silenceSourceRef.current) {
            silenceSourceRef.current.disconnect();
            silenceSourceRef.current = null;
        }
        if (silenceAnalyserRef.current) {
            silenceAnalyserRef.current.disconnect();
            silenceAnalyserRef.current = null;
        }
        isRecordingRef.current = false;
    }, []);

    const startSilenceDetection = useCallback(
        (stream: MediaStream, duration: number, stopCallback: () => void) => {
            if (duration === 0 || !soundContextRef.current) return;
            const ctx = soundContextRef.current;
            if (ctx.state === 'suspended') ctx.resume();

            const source = ctx.createMediaStreamSource(stream);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 256;
            source.connect(analyser);
            silenceSourceRef.current = source;
            silenceAnalyserRef.current = analyser;

            const bufferLength = analyser.frequencyBinCount;
            const dataArray = new Uint8Array(bufferLength);
            let lastSoundTime = Date.now();

            silenceIntervalRef.current = window.setInterval(() => {
                if (!silenceAnalyserRef.current) return;
                analyser.getByteFrequencyData(dataArray);
                const avg = dataArray.reduce((a, b) => a + b, 0) / bufferLength;
                if (avg > 10) lastSoundTime = Date.now();
                else if (Date.now() - lastSoundTime > duration) stopCallback();
            }, 100);
        },
        []
    );

    /** Send accumulated streaming chunks to the main process (fire-and-forget). */
    const flushStreamPending = useCallback(() => {
        if (!streamingActiveRef.current || streamPendingSamplesRef.current === 0) return;
        const total = streamPendingSamplesRef.current;
        const merged = new Float32Array(total);
        let off = 0;
        for (const b of streamPendingRef.current) { merged.set(b, off); off += b.length; }
        streamPendingRef.current = [];
        streamPendingSamplesRef.current = 0;
        window.electronAPI?.streamChunk?.(merged);
    }, []);

    const abortStreaming = useCallback(() => {
        if (streamingActiveRef.current) {
            streamingActiveRef.current = false;
            streamPendingRef.current = [];
            streamPendingSamplesRef.current = 0;
            window.electronAPI?.streamAbort?.();
        }
    }, []);

    const processRecordedAudio = useCallback(
        (chunks: Float32Array[], recordedSampleRate: number) => {
            const totalLength = chunks.reduce((acc, buf) => acc + buf.length, 0);
            if (totalLength === 0) { abortStreaming(); onStateChange('IDLE'); return; }

            const durationSeconds = totalLength / recordedSampleRate;
            if (durationSeconds < 1.0) {
                abortStreaming();
                onError('Recording too short. Speak for at least 1 second.');
                onStateChange('ERROR');
                return;
            }

            const fullBuffer = new Float32Array(totalLength);
            let offset = 0;
            for (const buf of chunks) { fullBuffer.set(buf, offset); offset += buf.length; }

            if (audioWorkerRef.current) {
                audioWorkerRef.current.onmessage = (event) => {
                    const { success, processedAudio, error } = event.data;
                    if (!success) { abortStreaming(); onStateChange('IDLE'); return; }

                    const api = window.electronAPI;
                    if (api?.transcribe) {
                        // If a streaming session ran during recording, the main
                        // process finalizes it inside 'transcribe' (tail only);
                        // the full buffer is the batch-path fallback.
                        streamingActiveRef.current = false;
                        api.transcribe(processedAudio, 16000);
                    } else {
                        abortStreaming();
                        onError('Transcription engine not available.');
                        onStateChange('ERROR');
                    }
                };
                audioWorkerRef.current.postMessage(
                    { audioData: fullBuffer, sampleRate: recordedSampleRate },
                    [fullBuffer.buffer]
                );
            }
        },
        [onStateChange, onError, abortStreaming]
    );

    const stopRecording = useCallback(() => {
        if (isToggleBusyRef.current || !isRecordingRef.current) {
            onStateChange('IDLE');
            return;
        }

        onStateChange('PROCESSING');
        const ctx = audioContextRef.current;

        if (ctx) {
            // Suspend FIRST — stops the hardware audio graph
            ctx.suspend().then(() => {
                // Flush handshake with the worklet: port messages are delivered
                // in order, so when the worklet answers 'flush' every prior audio
                // frame has already arrived. Replaces a fixed 50ms wait — typical
                // handshake completes in <5ms. 100ms timeout as a safety net.
                const flushed = new Promise<void>((resolve) => {
                    flushResolveRef.current = resolve;
                    processorRef.current?.port.postMessage({ command: 'flush' });
                    setTimeout(resolve, 100);
                });
                flushed.then(() => {
                    flushResolveRef.current = null;
                    isRecordingRef.current = false;
                    flushStreamPending(); // last partial stream chunk (tail)
                    const bufferChunks = [...audioBuffersRef.current];
                    processRecordedAudio(bufferChunks, ctx.sampleRate);
                    stopStream();
                });
            });
        } else {
            isRecordingRef.current = false;
            abortStreaming();
            stopStream();
            onStateChange('IDLE');
        }
    }, [processRecordedAudio, stopStream, onStateChange, flushStreamPending, abortStreaming]);

    const startRecording = useCallback(async () => {
        if (isToggleBusyRef.current) return;
        isToggleBusyRef.current = true;

        try {
            const constraints = {
                audio: {
                    deviceId: settingsRef.current.selectedMicId !== 'default'
                        ? { exact: settingsRef.current.selectedMicId }
                        : undefined,
                    channelCount: 1,
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                },
            };

            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            streamCleanupRef.current = stream;

            const audioCtx = retainAudioContext();
            audioContextRef.current = audioCtx;

            // Register AudioWorklet processor via inline Blob URL
            // (Vite doesn't bundle AudioWorklet modules for production builds)
            const processorCode = `
class AudioRecorderProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._isRecording = true;
        this.port.onmessage = (event) => {
            if (event.data.command === 'stop') this._isRecording = false;
            else if (event.data.command === 'start') this._isRecording = true;
            else if (event.data.command === 'flush') this.port.postMessage({ type: 'flushed' });
        };
    }
    process(inputs) {
        if (!this._isRecording) return true;
        const input = inputs[0];
        if (input && input.length > 0) {
            const channelData = input[0];
            if (channelData && channelData.length > 0) {
                const buffer = new Float32Array(channelData.length);
                buffer.set(channelData);
                this.port.postMessage({ type: 'audio', buffer }, [buffer.buffer]);
            }
        }
        return true;
    }
}
registerProcessor('audio-recorder-processor', AudioRecorderProcessor);
`;
            try {
                const blob = new Blob([processorCode], { type: 'application/javascript' });
                const url = URL.createObjectURL(blob);
                await audioCtx.audioWorklet.addModule(url);
                URL.revokeObjectURL(url);
            } catch { /* may already be registered */ }

            const source = audioCtx.createMediaStreamSource(stream);
            const processor = new AudioWorkletNode(audioCtx, 'audio-recorder-processor');
            processorRef.current = processor;
            audioBuffersRef.current = [];
            isRecordingRef.current = true;

            // Start a live streaming session (transcribe-while-recording) when
            // the engine supports it and the user hasn't disabled it. The full
            // buffer is still kept locally as the batch-path fallback.
            streamingActiveRef.current = false;
            streamPendingRef.current = [];
            streamPendingSamplesRef.current = 0;
            if (settingsRef.current.liveTranscription !== false && window.electronAPI?.streamStart) {
                window.electronAPI.streamStart(audioCtx.sampleRate)
                    .then((r: { streaming: boolean }) => { streamingActiveRef.current = !!r?.streaming; })
                    .catch(() => { streamingActiveRef.current = false; });
            }
            const streamChunkSamples = Math.round((STREAM_CHUNK_MS / 1000) * audioCtx.sampleRate);

            processor.port.onmessage = (event) => {
                if (event.data.type === 'flushed') {
                    flushResolveRef.current?.();
                    return;
                }
                if (!isRecordingRef.current) return;
                if (event.data.type === 'audio' && event.data.buffer) {
                    audioBuffersRef.current.push(event.data.buffer);
                    if (streamingActiveRef.current) {
                        streamPendingRef.current.push(event.data.buffer);
                        streamPendingSamplesRef.current += event.data.buffer.length;
                        if (streamPendingSamplesRef.current >= streamChunkSamples) {
                            flushStreamPending();
                        }
                    }
                }
            };

            source.connect(processor);
            const muteNode = audioCtx.createGain();
            muteNode.gain.value = 0;
            processor.connect(muteNode);
            muteNode.connect(audioCtx.destination);

            if (audioCtx.state === 'suspended') await audioCtx.resume();

            onStateChange('RECORDING');
            if (!skipSilenceDetection) {
                startSilenceDetection(stream, settingsRef.current.silenceDuration, stopRecording);
            }

            // No-audio safety net: if >80% of 30 seconds is silence, auto-stop.
            // Uses AnalyserNode frequency-domain energy (same proven approach as existing
            // silence detection, avg > 10 threshold). Independent of the per-pause silence
            // detection which checks continuous silence. This catches: wrong mic, mic muted,
            // user walked away, etc.
            noAudioStartRef.current = Date.now();
            let noAudioTotalChecks = 0;
            let noAudioSilentChecks = 0;

            // Create dedicated analyser for no-audio detection
            // (can't share with silence detection — that may not be initialized in hold mode)
            const noAudioCtx = soundContextRef.current;
            if (noAudioCtx) {
                if (noAudioCtx.state === 'suspended') noAudioCtx.resume();
                const noAudioSource = noAudioCtx.createMediaStreamSource(stream);
                const noAudioAnalyser = noAudioCtx.createAnalyser();
                noAudioAnalyser.fftSize = 256;
                noAudioSource.connect(noAudioAnalyser);
                noAudioSourceRef.current = noAudioSource;
                noAudioAnalyserRef.current = noAudioAnalyser;

                const bufLen = noAudioAnalyser.frequencyBinCount;
                const dataArr = new Uint8Array(bufLen);

                noAudioCheckRef.current = window.setInterval(() => {
                    if (!isRecordingRef.current) return;

                    // Sample current energy level
                    noAudioAnalyser.getByteFrequencyData(dataArr);
                    const avg = dataArr.reduce((a, b) => a + b, 0) / bufLen;
                    noAudioTotalChecks++;
                    if (avg <= NO_AUDIO_ENERGY_THRESHOLD) noAudioSilentChecks++;

                    // Only evaluate after the full 30s window
                    const elapsed = Date.now() - noAudioStartRef.current;
                    if (elapsed >= NO_AUDIO_WINDOW_MS && noAudioTotalChecks > 0) {
                        const silenceRatio = noAudioSilentChecks / noAudioTotalChecks;
                        if (silenceRatio >= NO_AUDIO_THRESHOLD) {
                            onError('No audio detected \u2014 Stopped recording');
                            stopRecording();
                        }
                    }
                }, 200); // Check 5x/sec for good granularity (~150 samples over 30s)
            }

            maxDurationTimeoutRef.current = window.setTimeout(() => {
                stopRecording();
            }, MAX_RECORDING_DURATION_MS);
        } catch (err: any) {
            onError(
                err?.message?.includes('Permission')
                    ? 'Microphone access denied.'
                    : 'Could not access microphone.'
            );
            onStateChange('ERROR');
        } finally {
            isToggleBusyRef.current = false;
        }
    }, [onStateChange, onError, startSilenceDetection, stopRecording, flushStreamPending]);

    return { startRecording, stopRecording, stopStream, isRecordingRef };
}
