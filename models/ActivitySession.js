const mongoose = require('mongoose');

/**
 * One workout.
 *
 * Its own collection, not an array on the user document, for the reason `Plan.plan[]` and
 * `MealLog` already settled: sessions are queried by date range, filtered by type, deleted
 * individually, and there can be thousands of them.
 *
 * The important field here is `externalId`. An Apple Watch and the iPhone paired to it both
 * write the same run into HealthKit, and a sync that runs on every app foreground will see
 * it again every time. Without a stable id from the source, every sync double-counts the
 * day — which is the failure a step tracker cannot recover from, because the person
 * remembers what they did.
 */

/**
 * One phase of the workout — the "Activity Breakdown" card (warm up / light jog /
 * intense jog, each with its own pace and heart rate).
 *
 * Derived by the client from the sample stream, or supplied by the source when it segments
 * the workout itself. Stored rather than recomputed because it is what the person was shown.
 */
const SplitSchema = new mongoose.Schema({
    label: { type: String },
    order: { type: Number },
    distanceM: { type: Number },
    durationSec: { type: Number },
    avgBpm: { type: Number },
    /** Seconds per kilometre. The design writes it as "8:00 per km". */
    pacePerKm: { type: Number },
}, { _id: false });

/**
 * How this session sits against the exercise advice on the person's health plan.
 *
 * `unassessed` means their plan says nothing about exercise. That is different from being
 * off plan and must never be rendered as a failure — adherence scores null, not zero, and
 * the section is hidden. Same rule `MealLog.analysis.alignment` holds.
 */
const AnalysisSchema = new mongoose.Schema({
    alignment: {
        type: String,
        enum: ['aligned', 'partial', 'off_plan', 'unassessed'],
        default: 'unassessed',
    },
    rationale: { type: String },
    guidanceKeys: [{ type: String }],
    model: { type: String },
}, { _id: false });

const ActivitySessionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /**
     * Free-form rather than an enum.
     *
     * The design's picker offers ten types, but HealthKit alone defines about eighty
     * workout activity types and Health Connect its own set. An enum here would mean a sync
     * silently dropping someone's kitesurfing session. `utils/healthSync` maps the known
     * ones onto the design's ten for display and passes the rest through as-is.
     */
    type: { type: String, required: true, index: true },

    startedAt: { type: Date, required: true, index: true },
    endedAt: { type: Date },

    /** Local calendar day of `startedAt`, `YYYY-MM-DD`, from the client's tzOffset. */
    day: { type: String, required: true, index: true },

    durationSec: { type: Number, required: true, min: 0 },
    distanceM: { type: Number, min: 0 },
    activeKcal: { type: Number, min: 0 },
    elevationM: { type: Number },
    avgBpm: { type: Number, min: 0 },
    maxBpm: { type: Number, min: 0 },
    /** Steps per minute. */
    cadence: { type: Number, min: 0 },

    /** 1–5, the design's flame scale. Only ever set by the person, never inferred. */
    effort: { type: Number, min: 1, max: 5 },

    splits: [SplitSchema],

    /**
     * GeoJSON LineString, `[[lng, lat], ...]`. Absent for everything that is not a
     * GPS-tracked outdoor session, which is most sessions.
     */
    route: {
        type: { type: String, enum: ['LineString'] },
        coordinates: { type: [[Number]], default: undefined },
    },
    startAddress: { type: String },
    endAddress: { type: String },

    source: {
        type: String,
        enum: ['healthkit', 'health_connect', 'manual', 'live', 'aggregator'],
        required: true,
    },
    /** The health store's stable UUID for this workout. Null for manual entries. */
    externalId: { type: String, default: null },
    sourceDevice: {
        name: { type: String },
        model: { type: String },
        manufacturer: { type: String },
    },

    analysis: { type: AnalysisSchema, default: undefined },

    /**
     * Points this session contributed, computed server-side.
     *
     * The design shows "+3 score" on every history row. Computing it on the client means
     * two phones disagree about a person's own score, and the number is meant to be the
     * same one that feeds the health score's lifestyle pillar.
     */
    scoreDelta: { type: Number, default: 0 },

    notes: { type: String },
}, { timestamps: true });

/**
 * De-duplication.
 *
 * Sparse because manual sessions have no external id and several of them would otherwise
 * collide on `null`. Partial rather than plain-sparse so the uniqueness applies only to the
 * rows that actually carry an id.
 */
ActivitySessionSchema.index(
    { userId: 1, source: 1, externalId: 1 },
    { unique: true, partialFilterExpression: { externalId: { $type: 'string' } } }
);

// The dashboard and the calendar: one person, one day
ActivitySessionSchema.index({ userId: 1, day: 1 });
// History and search: one person, newest first
ActivitySessionSchema.index({ userId: 1, startedAt: -1 });

module.exports = mongoose.model('ActivitySession', ActivitySessionSchema);
