/**
 * Daily recomputation of plan-item status from due dates.
 *
 * `upcoming → due → urgent` is derived from the calendar, so without a sweep an item that
 * fell overdue overnight would keep reporting `upcoming` until something else touched it.
 * Running it as a job (rather than computing per request) means the reminder query and the
 * timeline query can both use the same index.
 *
 * Only `upcoming`, `due`, and `urgent` are mutable. An item the person ordered, booked,
 * completed, or dismissed is never rewritten by the sweep.
 */
const PlanItem = require('../models/PlanItem');
const Professional = require('../models/Professional');

const startOfToday = () => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
};

/**
 * Attach suggested professionals to urgent consultations that have none.
 * An urgent item the person cannot act on is only half a recommendation.
 */
const attachSuggestions = async () => {
    const needing = await PlanItem.find({
        type: 'consultation',
        status: 'urgent',
        professionalId: { $exists: false },
        speciality: { $exists: true, $ne: null },
    }).limit(200);

    if (!needing.length) return 0;

    const specialities = [...new Set(needing.map((i) => i.speciality))];
    const professionals = await Professional.find({ speciality: { $in: specialities } })
        .select('firstname lastname speciality profile_image')
        .lean();

    let attached = 0;
    for (const item of needing) {
        // Exact enum match: the interpretation schema already constrains the value
        const match = professionals.find((p) => (p.speciality || []).includes(item.speciality));
        if (!match) continue;
        item.professionalId = match._id;
        item.professionalName = `${match.firstname} ${match.lastname}`;
        item.image = match.profile_image || null;
        await item.save();
        attached++;
    }
    return attached;
};

/** Recompute statuses. Returns counts for logging and tests. */
const runStatusSweep = async () => {
    const today = startOfToday();
    const tomorrow = new Date(today.getTime() + 86400000);

    /**
     * Both conditions on `status` must survive into the query.
     *
     * Spreading `{status: {$in: MUTABLE}}` and then adding `status: {$ne: 'urgent'}`
     * silently dropped the first — duplicate object keys overwrite — so the sweep matched
     * every status except the target one and rewrote `completed`, `ordered`, and `booked`
     * items. Caught by a test asserting protected statuses were untouched.
     */
    const mutableExcept = (excluded) => ({
        status: { $in: PlanItem.MUTABLE_STATUSES.filter((s) => s !== excluded) },
    });

    const [toUrgent, toDue, toUpcoming] = await Promise.all([
        PlanItem.updateMany(
            { ...mutableExcept('urgent'), dueDate: { $lt: today } },
            { $set: { status: 'urgent' } }
        ),
        PlanItem.updateMany(
            // A range, not equality: a legacy row stored with a time component would never
            // match an exact midnight timestamp and would skip `due` entirely
            { ...mutableExcept('due'), dueDate: { $gte: today, $lt: tomorrow } },
            { $set: { status: 'due' } }
        ),
        PlanItem.updateMany(
            { ...mutableExcept('upcoming'), dueDate: { $gte: tomorrow } },
            { $set: { status: 'upcoming' } }
        ),
    ]);

    const suggested = await attachSuggestions();

    const result = {
        urgent: toUrgent.modifiedCount,
        due: toDue.modifiedCount,
        upcoming: toUpcoming.modifiedCount,
        professionalsAttached: suggested,
    };

    if (Object.values(result).some(Boolean)) {
        console.log('📅 Plan status sweep:', result);
    }
    return result;
};

/** Schedule the sweep. Runs once at boot so a restarted server is never stale. */
const scheduleStatusSweep = () => {
    const cron = require('node-cron');

    runStatusSweep().catch((e) => console.error('❌ Status sweep failed:', e.message));

    // 02:15 daily — after midnight so "today" has actually rolled over in most timezones
    cron.schedule('15 2 * * *', () => {
        runStatusSweep().catch((e) => console.error('❌ Status sweep failed:', e.message));
    });

    console.log('📅 Plan status sweep scheduled (daily 02:15)');
};

module.exports = { runStatusSweep, scheduleStatusSweep, attachSuggestions };
