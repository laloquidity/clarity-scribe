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

    const MAX_RECORDING_DURATION_MS = 30 * 60 * 1000;

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

    const processRecordedAudio = useCallback(
        (chunks: Float32Array[], recordedSampleRate: number) => {
            const totalLength = chunks.reduce((acc, buf) => acc + buf.length, 0);
            if (totalLength === 0) { onStateChange('IDLE'); return; }

            const durationSeconds = totalLength / recordedSampleRate;
            if (durationSeconds < 1.0) {
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
                    if (!success) { onStateChange('IDLE'); return; }

                    const api = window.electronAPI;
                    if (api?.transcribe) {
                        api.transcribe(processedAudio, 16000);
                    } else {
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
        [onStateChange, onError]
    );

    const stopRecording = useCallback(() => {
        if (isToggleBusyRef.current || !isRecordingRef.current) {
            onStateChange('IDLE');
            return;
        }

        isRecordingRef.current = false;
        const bufferChunks = [...audioBuffersRef.current];
        const ctx = audioContextRef.current;

        if (ctx) {
            ctx.suspend().then(() => {
                processRecordedAudio(bufferChunks, ctx.sampleRate);
                stopStream();
            });
        } else {
            stopStream();
            onStateChange('IDLE');
        }

        onStateChange('PROCESSING');
    }, [processRecordedAudio, stopStream, onStateChange]);

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

            processor.port.onmessage = (event) => {
                if (!isRecordingRef.current) return;
                if (event.data.type === 'audio' && event.data.buffer) {
                    audioBuffersRef.current.push(event.data.buffer);
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
    }, [onStateChange, onError, startSilenceDetection, stopRecording]);

    return { startRecording, stopRecording, stopStream, isRecordingRef };
}
