/**
 * Does a piece of plan advice actually recommend what a rule's keyword names?
 *
 * The tracker tables (`nutritionTargets.GUIDANCE_SHIFTS`, `sleepTargets.SLEEP_SHIFTS`) match
 * advice by keyword, and a keyword is not a recommendation. The interpretation wrote "Drop
 * the broad Mediterranean target for now", and matching the word alone applied the very
 * pattern the plan had put on hold. On the sleep side the same mistake is worse: "rather than
 * trying to sleep more, keep a fixed wake time" is standard insomnia advice, and reading it
 * as "sleep more" lengthens the goal — the one thing that advice exists to prevent.
 *
 * So a mention is skipped when its own clause sets it aside. Whether a rule *can* be set
 * aside is the caller's decision, per rule kind: for a rule that reduces something ("avoid
 * white bread", "no caffeine after 2pm") the same words are the advice, and reading them as
 * negation would cancel the directives that matter most.
 *
 * Pure and deterministic, like the tables that use it. Set-aside advice is never dropped —
 * the caller still shows it verbatim, as `key: 'other'` when nothing else matched.
 */

const SET_ASIDE_BEFORE = /\b(drop|dropp(?:ed|ing)|stop|abandon|pause|skip|park|set aside|put aside|hold off(?: on)?|move away from|step back from|no longer|not|don'?t|do not|no need (?:to|for)|instead of|rather than|without)\b/i;
const SET_ASIDE_AFTER = /^[^.;:!?]{0,40}\b(on hold|can wait|not yet|not now|is not needed|isn'?t needed)\b/i;
const CLAUSE_BREAK = /[.;:!?]|\bbut\b|\bthen\b/gi;

/** How many words before a mention a set-aside word may sit and still govern it. */
const LEAD_WORDS = 8;

/**
 * True when at least one mention of `pattern` in `text` is not set aside.
 *
 * @param {RegExp} pattern     the rule's `match`
 * @param {string} text
 * @param {boolean} negatable  false for rules where negating words are the advice itself
 */
const recommends = (pattern, text, negatable) => {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    for (const m of text.matchAll(new RegExp(pattern.source, flags))) {
        if (!negatable) return true;
        const before = text.slice(0, m.index);
        const clauseStart = Math.max(0, ...[...before.matchAll(CLAUSE_BREAK)].map((b) => b.index + b[0].length));
        // The last few words of this clause, so a "not" three sentences back cannot reach it.
        const lead = before.slice(clauseStart).split(/\s+/).slice(-LEAD_WORDS).join(' ');
        const after = text.slice(m.index + m[0].length);
        if (!SET_ASIDE_BEFORE.test(lead) && !SET_ASIDE_AFTER.test(after)) return true;
    }
    return false;
};

/**
 * The rules from `table` that `text` recommends.
 *
 * @param {{match: RegExp, kind: string}[]} table
 * @param {string} text
 * @param {Set<string>} negatableKinds  rule kinds whose mention can be set aside
 */
const rulesRecommended = (table, text, negatableKinds) =>
    table.filter((rule) => recommends(rule.match, text, negatableKinds.has(rule.kind)));

module.exports = { recommends, rulesRecommended };
