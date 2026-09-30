const mongoose = require('mongoose');

/**
 * One person's cycle-tracking settings.
 *
 * **`enabled` is the switch, not `User.gender`.** Gender decides only what the app offers —
 * see `cycleController.accessFor` — because the field is `null` for many people, and people
 * who chose "Other" may menstruate too. Somebody who set the tracker up has it; somebody who
 * switched it off does not, whatever their profile says.
 *
 * `seed` holds what the setup flow asked, and it is only ever a stand-in: once two cycles are
 * logged the forecast reads the logs and the seed is ignored, the way the score discards a
 * questionnaire answer once the same thing is measured.
 */

const STATUSES = ['none', 'hormonal_contraception', 'pregnant', 'breastfeeding', 'perimenopause'];

const CyclePlanSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true,
    },

    enabled: { type: Boolean, default: false },

    /** Set by the last step of setup. Held here, not on the device, for `SleepPlan.onboarded`'s reason. */
    onboarded: { type: Boolean, default: false },

    /**
     * When somebody said "Not now" to the home screen's offer. The offer is made once; after
     * this the profile row is the only way in.
     */
    offerDismissedAt: { type: Date, default: null },

    seed: {
        /** Local `YYYY-MM-DD`, or null when they did not remember. */
        lastPeriodStart: { type: String, default: null, match: /^\d{4}-\d{2}-\d{2}$/ },
        periodLength: { type: Number, min: 1, max: 14, default: null },
        cycleLength: { type: Number, min: 15, max: 60, default: null },
    },

    /**
     * What changes how a cycle is read.
     *
     * - `hormonal_contraception`: the bleed is a withdrawal bleed, so there is no ovulation to
     *   estimate and the fertile window is never drawn.
     * - `pregnant`, `breastfeeding`: predictions and late reminders pause.
     * - `perimenopause`: predictions widen and the regularity notes stay quiet — variation is
     *   the expected state, not something to raise.
     */
    status: { type: String, enum: STATUSES, default: 'none' },

    /** Opt-in. Off by default, and never drawn under hormonal contraception. */
    showFertileWindow: { type: Boolean, default: false },

    reminders: {
        /** A push a couple of days before the predicted window opens. */
        periodSoon: { type: Boolean, default: true },
        /** A push once the period is past the predicted window. */
        late: { type: Boolean, default: true },
    },

    /**
     * True: a lock screen reads "A reminder from Predyqt" rather than the detail. The inbox
     * card, behind sign-in, keeps the detail either way.
     */
    discreetPush: { type: Boolean, default: true },
}, { timestamps: true });

module.exports = mongoose.model('CyclePlan', CyclePlanSchema);
module.exports.STATUSES = STATUSES;
