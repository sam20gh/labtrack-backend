/**
 * How the review loop is actually performing.
 *
 * Two numbers matter and they point in different directions. **Turnaround** says whether
 * patients are being kept waiting. **Amendment frequency** says whether the model is being
 * corrected — and *which fields* it is corrected in, which is the one signal in the product
 * that can be fed back into `utils/interpretationSchema.js` and the interpretation prompt.
 * A field clinicians rewrite nine times out of ten is a prompt defect, not a clinician
 * habit.
 *
 * Held here rather than in the controller so it is testable without a database, the same
 * reason `utils/nutritionInsight.js` exists.
 *
 * Four rules:
 *
 * 1. **Null, never zero.** No signed reviews in the window means the amendment rate is
 *    `null` — "nothing to measure" — not `0%`, which reads as "the model is never wrong".
 *    The same distinction `alignment: 'unassessed'` and `medicationSchedule.adherence` make.
 * 2. **Median and p90, never a mean.** One case reviewed after a fortnight's leave drags a
 *    mean into meaninglessness. The median says what a typical patient waits; p90 says what
 *    the unlucky one waits, and improving the second is the actual work.
 * 3. **An impossible turnaround is excluded, not clamped to zero.** A `reviewedAt` before
 *    `generatedAt` is a data fault (a backfilled row, a clock skew); counting it as an
 *    instant review would silently flatter every figure it touches.
 * 4. **Per-clinician figures are counts of work, not a ranking.** They exist because
 *    "who is carrying the queue" and "is one reviewer amending far more than the rest"
 *    are operational questions with operational answers — a clinician amending twice the
 *    average is as likely to have the hard cases as a different threshold.
 */

const HOUR_MS = 3_600_000;

/** Percentile of a sorted numeric array, linear interpolation. Null when empty. */
const percentile = (sorted, p) => {
    if (!sorted.length) return null;
    if (sorted.length === 1) return sorted[0];
    const rank = (sorted.length - 1) * p;
    const low = Math.floor(rank);
    const high = Math.ceil(rank);
    if (low === high) return sorted[low];
    return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
};

const round1 = (n) => (n === null || n === undefined ? null : Math.round(n * 10) / 10);

/** Hours between generation and sign-off, or null when the pair is unusable (rule 3). */
const turnaroundHours = (row) => {
    const from = row.generatedAt ? new Date(row.generatedAt) : null;
    const to = row.review?.reviewedAt ? new Date(row.review.reviewedAt) : null;
    if (!from || !to || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
    const hours = (to.getTime() - from.getTime()) / HOUR_MS;
    return hours >= 0 ? hours : null;
};

const SIGNED = ['approved', 'amended'];

/**
 * @param {object[]} signedRows interpretations whose review is approved or amended
 * @param {object[]} pendingRows interpretations still awaiting review
 * @param {object} [options]
 * @param {Date} [options.now]
 */
const computeReviewMetrics = (signedRows = [], pendingRows = [], { now = new Date() } = {}) => {
    const signed = signedRows.filter((r) => SIGNED.includes(r.review?.status));

    const turnarounds = signed.map(turnaroundHours).filter((h) => h !== null).sort((a, b) => a - b);

    const amended = signed.filter((r) => r.review?.status === 'amended');

    // Which fields clinicians actually change. This is the feedback loop into the prompt.
    const byField = {};
    for (const row of signed) {
        for (const edit of row.review?.edits || []) {
            if (!edit?.field) continue;
            byField[edit.field] = (byField[edit.field] || 0) + 1;
        }
    }

    const clinicians = new Map();
    for (const row of signed) {
        const id = row.review?.professionalId ? String(row.review.professionalId) : 'unattributed';
        if (!clinicians.has(id)) clinicians.set(id, { professionalId: id, signed: 0, amended: 0, hours: [] });
        const entry = clinicians.get(id);
        entry.signed += 1;
        if (row.review?.status === 'amended') entry.amended += 1;
        const h = turnaroundHours(row);
        if (h !== null) entry.hours.push(h);
    }

    const pendingWaits = pendingRows
        .map((r) => {
            const from = r.generatedAt ? new Date(r.generatedAt) : null;
            if (!from || Number.isNaN(from.getTime())) return null;
            return Math.max(0, (now.getTime() - from.getTime()) / HOUR_MS);
        })
        .filter((h) => h !== null)
        .sort((a, b) => b - a);

    return {
        signedCount: signed.length,
        // Rule 1: nothing measured is null, not zero.
        turnaround: {
            medianHours: round1(percentile(turnarounds, 0.5)),
            p90Hours: round1(percentile(turnarounds, 0.9)),
            measured: turnarounds.length,
            /** Signed rows whose dates could not be used — a data-quality figure, shown not hidden. */
            unusable: signed.length - turnarounds.length,
        },
        amendments: {
            amendedCount: amended.length,
            rate: signed.length ? round1((amended.length / signed.length) * 100) : null,
            editCount: Object.values(byField).reduce((a, b) => a + b, 0),
            byField: Object.entries(byField)
                .map(([field, count]) => ({ field, count }))
                .sort((a, b) => b.count - a.count),
        },
        backlog: {
            pendingCount: pendingRows.length,
            oldestWaitingHours: pendingWaits.length ? round1(pendingWaits[0]) : null,
            medianWaitingHours: round1(percentile([...pendingWaits].sort((a, b) => a - b), 0.5)),
        },
        byClinician: [...clinicians.values()]
            .map((c) => ({
                professionalId: c.professionalId,
                signed: c.signed,
                amended: c.amended,
                amendmentRate: c.signed ? round1((c.amended / c.signed) * 100) : null,
                medianTurnaroundHours: round1(percentile(c.hours.sort((a, b) => a - b), 0.5)),
            }))
            .sort((a, b) => b.signed - a.signed),
    };
};

module.exports = { computeReviewMetrics, turnaroundHours, percentile, SIGNED };
