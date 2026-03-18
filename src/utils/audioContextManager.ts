/**
 * Shared Audio Context Manager — singleton AudioContext to avoid browser limits
 * Copied from Clarity, unchanged.
 */

let sharedContext: AudioContext | null = null;
let referenceCount = 0;

export const getSharedAudioContext = (): AudioContext => {
    if (!sharedContext || sharedContext.state === 'closed') {
        sharedContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    return sharedContext;
};

export const retainAudioContext = (): AudioContext => {
    const ctx = getSharedAudioContext();
    referenceCount++;
    if (ctx.state === 'suspended') ctx.resume().catch(console.error);
    return ctx;
};

export const releaseAudioContext = () => {
    referenceCount--;
    if (referenceCount <= 0) {
        referenceCount = 0;
        if (sharedContext && sharedContext.state === 'running') {
            sharedContext.suspend().catch(console.error);
        }
    }
};
