const mongoose = require('mongoose');

/**
 * Where a clinician has said this person's normal is not the default one.
 *
 * `utils/vitalAlerts.js` judges every reading against NEWS2-shaped thresholds, and for most
 * people that is right. For some it produces an alert every hour: somebody with COPD whose
 * target saturation is 88–92% is "low" all day on scale 1, and a marathon runner asleep at
 * 38 bpm is "low" all night. An alert that fires constantly for one patient teaches the
 * clinician looking after them to stop reading that patient's alerts, including the one that
 * matters.
 *
 * **Only a clinician can write this**, through `PUT /reviews/patient/:userId/vital-targets`.
 * It is a separate collection rather than a field on `User` so that no patient-facing
 * update path, now or later, can reach it by spreading a request body. Moving your own alarm
 * threshold is a clinical decision, and NEWS2 itself requires scale 2 to be prescribed.
 *
 * Every change is kept in `history`. "Who lowered this patient's oxygen threshold, when, and
 * why" is a question somebody will ask after an incident, and the answer must not depend on
 * the current row.
 */
const ChangeSchema = new mongoose.Schema({
    spo2Scale: { type: String, enum: ['standard', 'hypercapnic'] },
    lowHeartRateExpected: { type: Boolean },
    reason: { type: String, default: null },
    by: { type: mongoose.Schema.Types.ObjectId },
    name: { type: String, default: null },
    at: { type: Date, default: Date.now },
}, { _id: false });

const VitalTargetSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },

    /** NEWS2 SpO2 scale. `hypercapnic` is scale 2: the 88–92% target. */
    spo2Scale: { type: String, enum: ['standard', 'hypercapnic'], default: 'standard' },

    /** An athlete or a rate-limiting medicine. Drops the ≤40 bpm band; ≤30 still alerts. */
    lowHeartRateExpected: { type: Boolean, default: false },

    /** Required for anything but the defaults. The next clinician needs to know why. */
    reason: { type: String, default: null, maxlength: 1000 },

    setBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    setByName: { type: String, default: null },
    setAt: { type: Date, default: null },

    history: { type: [ChangeSchema], default: [] },
}, { timestamps: true });

module.exports = mongoose.model('VitalTarget', VitalTargetSchema);
