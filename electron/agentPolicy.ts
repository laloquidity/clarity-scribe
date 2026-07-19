/**
 * Agent policy — the risk rulebook (commandTools.ts header) extended to
 * multi-step screen agents, where risk lives at TWO levels:
 *
 *   GOAL level (before the first action): what did the user ask for?
 *     · AUTO     — in-app benign tasks ("open spotify and play X", "search
 *                  youtube for Y"). Guarded by the live step feed + instant
 *                  stop (Esc), step cap, and per-step gates below.
 *     · CONFIRM  — anything with an external human recipient (message/email/
 *                  DM/post): one proposal card up front, exactly like the
 *                  single-tool rulebook's "sending messages" tier.
 *     · REFUSE   — money movement, credentials, and bulk destruction. The
 *                  refuse tier goes live here: an autonomous clicker must
 *                  never be steerable into payments or password entry.
 *
 *   STEP level (before every click): what is the agent about to press?
 *     Screens change under the agent, so the goal gate alone is not enough —
 *     a benign goal can surface a "Place order" button. Click targets whose
 *     labels commit money, send content to people, or destroy data pause for
 *     confirmation; credential fields refuse outright.
 *
 * Mechanical guardrails (caps, loop detection) live in agentLoop.ts.
 */

import type { RiskDecision } from './commandTools';
import type { ScreenElement } from './visionSidecar';

// --- goal-level patterns ---

const GOAL_REFUSE: Array<[RegExp, string]> = [
    [/\b(buy|purchase|order|check\s?out|pay(?:\s+for)?|payment|subscribe)\b/i,
        'Agent mode never spends money'],
    [/\b(send|transfer|wire|venmo|zelle|cash\s?app)\b.{0,24}(money|\$|dollars|crypto|bitcoin|\beth\b)/i,
        'Agent mode never moves money'],
    [/\b(password|passcode|credentials?|2fa|verification code|credit card|cvv|ssn|social security)\b/i,
        'Agent mode never handles passwords or sensitive credentials'],
    [/\b(log\s?in|sign\s?in|log\s?into|sign\s?into)\b/i,
        'Agent mode never signs into accounts — do that yourself once, then ask again'],
    [/\b(delete|erase|wipe|format)\b.{0,24}\b(all|every|everything|folder|drive|disk)\b/i,
        'Bulk deletion is irreversible'],
];

const GOAL_CONFIRM: Array<[RegExp, string]> = [
    [/\b(message|text|dm|email|e-mail|reply|respond)\b/i,
        'This will contact someone as you'],
    [/\b(post|publish|tweet|share)\b/i,
        'This will publish content as you'],
    [/\bsend\b/i,
        'This may send something to someone as you'],
];

/** Rulebook, goal tier: applied to the spoken task before anything runs. */
export function assessGoal(goal: string): RiskDecision {
    for (const [re, reason] of GOAL_REFUSE) {
        if (re.test(goal)) return { level: 'refuse', reason };
    }
    for (const [re, reason] of GOAL_CONFIRM) {
        if (re.test(goal)) return { level: 'confirm', reason };
    }
    return { level: 'auto' };
}

// --- step-level patterns (click-target labels) ---

const CLICK_REFUSE = /\b(password|passcode|cvv|card number)\b/i;

const CLICK_CONFIRM: Array<[RegExp, string]> = [
    [/\b(buy|purchase|place order|pay|check\s?out|confirm (order|purchase|payment)|subscribe|add to cart)\b/i,
        'This button commits a purchase'],
    [/\b(send|post|publish|tweet|reply)\b/i,
        'This button sends content to someone'],
    [/\b(delete|remove|uninstall|erase|discard|empty (trash|recycle))\b/i,
        'This button deletes something'],
];

/**
 * Rulebook, step tier: gate a single click by the label of what is being
 * clicked. Non-click actions pass — typing/keys act on whatever the LAST
 * approved click focused, and the goal gate already screened the content.
 */
export function assessClick(element: Pick<ScreenElement, 'content'>): RiskDecision {
    const label = (element.content || '').trim();
    if (CLICK_REFUSE.test(label)) {
        return { level: 'refuse', reason: 'Credential field — agent mode never touches these' };
    }
    for (const [re, reason] of CLICK_CONFIRM) {
        if (re.test(label)) return { level: 'confirm', reason };
    }
    return { level: 'auto' };
}
