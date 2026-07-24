/**
 * recipes — "learn once, replay fast".
 *
 * The general agent (agentLoop) can drive any app, but pays an LLM decision
 * per step, so a six-step task costs tens of seconds. Most of that work is
 * repeated verbatim every time: the steps to message someone in Telegram are
 * the same today as yesterday; only the contact and the words change.
 *
 * A Recipe captures that STRUCTURE — an ordered list of steps whose variable
 * parts are slots — so the second run replays deterministically in
 * milliseconds. Recipes come from two places: a curated pack that ships with
 * Scribe (recipes/builtin.json), and successful agent runs recorded locally.
 *
 * ── TWO INVARIANTS, both load-bearing ────────────────────────────────────
 *
 * 1. STRUCTURE, NEVER VALUES. A recipe may reference `{{message}}`; it must
 *    never contain the message itself. This is what makes recipes shippable
 *    and shareable: "message Daniel 'are you good for lunch Tuesday?'" is
 *    recorded as `type {{message}} into the composer`, and the words never
 *    reach disk. isShareable() enforces this mechanically — see scrubbing
 *    below — rather than trusting the recorder to behave.
 *
 * 2. SELECTORS RESOLVE LIVE, NEVER POSITIONALLY. Steps address controls by
 *    label/type ("the button named Send"), resolved against the accessibility
 *    tree at replay time. A recipe recorded when Send happened to be the 5th
 *    control must never press "whatever is 5th" later — that is how a replay
 *    system clicks the wrong thing after an app update. If a selector doesn't
 *    resolve unambiguously, replay ABORTS and falls back to the agent.
 */

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** Addresses a control by what it IS, never by where it sat. */
export interface Selector {
    /** Literal label, matched loosely (case/punctuation-insensitive). */
    name?: string;
    /** Label must equal the runtime value of this slot (e.g. a track title). */
    nameFromSlot?: string;
    /** Control type filter, e.g. 'Button', 'Edit', 'ListItem'. */
    type?: string;
    /** Require programmatic activation (InvokePattern & friends). */
    invokable?: boolean;
    /** Require a text-settable control (ValuePattern). */
    editable?: boolean;
}

export type RecipeStep =
    | { action: 'launch'; app: string }
    /** Fire a URI scheme, e.g. spotify:search:{{query}} — no UI needed. */
    | { action: 'deeplink'; uri: string }
    /** Wait for a control to exist (app still loading / navigating). */
    | { action: 'waitFor'; target: Selector; timeoutMs?: number }
    | { action: 'click'; target: Selector }
    /** Set text. `text` may only be a slot reference or a literal we allow. */
    | { action: 'type'; target?: Selector; text: string; submit?: boolean }
    | { action: 'key'; keys: string[] }
    | { action: 'pause'; ms: number };

export interface Recipe {
    id: string;
    /** Spoken forms that select this recipe, e.g. "play {query} on spotify". */
    patterns: string[];
    /** Slot names the patterns capture. */
    slots: string[];
    steps: RecipeStep[];
    /** Where it came from — builtin ships with the app, learned is local. */
    source: 'builtin' | 'learned';
    /** Human-readable summary shown in the capsule and settings. */
    describe: string;
    /**
     * Evidence from an ACTUAL OBSERVED RUN — what was executed, on what, when,
     * and what was seen to happen. Nothing else counts.
     *
     * Specifically it may NOT mean "this looks safe", "it's only a URL", or
     * "the format is well known". Reasoning about why a recipe should work is
     * not evidence that it does; a shipped recipe that was never run is a
     * false promise that wastes the user's time failing until it quarantines
     * itself. If you did not watch it work, it does not ship.
     */
    verified?: string;
    /**
     * Set when the recipe deliberately stops short of an irreversible action
     * (e.g. Telegram: fill the message but never press Send). Surfaced to the
     * user so "it didn't send" reads as intent, not failure.
     */
    stopsBefore?: string;
    /** Populated by the store, not the author. */
    stats?: { successes: number; failures: number; quarantined?: boolean };
}

// ---------------------------------------------------------------------------
// Intent matching
// ---------------------------------------------------------------------------

/** `{name}` → a named capture; everything else is matched literally. */
export function compilePattern(pattern: string): RegExp {
    const escaped = pattern
        .trim()
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')       // escape regex metachars
        .replace(/\s+/g, '\\s+')                       // tolerate spacing
        .replace(/\\\{(\w+)\\\}/g, '(?<$1>.+?)');      // {slot} → capture
    return new RegExp(`^${escaped}$`, 'i');
}

export interface RecipeMatch {
    recipe: Recipe;
    slots: Record<string, string>;
}

function tidy(s: string): string {
    return s.replace(/\s+/g, ' ').replace(/[.!?,]+$/, '').trim();
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Find a recipe whose pattern matches the utterance, returning the captured
 * slot values. Quarantined recipes are skipped. Longest pattern wins so a
 * specific recipe beats a generic one.
 */
export function matchRecipe(utterance: string, recipes: Recipe[]): RecipeMatch | null {
    const text = tidy(utterance);
    let best: RecipeMatch | null = null;
    let bestLen = -1;
    for (const recipe of recipes) {
        if (recipe.stats?.quarantined) continue;
        for (const pattern of recipe.patterns) {
            const m = text.match(compilePattern(pattern));
            if (!m) continue;
            const slots: Record<string, string> = {};
            for (const [k, v] of Object.entries(m.groups ?? {})) slots[k] = tidy(v ?? '');
            if (recipe.slots.some(s => !slots[s])) continue; // a slot came back empty
            const literalLen = pattern.replace(/\{\w+\}/g, '').length;
            if (literalLen > bestLen) { best = { recipe, slots }; bestLen = literalLen; }
        }
    }
    return best;
}

/** Substitute {{slot}} references. Unknown slots resolve to '' deliberately. */
export function interpolate(template: string, slots: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, k) => slots[k] ?? '');
}

// ---------------------------------------------------------------------------
// Privacy — enforced, not trusted
// ---------------------------------------------------------------------------

/**
 * Patterns that must never appear as a literal inside a stored recipe. A
 * recorder that captured real input would trip these, so a leak becomes a
 * refusal to save rather than a file full of someone's messages.
 */
const PERSONAL_PATTERNS: Array<[RegExp, string]> = [
    [/[A-Za-z]:\\Users\\[^\\/*?"<>|]+/i, 'a user profile path'],
    [/\/(?:home|Users)\/[^/\s]+/, 'a user profile path'],
    [/[\w.+-]+@[\w-]+\.[\w.]+/, 'an email address'],
    [/(?:\+?\d[\d\s().-]{7,}\d)/, 'a phone number'],
    [/\b(?:\d[ -]*?){13,16}\b/, 'a card-like number'],
    [/\b(?:password|passcode|api[_\s-]?key|secret|token)\b/i, 'a credential'],
];

/** Free text longer than this is assumed to be user content, not a UI label. */
const MAX_LITERAL_LEN = 60;

export interface PrivacyVerdict {
    ok: boolean;
    reason?: string;
}

/** Is this literal safe to persist inside a recipe? */
export function checkLiteral(value: string): PrivacyVerdict {
    const v = value.trim();
    if (!v) return { ok: true };
    for (const [re, what] of PERSONAL_PATTERNS) {
        if (re.test(v)) return { ok: false, reason: `contains ${what}` };
    }
    if (v.length > MAX_LITERAL_LEN) {
        return { ok: false, reason: 'is long free text (looks like user content, not a UI label)' };
    }
    return { ok: true };
}

/** Every literal a step would persist (slot references are exempt by design). */
function literalsOf(step: RecipeStep): string[] {
    const out: string[] = [];
    const deSlot = (s: string) => s.replace(/\{\{\w+\}\}/g, '').trim();
    switch (step.action) {
        case 'launch': out.push(step.app); break;
        case 'deeplink': out.push(deSlot(step.uri)); break;
        case 'type':
            out.push(deSlot(step.text));
            if (step.target?.name) out.push(step.target.name);
            break;
        case 'click': case 'waitFor':
            if (step.target.name) out.push(step.target.name);
            break;
        case 'key': out.push(...step.keys); break;
        case 'pause': break;
    }
    return out.filter(Boolean);
}

/**
 * Is this recipe safe to persist and ship? Enforces invariant #1: no captured
 * personal values, only structure and UI labels.
 */
export function isShareable(recipe: Recipe): PrivacyVerdict {
    for (const step of recipe.steps) {
        for (const literal of literalsOf(step)) {
            const v = checkLiteral(literal);
            if (!v.ok) return { ok: false, reason: `step "${step.action}" ${v.reason}` };
        }
    }
    for (const p of recipe.patterns) {
        // Patterns are templates; their non-slot text is spoken phrasing.
        const v = checkLiteral(p.replace(/\{\w+\}/g, '').trim());
        if (!v.ok) return { ok: false, reason: `pattern ${v.reason}` };
    }
    return { ok: true };
}

/**
 * A `type` step may only write a slot reference — never a captured literal.
 * This is what stops "are you good for lunch on Tuesday?" from being stored:
 * the recorder must parameterize it or the recipe is rejected.
 */
export function typedTextIsParameterized(step: RecipeStep): boolean {
    if (step.action !== 'type') return true;
    const withoutSlots = step.text.replace(/\{\{\w+\}\}/g, '').trim();
    return withoutSlots.length === 0 || checkLiteral(withoutSlots).ok;
}

// ---------------------------------------------------------------------------
// Recording — turning a successful agent run into a reusable recipe
// ---------------------------------------------------------------------------

export interface RecordedAction {
    kind: 'launch' | 'click' | 'type' | 'key';
    /** App name for launch. */
    app?: string;
    /** Label of the control that was clicked / typed into. */
    label?: string;
    /** Text that was typed. */
    text?: string;
    keys?: string[];
    submit?: boolean;
}

/**
 * Parameterize a recorded run against the utterance that produced it.
 *
 * The key idea, and the reason this is privacy-safe by construction: any value
 * the agent typed that CAME FROM the user's words is replaced by a slot, and
 * anything else must survive checkLiteral() (a short, impersonal UI label) or
 * the whole recipe is rejected. So "message Daniel are you good for lunch on
 * Tuesday?" yields `type {{message}}` — the sentence itself is never stored,
 * because it was recognized as user-supplied and slotted away.
 */
export function recordRecipe(opts: {
    id: string;
    describe: string;
    utterance: string;
    actions: RecordedAction[];
    stopsBefore?: string;
}): { ok: true; recipe: Recipe } | { ok: false; reason: string } {
    const utterance = tidy(opts.utterance);
    const slots: Record<string, string> = {};   // slotName → captured value
    let slotSeq = 0;

    /** Replace a user-derived value with a slot reference. */
    const slotify = (value: string, hint: string): string | null => {
        const v = tidy(value);
        if (!v) return null;
        if (!norm(utterance).includes(norm(v))) return null; // not from the user
        const existing = Object.entries(slots).find(([, val]) => norm(val) === norm(v));
        if (existing) return `{{${existing[0]}}}`;
        const name = /\s/.test(v) && hint === 'text' ? `text${++slotSeq === 1 ? '' : slotSeq}` : `${hint}${slotSeq || ''}`;
        const key = slots[name] === undefined ? name : `${hint}${++slotSeq}`;
        slots[key] = v;
        return `{{${key}}}`;
    };

    const steps: RecipeStep[] = [];
    for (const a of opts.actions) {
        switch (a.kind) {
            case 'launch':
                if (a.app) steps.push({ action: 'launch', app: a.app });
                break;
            case 'key':
                if (a.keys?.length) steps.push({ action: 'key', keys: a.keys });
                break;
            case 'click': {
                if (!a.label) return { ok: false, reason: 'a click had no label to match on later' };
                const asSlot = slotify(a.label, 'target');
                steps.push(asSlot
                    ? { action: 'click', target: { nameFromSlot: asSlot.slice(2, -2) } }
                    : { action: 'click', target: { name: a.label, invokable: true } });
                break;
            }
            case 'type': {
                const templated = a.text ? slotify(a.text, 'text') : null;
                if (a.text && !templated) {
                    // Typed something that did NOT come from the utterance —
                    // we cannot prove it isn't private, so refuse to store it.
                    const v = checkLiteral(a.text);
                    if (!v.ok) return { ok: false, reason: `typed text ${v.reason}` };
                }
                steps.push({
                    action: 'type',
                    target: a.label ? { name: a.label, editable: true } : undefined,
                    text: templated ?? a.text ?? '',
                    submit: a.submit,
                });
                break;
            }
        }
    }

    if (!steps.length) return { ok: false, reason: 'nothing worth recording' };

    // Build the spoken pattern by swapping captured values back out.
    let pattern = utterance;
    for (const [name, value] of Object.entries(slots)) {
        const re = new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        pattern = pattern.replace(re, `{${name}}`);
    }

    const recipe: Recipe = {
        id: opts.id,
        describe: opts.describe,
        patterns: [pattern],
        slots: Object.keys(slots),
        steps,
        source: 'learned',
        stopsBefore: opts.stopsBefore,
    };

    const verdict = isShareable(recipe);
    if (!verdict.ok) return { ok: false, reason: verdict.reason! };
    return { ok: true, recipe };
}

// ---------------------------------------------------------------------------
// Selector resolution (invariant #2)
// ---------------------------------------------------------------------------

export interface ResolvableElement {
    id: number;
    name: string;
    type: string;
    invoke: boolean;
    value: boolean;
}

/**
 * Loose label match — but on WORD boundaries, never raw substring.
 *
 * Substring matching is dangerously wrong here: "Play" is a substring of
 * "Start Playback", so a naive check would let a recipe press a control it
 * was never recorded against. We require the wanted label to appear as a
 * contiguous run of whole words, which still tolerates the decoration apps
 * add ("We Will Rock You - Remastered 2011" matches "we will rock you").
 */
function labelMatches(candidate: string, wanted: string): boolean {
    const c = norm(candidate).split(' ').filter(Boolean);
    const w = norm(wanted).split(' ').filter(Boolean);
    if (!c.length || !w.length || w.length > c.length) return false;
    for (let i = 0; i + w.length <= c.length; i++) {
        if (w.every((word, j) => c[i + j] === word)) return true;
    }
    return false;
}

export type Resolution =
    | { ok: true; id: number }
    | { ok: false; reason: string };

/**
 * Resolve a selector against the live tree.
 *
 * Ambiguity is treated as failure, not a coin flip: if several controls match
 * equally well the recipe is out of date or the screen isn't what we expect,
 * and pressing one of them is exactly the mistake this design exists to
 * prevent. Callers fall back to the agent, which can actually look and think.
 */
export function resolveSelector(
    sel: Selector,
    elements: ResolvableElement[],
    slots: Record<string, string>,
): Resolution {
    const wanted = sel.nameFromSlot ? slots[sel.nameFromSlot] : sel.name;
    if ((sel.nameFromSlot || sel.name) && !wanted) {
        return { ok: false, reason: 'selector needs a label that was not provided' };
    }

    let pool = elements;
    if (sel.type) pool = pool.filter(e => norm(e.type) === norm(sel.type!));
    if (sel.invokable) pool = pool.filter(e => e.invoke);
    if (sel.editable) pool = pool.filter(e => e.value);

    if (!wanted) {
        if (pool.length === 1) return { ok: true, id: pool[0].id };
        return { ok: false, reason: pool.length ? 'selector is ambiguous (no label given)' : 'no matching control' };
    }

    const exact = pool.filter(e => norm(e.name) === norm(wanted));
    if (exact.length === 1) return { ok: true, id: exact[0].id };
    if (exact.length > 1) return { ok: false, reason: `"${wanted}" matches ${exact.length} controls` };

    const loose = pool.filter(e => labelMatches(e.name, wanted));
    if (loose.length === 1) return { ok: true, id: loose[0].id };
    if (loose.length > 1) return { ok: false, reason: `"${wanted}" matches ${loose.length} controls` };

    return { ok: false, reason: `no control matching "${wanted}"` };
}
