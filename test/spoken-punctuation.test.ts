import { describe, it, expect } from 'vitest';
import { applySpokenPunctuation } from '../src/utils/spokenPunctuation';

const f = applySpokenPunctuation;

describe('applySpokenPunctuation', () => {
    it('sentence enders attach and capitalize the next word', () => {
        expect(f('hello world period this is a test')).toBe('hello world. This is a test');
        expect(f('are you sure question mark yes I am')).toBe('are you sure? Yes I am');
        expect(f('wow exclamation mark that worked')).toBe('wow! That worked');
        expect(f('wow exclamation point that worked')).toBe('wow! That worked');
        expect(f('the end full stop')).toBe('the end.');
    });

    it('replaces ASR-added trailing punctuation instead of doubling', () => {
        expect(f('hello world, comma next')).toBe('hello world, next');
        expect(f('done. period next')).toBe('done. Next');
    });

    it('joiners attach without capitalization', () => {
        expect(f('apples comma oranges comma pears')).toBe('apples, oranges, pears');
        expect(f('note colon this matters')).toBe('note: this matters');
        expect(f('one semicolon two')).toBe('one; two');
        expect(f('cats ampersand dogs')).toBe('cats & dogs');
    });

    it('new line and new paragraph break lines and capitalize', () => {
        expect(f('first item new line second item')).toBe('first item\nSecond item');
        expect(f('intro new paragraph body text')).toBe('intro\n\nBody text');
    });

    it('dot joins only in domain context', () => {
        expect(f('visit google dot com now')).toBe('visit google.com now');
        expect(f('email me at john at sign example dot org')).toBe('email me at john@example.org');
        expect(f('api dot example dot com')).toBe('api.example.com'); // chained labels join
        expect(f('www dot my site dot com')).toBe('www dot my site.com'); // broken chain: only the true TLD pair joins
        expect(f('connect the dot s together')).toBe('connect the dot s together'); // prose untouched
        expect(f('a small dot appeared')).toBe('a small dot appeared');
    });

    it('hyphen joins its neighbors', () => {
        expect(f('twenty hyphen one')).toBe('twenty-one');
        expect(f('a well hyphen known fact')).toBe('a well-known fact');
    });

    it('leading command with nothing before it is dropped', () => {
        expect(f('period hello')).toBe('hello');
    });

    it('plain text passes through unchanged', () => {
        expect(f('nothing special here')).toBe('nothing special here');
        expect(f('')).toBe('');
    });
});
