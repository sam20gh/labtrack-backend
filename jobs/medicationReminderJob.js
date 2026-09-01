/**
 * Medication dose reminders.
 *
 * Unlike `reminderJob.js`, which sweeps once a day for plan items due in a week, a dose
 * reminder has to be punctual: "take your 8pm tablet" is worthless at 9am the next morning.
 * This runs every few minutes and looks for doses that have just come due.
 *
 * Four guards keep it from becoming the thing people mute:
 *
 *   1. **`remindedAt` is set before the push is attempted.** A dose is announced once, ever.
 *      A restarted server mid-send must not re-notify — being pestered twice about the same
 *      tablet is how notifications get turned off for the whole app. The one exception is a
 *      person with no registered device: nothing was announced, nothing can be duplicated,
 *      and stamping it would mean that enabling notifications at 21:05 still loses the 21:00
 *      dose. That is indistinguishable from the feature not working, which is how this was
 *      found.
 *   2. **A grace window, not "everything overdue".** A dose more than `LATE_GRACE_MINUTES`
 *      past due is marked reminded and skipped silently. Coming back from a weekend offline
 *      should not produce forty notifications.
 *   3. **Quiet hours are respected**, via the same `inQuietHours` the plan reminders use —
 *      with one deliberate exception below.
 *   4. **Already-actioned doses are excluded at the query.** Someone who took their tablet
 *      early gets no reminder for it.
 */
const Medication = require('../models/Medication');
const MedicationDose = require('../models/MedicationDose');
const User = require('../models/userModel');
const { send, messagesFor, inQuietHours } = require('../utils/pushSender');
const scheduleUtil = require('../utils/medicationSchedule');

/** How often the sweep runs. */
const INTERVAL_MS = 5 * 60 * 1000;

/** A dose more than this far past due is written off rather than announced late. */
const LATE_GRACE_MINUTES = 90;

/** Fire this many minutes before the dose is due, so the person is not already late. */
const LEAD_MINUTES = 0;

const composeMessage = (dose, medication) => {
    const bits = [medication?.dose, medication?.strength].filter(Boolean).join(' · ');
    return {
        title: 'Time for your medication',
        body: bits
            ? `${dose.medicationName} — ${bits}`
            : `Time to take your ${dose.medicationName}.`,
        data: { type: 'medication_dose', doseId: String(dose._id), medicationId: String(dose.medicationId) },
    };
};

/**
 * One sweep. Exported so a test can run it without waiting on a timer.
 * @returns {Promise<{considered:number, sent:number, suppressed:number}>}
 */
const runMedicationReminders = async (now = new Date()) => {
    const windowStart = new Date(now.getTime() - LATE_GRACE_MINUTES * 60_000);
    const windowEnd = new Date(now.getTime() + LEAD_MINUTES * 60_000);

    const due = await MedicationDose.find({
        status: 'scheduled',
        remindedAt: null,
        scheduledFor: { $gte: windowStart, $lte: windowEnd },
    }).limit(500).lean();

    if (!due.length) return { considered: 0, sent: 0, suppressed: 0 };

    const medIds = [...new Set(due.map((d) => String(d.medicationId)))];
    const meds = await Medication.find({ _id: { $in: medIds } }).lean();
    const medById = new Map(meds.map((m) => [String(m._id), m]));

    const userIds = [...new Set(due.map((d) => String(d.userId)))];
    const users = await User.find({ _id: { $in: userIds } })
        .select('pushTokens notificationPreferences')
        .lean();
    const userById = new Map(users.map((u) => [String(u._id), u]));

    const messages = [];
    const announced = [];
    let suppressed = 0;
    let undeliverable = 0;

    for (const dose of due) {
        const medication = medById.get(String(dose.medicationId));
        const user = userById.get(String(dose.userId));

        /**
         * No device on the account — the person has never granted notification permission,
         * or their token never reached us. Checked before anything is stamped, and
         * deliberately NOT marked as announced: this is the one suppression reason that can
         * become deliverable within the same grace window, and burning the row means the
         * reminder they just turned on still never arrives. Re-considering it costs one
         * indexed query every five minutes for at most 90 minutes, and sends nothing until
         * there is somewhere to send it.
         */
        if (!user || !(user.pushTokens || []).length) { undeliverable++; suppressed++; continue; }

        // Mark every dose we could have reached them about as announced, whether or not a
        // push actually goes out. A dose we chose not to send for is still a dose that has
        // had its moment; leaving remindedAt null would have it reconsidered on every sweep
        // for the next 90 minutes.
        announced.push(dose._id);

        if (!medication || !medication.remindersEnabled || !medication.active) { suppressed++; continue; }

        /**
         * Quiet hours, with one exception.
         *
         * A person who deliberately schedules a dose for 6am has told us more about when
         * they want to hear from us than a default quiet window has. Suppressing a reminder
         * for a dose the person themselves placed inside their quiet hours makes the feature
         * silently not work. Quiet hours suppress *late* reminders — ones drifting into the
         * night because a dose was missed — not punctual ones.
         */
        const minutesLate = (now.getTime() - new Date(dose.scheduledFor).getTime()) / 60_000;
        if (minutesLate > 15 && inQuietHours(user.notificationPreferences, now, medication.tzOffset)) {
            suppressed++;
            continue;
        }

        messages.push(...messagesFor(user, composeMessage(dose, medication)));
    }

    // Written before sending, so a crash mid-send cannot produce a duplicate.
    if (announced.length) {
        await MedicationDose.updateMany({ _id: { $in: announced } }, { remindedAt: now });
    }

    const result = messages.length ? await send(messages) : { sent: 0 };

    if (messages.length || undeliverable) {
        console.log(
            `💊 Dose reminders: ${result.sent} sent, ${suppressed} suppressed ` +
            `(${undeliverable} with no registered device), ${due.length} considered`
        );
    }

    return { considered: due.length, sent: result.sent, suppressed, undeliverable };
};

/**
 * Refill nudges.
 *
 * Separate from the dose sweep and run once a day: a refill is not time-critical to the
 * minute, and mixing it into the five-minute loop would nag.
 */
const runRefillReminders = async () => {
    const low = await Medication.find({
        active: true,
        refillReminder: true,
        remainingDoses: { $ne: null },
    }).lean();

    const needing = low.filter(scheduleUtil.needsRefill);
    if (!needing.length) return { sent: 0 };

    const users = await User.find({ _id: { $in: needing.map((m) => m.userId) } })
        .select('pushTokens notificationPreferences')
        .lean();
    const userById = new Map(users.map((u) => [String(u._id), u]));

    const messages = [];
    for (const med of needing) {
        const user = userById.get(String(med.userId));
        if (!user || inQuietHours(user.notificationPreferences, new Date(), med.tzOffset)) continue;
        messages.push(...messagesFor(user, {
            title: 'Running low',
            body: `You have ${med.remainingDoses} ${med.remainingDoses === 1 ? 'dose' : 'doses'} of ${med.name} left.`,
            data: { type: 'medication_refill', medicationId: String(med._id) },
        }));
    }

    const result = messages.length ? await send(messages) : { sent: 0 };
    if (messages.length) console.log(`💊 Refill reminders: ${result.sent} sent`);
    return result;
};

const scheduleMedicationReminders = () => {
    setInterval(() => {
        runMedicationReminders().catch((e) => console.error('❌ Dose reminder sweep failed:', e.message));
    }, INTERVAL_MS);

    // Refills once a day
    setInterval(() => {
        runRefillReminders().catch((e) => console.error('❌ Refill sweep failed:', e.message));
    }, 24 * 60 * 60 * 1000);

    console.log('💊 Medication reminder job scheduled');
};

module.exports = {
    scheduleMedicationReminders,
    runMedicationReminders,
    runRefillReminders,
    LATE_GRACE_MINUTES,
};
