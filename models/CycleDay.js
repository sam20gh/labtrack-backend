const mongoose = require('mongoose');

/**
 * One day of somebody's menstrual cycle, as they recorded it.
 *
 * **Days are stored; periods and cycles are derived.** A period is the run of bleeding days
 * `utils/cycleEngine.js` finds in these rows, and a cycle is the span between two period
 * starts. Storing periods as `{ start, end }` would make the calendar's "edit period dates"
 * mode a piece of range surgery — split this one, merge those two — where with day rows it is
 * tapping a day on or off. It also means nothing can drift: there is no period record to
 * disagree with the days it was made from.
 *
 * **Not append-only.** This is a diary, not a finding. Somebody who logged Tuesday by mistake
 * removes Tuesday, and `DELETE` really deletes: a hidden copy of reproductive-health data
 * somebody chose to erase is special-category data with nothing asking for it. The same call
 * `Notification` makes about a swiped-away card.
 *
 * `day` is the person's local `YYYY-MM-DD`, the convention `MealLog.day` follows. A period
 * that starts in the evening in the Americas must not be filed under the following day.
 */

/** How heavy the bleeding was. `unspecified` is "a period day, flow not recorded". */
const FLOWS = ['spotting', 'light', 'medium', 'heavy', 'unspecified'];

/**
 * The symptom chips. Lay words, because the person picks them, and a fixed list, because
 * the insight screen counts them by cycle day — free text cannot be counted.
 */
const SYMPTOMS = [
    'cramps', 'headache', 'bloating', 'breast_tenderness', 'acne', 'fatigue',
    'back_pain', 'nausea', 'cravings', 'mood_swings', 'insomnia', 'diarrhoea',
];

const SOURCES = ['manual', 'health_connect', 'apple_health'];

const CycleDaySchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    day: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },

    /** Null when the day carries symptoms or a note but no bleeding. */
    flow: { type: String, enum: [...FLOWS, null], default: null },

    symptoms: { type: [{ type: String, enum: SYMPTOMS }], default: [] },

    /** 1 (low) to 5 (great), the same five faces the symptom checker draws. Null is "not asked". */
    mood: { type: Number, min: 1, max: 5, default: null },

    note: { type: String, maxlength: 500, default: null },

    /**
     * Where the row came from. Only `manual` is written in phase 1; the health stores join in
     * phase 2 with their own rows, and a manual row for the same day wins on read — the
     * person's own correction beats what an app mirrored.
     */
    source: { type: String, enum: SOURCES, default: 'manual' },
    externalId: { type: String, default: null },
}, { timestamps: true });

// One row per person per day per source. The read path merges sources; see `cycleEngine.mergeDays`.
CycleDaySchema.index({ userId: 1, day: 1, source: 1 }, { unique: true });

module.exports = mongoose.model('CycleDay', CycleDaySchema);
module.exports.FLOWS = FLOWS;
module.exports.SYMPTOMS = SYMPTOMS;
module.exports.SOURCES = SOURCES;
