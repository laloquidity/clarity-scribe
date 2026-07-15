/**
 * History row stat formatters — audio length, transcribe+paste latency, and
 * speed-vs-real-time. Pure functions re-declared here would drift, so these
 * import the real implementations from the component module.
 */
import { describe, it, expect } from 'vitest';
import { formatAudioLength, formatLatency, formatSpeed } from '../src/components/HistoryPanel';

describe('formatAudioLength', () => {
    it('shows one decimal under a minute', () => {
        expect(formatAudioLength(1000)).toBe('1.0s');
        expect(formatAudioLength(12_400)).toBe('12.4s');
        expect(formatAudioLength(59_900)).toBe('59.9s');
    });

    it('switches to m:ss at a minute and pads seconds', () => {
        expect(formatAudioLength(60_000)).toBe('1:00');
        expect(formatAudioLength(65_000)).toBe('1:05');
        expect(formatAudioLength(614_000)).toBe('10:14');
    });
});

describe('formatLatency', () => {
    it('shows whole ms under a second', () => {
        expect(formatLatency(380)).toBe('380ms');
        expect(formatLatency(99.6)).toBe('100ms');
        expect(formatLatency(999)).toBe('999ms');
    });

    it('switches to seconds at 1s', () => {
        expect(formatLatency(1000)).toBe('1.0s');
        expect(formatLatency(1240)).toBe('1.2s');
    });
});

describe('formatSpeed', () => {
    it('rounds to a whole multiplier at 10x and above', () => {
        expect(formatSpeed(12_400, 380)).toBe('33×');
        expect(formatSpeed(60_000, 810)).toBe('74×');
        expect(formatSpeed(10_000, 1000)).toBe('10×');
    });

    it('keeps a decimal below 10x so slow runs stay honest', () => {
        expect(formatSpeed(5_000, 1_000)).toBe('5.0×');
        expect(formatSpeed(1_000, 2_000)).toBe('0.5×');
    });

    it('returns null for unusable inputs rather than Infinity/NaN', () => {
        expect(formatSpeed(12_000, 0)).toBeNull();
        expect(formatSpeed(0, 500)).toBeNull();
    });
});
