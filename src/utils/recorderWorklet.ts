/**
 * recorderWorklet — the audio capture processor, registered ONCE.
 *
 * WHY THIS EXISTS. Registering an AudioWorklet used to happen on every hotkey
 * press: build the processor source as a string, wrap it in a Blob, create an
 * object URL, and `await audioWorklet.addModule(url)`. That await sat on the
 * critical path between the user pressing the key and audio actually flowing,
 * and it ran again for every single dictation even though the module only ever
 * needs registering once per AudioContext.
 *
 * That latency is not free — it is speech. A dictation app that takes an extra
 * beat to start capturing simply never hears the first word the user says, and
 * the user has no way to tell: the transcript looks confident, it is just
 * missing its opening.
 *
 * So registration is hoisted here, memoised per AudioContext, and can be
 * primed at app start (see `primeRecorderWorklet`) so even the FIRST recording
 * of a session pays nothing.
 */

const PROCESSOR_NAME = 'audio-recorder-processor';

/**
 * Runs on the audio thread. Copies each input block and posts it as a transfer
 * so the buffer moves rather than being cloned.
 */
const PROCESSOR_SOURCE = `
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
registerProcessor('${PROCESSOR_NAME}', AudioRecorderProcessor);
`;

/**
 * One in-flight/settled registration per AudioContext. A WeakMap so a closed
 * context does not keep its entry alive.
 */
const registered = new WeakMap<AudioContext, Promise<void>>();

/**
 * Ensure the processor is registered on this context. Safe to call repeatedly —
 * after the first call it resolves immediately with no work.
 */
export function ensureRecorderWorklet(ctx: AudioContext): Promise<void> {
    const existing = registered.get(ctx);
    if (existing) return existing;

    const pending = (async () => {
        const blob = new Blob([PROCESSOR_SOURCE], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        try {
            await ctx.audioWorklet.addModule(url);
        } finally {
            URL.revokeObjectURL(url);
        }
    })().catch((e) => {
        // Registration failed — drop the memo so the next attempt can retry
        // rather than permanently caching a rejected promise.
        registered.delete(ctx);
        throw e;
    });

    registered.set(ctx, pending);
    return pending;
}

/**
 * Register ahead of time, at app start, so the first dictation of a session is
 * as fast as the rest. Failures are swallowed: this is an optimisation, and
 * `ensureRecorderWorklet` will simply try again when recording actually begins.
 */
export function primeRecorderWorklet(ctx: AudioContext): void {
    ensureRecorderWorklet(ctx).catch(() => { /* retried on first real use */ });
}

export { PROCESSOR_NAME };
