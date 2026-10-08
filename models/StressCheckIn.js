/**
 * How somebody said they felt, beside what their bracelet said at the time.
 *
 * Its own collection rather than `healthAssessment.moodHistory`, for two reasons. That array
 * lives inside the user document every authenticated request loads, and a few check-ins a day
 * is the unbounded growth `Plan.plan[]` taught this codebase to avoid. And its entries require
 * a mood, so a stress check-in written there would have to invent one.
 *
 * `deviceScore` is the bracelet's nearest reading **as it stood when the person checked in** —
 * a snapshot, so the pair they were shown cannot change under them. Null when the bracelet had
 * nothing within `NEAREST_MINUTES`.
 *
 * Not read by the score. Not append-only: it is the person's own diary, and a delete deletes.
 */
const mongoose = require('mongoose');

const StressCheckInSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    at: { type: Date, required: true },
    /** Local day, from the client's `tzOffset`, like `MetricLog.day`. */
    day: { type: String, required: true },
    /** 1 calm … 5 overwhelmed — `FEELINGS` in `utils/stressLevel.js`. */
    feeling: { type: Number, required: true, min: 1, max: 5 },
    deviceScore: { type: Number, default: null },
    deviceAt: { type: Date, default: null },
    note: { type: String, default: null, maxlength: 280 },
}, { timestamps: true });

StressCheckInSchema.index({ userId: 1, at: -1 });

module.exports = mongoose.model('StressCheckIn', StressCheckInSchema);
