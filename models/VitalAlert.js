const mongoose = require('mongoose');
const { METRICS, LEVELS } = require('../utils/vitalAlerts');

/**
 * An out-of-range vital sign, on the patient's record, waiting for a clinician.
 *
 * The patient's side of this is a `Notification`, and it is a message: it can be swiped
 * away and it expires after 90 days. This is the other side, a clinical record that says
 * "these readings were outside range, the patient was told at this time, and this
 * clinician looked at it and did this." A notification cannot carry that, because deleting
 * one must not delete the fact that a clinician needs to see.
 *
 * **One row is an episode, not a reading.** A bracelet takes SpO2 every hour. If each low
 * reading were its own row, one bad night would put eight rows in the worklist, a
 * clinician would acknowledge them one at a time, and the eighth would look exactly like
 * the first. So while an alert for a metric is open, new breaching readings for that metric
 * join it: the count goes up, `lastAt` moves, and `level` can only rise. Once a clinician
 * has reviewed it the episode is closed, and the next breach opens a fresh one. "Reviewed
 * on Tuesday, high again on Thursday" is a new fact, and it needs a new review.
 *
 * Not append-only in the way `Interpretation` is: an open episode is updated in place. But
 * **nothing is ever deleted**, and a reviewed episode is never reopened or edited. The
 * review is the record of what was done, and it has to keep saying what it said.
 */

/** Cap on stored readings per episode. See `vitalAlertCentre.mergeReadings`. */
const MAX_READINGS = 200;

const ReadingSchema = new mongoose.Schema({
    measuredAt: { type: Date, required: true },
    /** Local day, `YYYY-MM-DD`, so the worklist can say "3 days" without a timezone. */
    day: { type: String, default: null },
    level: { type: String, enum: LEVELS, required: true },
    /** Which row of `utils/vitalAlerts.js` fired, e.g. `spo2.at_most_91`. */
    rule: { type: String, required: true },

    systolic: { type: Number, default: null },
    diastolic: { type: Number, default: null },
    /** The `bloodPressure.classify` key at the time. Never recomputed; see `MetricLog.category`. */
    category: { type: String, default: null },
    spo2: { type: Number, default: null },
    bpm: { type: Number, default: null },
    /** Heart rate only: `resting`, `sleeping` or `manual`. */
    context: { type: String, default: null },

    /** `manual`, `bracelet`, `device`, `healthkit`, `health_connect`. */
    source: { type: String, default: null },
    /**
     * `optical_estimate` for the bracelet's cuffless blood pressure. The clinician has to
     * be able to tell that from a cuff reading, and this is the only place they can.
     */
    method: { type: String, default: null },

    /**
     * Identity of the underlying row. A re-sync sends the same readings again, and this is
     * what stops them being counted twice. It is also how a reading the patient deleted
     * as a typo is found and withdrawn.
     */
    key: { type: String, required: true },
    logId: { type: mongoose.Schema.Types.ObjectId, default: null },
    externalId: { type: String, default: null },

    /**
     * Set when the patient deleted the underlying entry. The reading stays visible to the
     * clinician, marked, rather than vanishing. A crisis reading that disappears from the
     * record because somebody swiped it is not a thing a clinical record should allow.
     */
    withdrawnAt: { type: Date, default: null },
}, { _id: false });

const NotifiedSchema = new mongoose.Schema({
    notificationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Notification' },
    level: { type: String, enum: LEVELS },
    at: { type: Date, default: Date.now },
    /** Whether a push actually left, as opposed to the card only being written. */
    pushed: { type: Boolean, default: false },
}, { _id: false });

/**
 * What the clinician concluded. `outcome` is a closed list so the worklist can be counted
 * and filtered; `note` is where the clinical reasoning goes.
 */
const OUTCOMES = [
    'no_action',          // reviewed; within what is expected for this patient
    'advised_patient',    // contacted the patient with advice
    'appointment',        // booked or asked the patient to book a consultation
    'plan_item',          // added a follow-up to the patient's plan
    'escalated',          // referred on, or advised emergency care
    'measurement_error',  // the reading is not believed: artefact, wrong technique
];

const VitalAlertSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    metric: { type: String, enum: METRICS, required: true },

    /** The highest level any reading in the episode reached. Only ever rises. */
    level: { type: String, enum: LEVELS, required: true },

    /**
     * `open` means waiting for a clinician. `reviewed` means one has looked and recorded an
     * outcome. `withdrawn` means every reading in it was deleted by the patient before
     * anybody reviewed it.
     */
    status: { type: String, enum: ['open', 'reviewed', 'withdrawn'], default: 'open', index: true },

    /**
     * True while `status` is `open`. It exists only for the partial unique index below:
     * at most one open episode per person per metric, even when two syncs race.
     */
    isOpen: { type: Boolean, default: true },

    firstAt: { type: Date, required: true },
    lastAt: { type: Date, required: true },
    /** Distinct breaching readings seen, including any beyond `MAX_READINGS`. */
    readingCount: { type: Number, default: 0 },

    readings: { type: [ReadingSchema], default: [] },
    /** Copies of the entry in `readings`, kept so a list can sort and render without it. */
    worst: { type: ReadingSchema, default: null },
    latest: { type: ReadingSchema, default: null },

    /**
     * Whether any reading in the episode is the bracelet's cuffless blood-pressure
     * estimate. Stored rather than derived because the worklist does not load `readings`.
     */
    hasEstimate: { type: Boolean, default: false },

    /** Every time the patient was told. Empty means they were not, e.g. a stale backfill. */
    notified: { type: [NotifiedSchema], default: [] },

    review: {
        by: { type: mongoose.Schema.Types.ObjectId, default: null },
        /** The linked directory `Professional`, when there is one. See `resolveProfessional`. */
        professionalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Professional', default: null },
        name: { type: String, default: null },
        at: { type: Date, default: null },
        outcome: { type: String, enum: [...OUTCOMES, null], default: null },
        note: { type: String, default: null, maxlength: 2000 },
    },
}, { timestamps: true });

VitalAlertSchema.index(
    { userId: 1, metric: 1 },
    { unique: true, partialFilterExpression: { isOpen: true } },
);

/** The worklist: open first, urgent first, most recent reading first. */
VitalAlertSchema.index({ status: 1, level: 1, lastAt: -1 });
VitalAlertSchema.index({ userId: 1, lastAt: -1 });

module.exports = mongoose.model('VitalAlert', VitalAlertSchema);
module.exports.OUTCOMES = OUTCOMES;
module.exports.MAX_READINGS = MAX_READINGS;
