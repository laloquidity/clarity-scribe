/**
 * AudioWorklet Processor — captures mic audio in a separate thread
 * Copied from Clarity, unchanged.
 */

declare class AudioWorkletProcessor {
    readonly port: MessagePort;
    process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}

declare function registerProcessor(name: string, processorCtor: new () => AudioWorkletProcessor): void;

class AudioRecorderProcessor extends AudioWorkletProcessor {
    private isRecording: boolean = true;

    constructor() {
        super();
        this.port.onmessage = (event: MessageEvent) => {
            if (event.data.command === 'stop') this.isRecording = false;
            else if (event.data.command === 'start') this.isRecording = true;
        };
    }

    process(inputs: Float32Array[][]): boolean {
        if (!this.isRecording) return true;
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
