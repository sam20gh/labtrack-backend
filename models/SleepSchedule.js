const mongoose = require('mongoose');

/**
 * One named bedtime/wake routine — `Design/sleep.svg` frames 14 to 18.
 *
 * Separate from `SleepPlan` because the two answer different questions and change at
 * different rates. `SleepPlan.goalMinutes` is *how much* somebody should sleep and is
 * derived from their health plan; a schedule is *when*, it is theirs, and there can be
 * several — the design lists "Quick Sleep" at 08:25 PM beside one at 10:05 PM, because
 * weeknights and weekends are not the same routine.
 *
 * **What this is not.** The kit draws an alarm clock: a sound picker, a volume slider, a
 * vibration toggle and a full-screen "swipe to wake up". None of that ships, and the model
 * carries no field for it. A ringing alarm has to fire with the app closed and the phone
 * locked, which needs a foreground service on Android and a critical-alert entitlement on
 * iOS — neither of which this build has, and both of which would produce an alarm that
 * silently does not go off on the one morning somebody depended on it. What a schedule does
 * here is send a **bedtime reminder** through the same push path medication doses use, and
 * `remindMinutesBefore` is the whole of that. The screens say so rather than drawing a
 * volume slider that changes nothing.
 *
 * Times are minutes from local midnight, never `Date`s. A bedtime is a wall-clock fact — it
 * stays 22:30 when somebody flies to Tokyo — and storing an instant would move it.
 */

const SleepScheduleSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /** The design's editable "Schedule Name". Defaulted rather than required — a schedule
     *  with no name is still a schedule, and an empty field should not block saving one. */
    name: { type: String, default: 'Sleep schedule', maxlength: 60, trim: true },

    /** Minutes from local midnight. 22:30 is 1350; 00:25 is 25. */
    bedtimeMin: { type: Number, required: true, min: 0, max: 1439 },
    wakeMin: { type: Number, required: true, min: 0, max: 1439 },

    /**
     * Which weekdays it is active on, 0 = Sunday, matching `Date.getDay()`.
     *
     * An empty array means every day. Stored that way rather than as `[0..6]` so "daily"
     * survives somebody's locale deciding the week starts on Monday.
     */
    days: {
        type: [Number],
        default: [],
        validate: {
            validator: (v) => v.every((d) => Number.isInteger(d) && d >= 0 && d <= 6),
            message: 'days must be weekday indexes 0-6',
        },
    },

    enabled: { type: Boolean, default: true },

    /** Send a push this many minutes before `bedtimeMin`. 0 disables the reminder. */
    remindMinutesBefore: { type: Number, default: 30, min: 0, max: 180 },

    /**
     * The client's `getTimezoneOffset()` when the schedule was last saved.
     *
     * The reminder sweep runs on a server clock that is UTC in production, so without this a
     * 22:30 bedtime reminder fires at 22:30 UTC — the middle of the afternoon for half the
     * people it is meant for. The same field, for the same reason, as `Medication.tzOffset`.
     */
    tzOffset: { type: Number, default: 0 },

    /** Set when a reminder for this schedule last went out, so one night sends one push. */
    lastRemindedAt: { type: Date, default: null },
}, { timestamps: true });

SleepScheduleSchema.index({ userId: 1, enabled: 1 });

/** How long the routine allows for, in minutes. Wraps midnight, which every bedtime does. */
SleepScheduleSchema.virtual('durationMin').get(function durationMin() {
    return ((this.wakeMin - this.bedtimeMin) % 1440 + 1440) % 1440;
});

SleepScheduleSchema.set('toJSON', { virtuals: true });
SleepScheduleSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('SleepSchedule', SleepScheduleSchema);
