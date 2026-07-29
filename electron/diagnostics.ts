/**
 * diagnostics — counters for the things we kept guessing about.
 *
 * Every number here exists because someone (usually the user) asked a question
 * we could not answer: how often does a pause actually break a sentence? how
 * often does streaming quietly fall back to batch? we quote a median latency,
 * but what does the slow tail look like?
 *
 * PRIVACY: counts and milliseconds only. No transcript text, no audio, no
 * filenames ever enter this module — so a diagnostics dump is safe to read
 * aloud, paste into an issue, or ship in a log.
 *
 * Everything is in-memory and per-run. Nothing is persisted or transmitted.
 */

interface Stat { count: number; ms: number[] }

const MAX_SAMPLES = 500; // bounded — this is a long-lived process

const state = {
    sessions: 0,
    segments: 0,
    /** Seams where segmentJoin repaired a false sentence break. */
    seamRepairs: 0,
    /** Segments closed by a length cap rather than a pause (cut mid-speech). */
    forcedSplits: 0,
    /** Streaming sessions that degraded and required a full batch re-run. */
    streamingFallbacks: 0,
    /** Transcriptions that threw. */
    errors: 0,
    /** Decodes that looked like they dropped speech (see decodeHealth). */
    decodesDegraded: 0,
    /** …of those, how many a session rebuild + retry actually rescued. */
    decodesRecovered: 0,
    /** Preventive rebuilds performed while idle, before anything went wrong. */
    sessionRefreshes: 0,
    stopToText: { count: 0, ms: [] } as Stat,
    segmentDecode: { count: 0, ms: [] } as Stat,
};

function sample(s: Stat, ms: number): void {
    s.count++;
    if (s.ms.length >= MAX_SAMPLES) s.ms.shift();
    s.ms.push(ms);
}

/** Percentile from an unsorted sample set (nearest-rank). */
function pct(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const v = [...values].sort((a, b) => a - b);
    return v[Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1))];
}

export const diag = {
    sessionStarted: () => { state.sessions++; },
    segmentClosed: (forced: boolean) => { state.segments++; if (forced) state.forcedSplits++; },
    seamRepaired: () => { state.seamRepairs++; },
    streamingFellBack: () => { state.streamingFallbacks++; },
    errored: () => { state.errors++; },
    decodeDegraded: () => { state.decodesDegraded++; },
    decodeRecovered: () => { state.decodesRecovered++; },
    sessionRefreshed: () => { state.sessionRefreshes++; },
    stopToText: (ms: number) => sample(state.stopToText, ms),
    segmentDecode: (ms: number) => sample(state.segmentDecode, ms),
};

export interface DiagnosticsSummary {
    sessions: number;
    segments: number;
    segmentsPerSession: number;
    seamRepairs: number;
    /** Share of seams that were false sentence breaks — the punctuation bug's real rate. */
    seamRepairRate: number;
    forcedSplits: number;
    streamingFallbacks: number;
    streamingFallbackRate: number;
    errors: number;
    decodesDegraded: number;
    decodesRecovered: number;
    sessionRefreshes: number;
    stopToTextMs: { p50: number; p90: number; p99: number; n: number };
    segmentDecodeMs: { p50: number; p90: number; p99: number; n: number };
}

export function summary(): DiagnosticsSummary {
    // Seams are the gaps BETWEEN segments, so a session of N segments has N-1.
    const seams = Math.max(0, state.segments - state.sessions);
    const r = (n: number, d: number) => (d > 0 ? Number((n / d).toFixed(3)) : 0);
    const p = (s: Stat) => ({ p50: pct(s.ms, 50), p90: pct(s.ms, 90), p99: pct(s.ms, 99), n: s.count });
    return {
        sessions: state.sessions,
        segments: state.segments,
        segmentsPerSession: r(state.segments, state.sessions),
        seamRepairs: state.seamRepairs,
        seamRepairRate: r(state.seamRepairs, seams),
        forcedSplits: state.forcedSplits,
        streamingFallbacks: state.streamingFallbacks,
        streamingFallbackRate: r(state.streamingFallbacks, state.sessions),
        errors: state.errors,
        decodesDegraded: state.decodesDegraded,
        decodesRecovered: state.decodesRecovered,
        sessionRefreshes: state.sessionRefreshes,
        stopToTextMs: p(state.stopToText),
        segmentDecodeMs: p(state.segmentDecode),
    };
}

/** One-line-per-metric dump — safe to paste anywhere. */
export function logSummary(): void {
    const s = summary();
    if (s.sessions === 0) return;
    console.log(
        `[Diag] ${s.sessions} sessions · ${s.segments} segments (${s.segmentsPerSession}/session)\n` +
        `[Diag] seam repairs: ${s.seamRepairs} (${(s.seamRepairRate * 100).toFixed(1)}% of seams were false sentence breaks)\n` +
        `[Diag] forced splits: ${s.forcedSplits} · streaming fallbacks: ${s.streamingFallbacks} (${(s.streamingFallbackRate * 100).toFixed(1)}%) · errors: ${s.errors}\n` +
        `[Diag] degraded decodes: ${s.decodesDegraded} (rescued by rebuild: ${s.decodesRecovered}) · preventive refreshes: ${s.sessionRefreshes}\n` +
        `[Diag] stop→text ms: p50 ${s.stopToTextMs.p50} / p90 ${s.stopToTextMs.p90} / p99 ${s.stopToTextMs.p99} (n=${s.stopToTextMs.n})\n` +
        `[Diag] segment decode ms: p50 ${s.segmentDecodeMs.p50} / p90 ${s.segmentDecodeMs.p90} / p99 ${s.segmentDecodeMs.p99} (n=${s.segmentDecodeMs.n})`
    );
}

/** Test seam. */
export function __resetForTest(): void {
    state.sessions = 0; state.segments = 0; state.seamRepairs = 0; state.forcedSplits = 0;
    state.streamingFallbacks = 0; state.errors = 0;
    state.stopToText = { count: 0, ms: [] };
    state.segmentDecode = { count: 0, ms: [] };
}
