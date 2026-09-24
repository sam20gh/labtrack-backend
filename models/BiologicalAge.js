const mongoose = require('mongoose');

/**
 * One computed Predyqt Age, kept.
 *
 * Append-only, like `HealthScore`, `Interpretation` and `AchievementUnlock`, and for the two
 * reasons `HealthScore` gives plus one of its own.
 *
 * **The pace of aging is the slope of this collection.** It is not a second model and there
 * is nothing else to compute it from: `predictionForecast.project()` fits a weighted
 * regression over these rows against calendar time, and "your biological age is moving at
 * 0.4 years per year" is that slope. A number recomputed on demand and thrown away has no
 * slope, so this collection *is* the pace feature rather than a cache for it.
 *
 * **A number that moved needs to be explainable afterwards.** Both halves are stored whole,
 * not just the blended total, so "why did I age two years in March" is answerable — and so a
 * later change to a hazard coefficient cannot silently rewrite what somebody was shown last
 * year.
 *
 * Snapshots are written at most once per `MIN_SNAPSHOT_GAP_MS` (see `ageController`), which
 * is a day rather than the score's six hours: this is a figure over a six-month window and it
 * cannot meaningfully move between two app opens.
 */

/**
 * One half as it stood at `computedAt`.
 *
 * Kept even when it refused. "Your bloods are eighteen months old" and "connect a watch" are
 * both things a screen has to be able to say about a historic snapshot, and neither is
 * derivable from a blended number.
 */
const HalfSchema = new mongoose.Schema({
    /** `lab` | `lifestyle`. */
    source: { type: String, required: true },
    ok: { type: Boolean, required: true },
    /** Years. Null when this half refused. Never 0 as a stand-in. */
    value: { type: Number, default: null },
    delta: { type: Number, default: null },
    /** Why it refused, when it did — `incomplete_panel`, `acute_phase`, `insufficient_coverage`. */
    reason: { type: String, default: null },
    /** The equation or table that produced it, so a method change is visible in the history. */
    method: { type: String, default: null },
    clamped: { type: Boolean, default: false },
    /** When the underlying evidence was measured. For labs, the panel's own date. */
    measuredAt: { type: Date, default: null },
    /** Per-marker or per-contributor working. Shape differs by half. */
    contributions: { type: mongoose.Schema.Types.Mixed, default: undefined },
    meta: { type: mongoose.Schema.Types.Mixed, default: undefined },
}, { _id: false });

const BiologicalAgeSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /** Years. Null is never persisted — see `ageController.persist`. */
    value: { type: Number, required: true },
    /** Chronological age at `computedAt`, stored because it is what `delta` was measured against. */
    chronologicalAge: { type: Number, required: true },
    /** Biological minus chronological. The number the screens actually lead with. */
    delta: { type: Number, required: true },

    band: { type: String, enum: ['younger', 'on_track', 'older', null], default: null },

    /**
     * `lab` | `lifestyle` | `blended`.
     *
     * The whole feature's honesty rests on this being stored and rendered. A number from a
     * validated equation on fresh bloods and a number from an unvalidated aggregation of
     * hazard ratios must not look identical on a trend chart.
     */
    source: { type: String, enum: ['lab', 'lifestyle', 'blended'], required: true },

    halves: { type: [HalfSchema], default: [] },
    /** Each half's share of the blend, 0–1. */
    weights: { type: mongoose.Schema.Types.Mixed, default: undefined },

    windowDays: { type: Number, default: 180 },
    computedAt: { type: Date, required: true, default: Date.now },

    trigger: {
        type: String,
        enum: ['read', 'report', 'daily', 'manual', 'backfill'],
        default: 'read',
    },
}, { timestamps: true });

// The only access pattern, and the one the pace regression reads: one person, over a range.
BiologicalAgeSchema.index({ userId: 1, computedAt: -1 });

module.exports = mongoose.model('BiologicalAge', BiologicalAgeSchema);
