const mongoose = require('mongoose');

/**
 * One computed LabTrack score, kept.
 *
 * Append-only, like `Interpretation` and `MedicationCheck`, and for the same two reasons.
 *
 * **The design needs a trend.** The Turing Score screen draws a "Health Score Trend" chart
 * and a "88.2pts / +2.5%" delta chip. Neither is derivable from a number computed on demand
 * and thrown away, which is what the old client-side score did — there was no history to
 * chart because nothing was ever written down.
 *
 * **A score that moved needs to be explainable after the fact.** When someone's number drops
 * eleven points the useful question is which pillar moved and when. Storing the pillars
 * alongside the total, rather than only the total, is what makes that answerable — and it
 * means a later change to the weights cannot silently rewrite what a person was shown last
 * month.
 *
 * Snapshots are written at most once per `MIN_SNAPSHOT_GAP_MS` (see `scoreController`), so
 * this grows at roughly one small document per person per day rather than one per app
 * foreground.
 */

/**
 * A pillar as it stood at `computedAt`.
 *
 * `source` is the point of the whole feature: `observed` means the number came from something
 * measured — a synced session, a logged meal, a recorded dose, a lab report — and `reported`
 * means it came from the onboarding questionnaire. Persisted per pillar so the breakdown can
 * show the provenance chip on a historic snapshot too, and so "your score is still mostly
 * based on what you told us" stays a checkable claim rather than a guess.
 */
const PillarSnapshotSchema = new mongoose.Schema({
    key: { type: String, required: true },
    label: { type: String, required: true },
    /** 0-100, or null when the pillar held no data that day. Never coerced to 0. */
    value: { type: Number, default: null },
    band: { type: String, default: null },
    detail: { type: String, default: null },
    source: { type: String, enum: ['observed', 'reported', 'none'], required: true },
    /** The scorer's working — session counts, adherence, BMI. Shape varies per pillar. */
    meta: { type: mongoose.Schema.Types.Mixed, default: undefined },
}, { _id: false });

const HealthScoreSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /** 0-100. Null when fewer than `MIN_PILLARS` pillars held data. */
    value: { type: Number, default: null },
    band: { type: String, enum: ['healthy', 'suboptimal', 'attention', null], default: null },
    headline: { type: String, default: null },

    pillars: { type: [PillarSnapshotSchema], default: [] },

    coverage: {
        scored: { type: Number, default: 0 },
        observed: { type: Number, default: 0 },
        reported: { type: Number, default: 0 },
        total: { type: Number, default: 0 },
        /** Share of the weighted total that came from measurement, 0-100. */
        observedWeight: { type: Number, default: 0 },
    },

    /** The window the observed pillars were measured over. */
    windowDays: { type: Number, default: 30 },

    computedAt: { type: Date, required: true, default: Date.now },

    /**
     * What triggered this one. `sync` and `log` snapshots are the interesting ones on a
     * trend chart — they are the moments the person did something.
     */
    trigger: {
        type: String,
        enum: ['read', 'sync', 'log', 'interpretation', 'manual', 'backfill'],
        default: 'read',
    },
}, { timestamps: true });

// The only access pattern: one person, newest first, optionally over a range.
HealthScoreSchema.index({ userId: 1, computedAt: -1 });

module.exports = mongoose.model('HealthScore', HealthScoreSchema);
