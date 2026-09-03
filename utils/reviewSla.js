/**
 * How long a case may wait, and whether it has waited too long.
 *
 * **A deterministic table, not a judgement** — the same argument `medicationCatalogue.js`
 * and `bloodPressure.js` make. A target that a screen computes for itself is a target that
 * differs between the queue, the dashboard and the export, and the first time those three
 * disagree nobody knows which one the team is actually working to.
 *
 * Five rules, each of which is a way the naive version is wrong:
 *
 * 1. **The clock starts when the interpretation was generated**, not when it was claimed or
 *    first opened. That is when the patient started waiting. Restarting it on claim would
 *    turn a measure of how long someone waits for their results into a measure of how
 *    briskly staff work once they get round to it — and would let a breach be cleared by
 *    opening the case and closing it again.
 * 2. **A finding shortens the target; nothing lengthens it.** `PRIORITIES` is ordered, and
 *    `slaFor` takes the shortest target any matching rule asks for, so adding a rule can
 *    only ever make a case more urgent. A rule that could relax a target is one bad edit
 *    away from filing a pathogenic result behind a routine one.
 * 3. **A breach is a state, not a colour.** It is carried as `state: 'breached'` with the
 *    hours it is over by, so a screen cannot render it as one more warm shade in a
 *    gradient — the same call `bloodPressure.isCrisis` makes for the same reason.
 * 4. **`on_track` is a claim about the clock, never about the patient.** It says the case
 *    has not waited too long. It says nothing about what is in it, which is precisely what
 *    nobody has looked at yet.
 * 5. **An unusable date is `unknown`, not zero hours.** Treating a missing `generatedAt` as
 *    "just arrived" is exactly backwards: an undated row is the one most likely to be old,
 *    and it would sort to the safe end of every queue.
 */

/** Hours a case may wait before it is late, by priority. Shortest wins. */
const PRIORITIES = [
    {
        key: 'urgent',
        label: 'Urgent',
        targetHours: 24,
        /** The model flagged something a clinician should see today. */
        matches: ({ highRiskCount, pathogenicCount }) => highRiskCount > 0 || pathogenicCount > 0,
        reason: 'The model reported a high-risk finding or a pathogenic variant.',
    },
    {
        key: 'routine',
        label: 'Routine',
        targetHours: 120,
        matches: () => true,
        reason: 'No high-risk finding was reported. Reviewed in turn.',
    },
];

/** Fraction of the target at which a case starts being called out as nearly late. */
const DUE_SOON_AT = 0.75;

const HOUR_MS = 3_600_000;

/**
 * Where a case stands against its target.
 *
 * @param {object} row
 * @param {Date|string} row.generatedAt when the patient started waiting
 * @param {number} [row.highRiskCount]
 * @param {number} [row.pathogenicCount]
 * @param {Date} [now]
 * @returns {{priority: string, priorityLabel: string, priorityReason: string,
 *            targetHours: number, dueAt: string|null, hoursWaiting: number|null,
 *            hoursRemaining: number|null, hoursOverdue: number|null,
 *            state: 'on_track'|'due_soon'|'breached'|'unknown'}}
 */
const slaFor = ({ generatedAt, highRiskCount = 0, pathogenicCount = 0 }, now = new Date()) => {
    const counts = {
        highRiskCount: Number(highRiskCount) || 0,
        pathogenicCount: Number(pathogenicCount) || 0,
    };

    // Shortest matching target, so a rule can only ever raise urgency (rule 2).
    const matched = PRIORITIES.filter((p) => p.matches(counts));
    const priority = matched.reduce((a, b) => (b.targetHours < a.targetHours ? b : a));

    const started = generatedAt ? new Date(generatedAt) : null;
    const usable = started && !Number.isNaN(started.getTime());

    if (!usable) {
        // Rule 5: unknown, never zero.
        return {
            priority: priority.key,
            priorityLabel: priority.label,
            priorityReason: priority.reason,
            targetHours: priority.targetHours,
            dueAt: null,
            hoursWaiting: null,
            hoursRemaining: null,
            hoursOverdue: null,
            state: 'unknown',
        };
    }

    const dueAt = new Date(started.getTime() + priority.targetHours * HOUR_MS);
    const hoursWaiting = Math.max(0, (now.getTime() - started.getTime()) / HOUR_MS);
    const remaining = (dueAt.getTime() - now.getTime()) / HOUR_MS;

    let state = 'on_track';
    if (remaining <= 0) state = 'breached';
    else if (hoursWaiting >= priority.targetHours * DUE_SOON_AT) state = 'due_soon';

    return {
        priority: priority.key,
        priorityLabel: priority.label,
        priorityReason: priority.reason,
        targetHours: priority.targetHours,
        dueAt: dueAt.toISOString(),
        hoursWaiting: round1(hoursWaiting),
        hoursRemaining: remaining > 0 ? round1(remaining) : 0,
        hoursOverdue: remaining < 0 ? round1(-remaining) : 0,
        state,
    };
};

const round1 = (n) => Math.round(n * 10) / 10;

/** Sort key that puts the most overdue first, then the nearest due. Unknown dates sort first. */
const slaOrder = (sla) => {
    if (!sla || sla.state === 'unknown') return -Infinity;
    return -(sla.hoursOverdue || 0) + (sla.hoursRemaining || 0);
};

const SLA_STATES = ['breached', 'due_soon', 'on_track', 'unknown'];

module.exports = { slaFor, slaOrder, PRIORITIES, SLA_STATES, DUE_SOON_AT };
