/**
 * Turning a medication's schedule into dated doses, and doses into adherence.
 *
 * Pure functions, no database. Everything here is exercised directly by
 * `__tests__/medicationSchedule.test.js`, which is the point: the daily timeline, the
 * monthly calendar and every adherence percentage in the feature are this file, and a
 * rounding decision made here shows up as a number a person judges themselves against.
 *
 * ── Local days, not UTC ───────────────────────────────────────────────────────────────
 *
 * A dose is a calendar event. `MealLog.day` learned this the hard way and the same rule
 * applies: days are `YYYY-MM-DD` strings resolved with the client's offset, because an
 * 11pm dose in the Americas grouped by UTC lands on tomorrow's list — on the one screen the
 * whole feature is built around.
 *
 * ── Occurrences are materialised, not derived on read ────────────────────────────────
 *
 * `expand()` produces the doses that *should* exist; the controller writes the missing ones
 * to `MedicationDose`. It would be cheaper to compute the timeline on every read, but a
 * dose has state — taken, skipped, rescheduled to a different time — and state needs a row.
 * Deriving the schedule while storing only the exceptions means a medication whose schedule
 * changes silently rewrites the person's history of what they actually took.
 */

const DAY_MS = 86_400_000;

/** Frequencies a medication can be taken at. `as_needed` never generates a dose. */
const FREQUENCIES = ['once', 'daily', 'twice_daily', 'three_times_daily', 'weekly', 'specific_days', 'as_needed'];

/** How many times a day each frequency fires, for the default-times fallback. */
const DOSES_PER_DAY = {
    once: 1,
    daily: 1,
    twice_daily: 2,
    three_times_daily: 3,
    weekly: 1,
    specific_days: 1,
    as_needed: 0,
};

/**
 * Sensible clock times when the person has not chosen any.
 *
 * Spread across waking hours rather than every eight hours around the clock: a 2am alarm
 * for a three-times-daily antibiotic is how people stop taking it altogether.
 */
const DEFAULT_TIMES = {
    1: ['09:00'],
    2: ['09:00', '21:00'],
    3: ['08:00', '14:00', '20:00'],
    4: ['08:00', '12:00', '16:00', '20:00'],
};

const pad = (n) => String(n).padStart(2, '0');

/** `YYYY-MM-DD` for a Date, in the timezone `tzOffsetMinutes` describes. */
const localDay = (date, tzOffsetMinutes = 0) =>
    new Date(new Date(date).getTime() - tzOffsetMinutes * 60_000).toISOString().slice(0, 10);

const isDayString = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isTimeString = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

/** Add days to a `YYYY-MM-DD` string without going near local time. */
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** Whole days from `from` to `to`, both `YYYY-MM-DD`. Negative when `to` is earlier. */
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/** 0 = Sunday, matching `Date.getUTCDay()` and the design's Su-first week strip. */
const weekdayOf = (day) => new Date(`${day}T00:00:00Z`).getUTCDay();

/**
 * The instant a dose at `day` + `time` falls on, in the person's timezone.
 * Stored on the dose so reminders and "was this late" can be answered without re-deriving
 * the offset that was in force when it was scheduled.
 */
const instantFor = (day, time, tzOffsetMinutes = 0) =>
    new Date(Date.parse(`${day}T${time}:00Z`) + tzOffsetMinutes * 60_000);

/** The clock times a medication is due at, falling back to a sensible spread. */
const timesFor = (medication) => {
    const given = (medication.times || []).filter(isTimeString);
    if (given.length) return [...given].sort();
    const perDay = DOSES_PER_DAY[medication.frequency] ?? 1;
    return DEFAULT_TIMES[perDay] || DEFAULT_TIMES[1];
};

/**
 * Does this medication fire on this calendar day?
 * Range checks live here so `expand` stays a loop over days.
 */
const occursOn = (medication, day) => {
    const { frequency, startDay, endDay, daysOfWeek, intervalDays } = medication;

    if (frequency === 'as_needed') return false;
    if (startDay && day < startDay) return false;
    if (endDay && day > endDay) return false;

    // A one-off is exactly its start day, nothing else
    if (frequency === 'once') return Boolean(startDay) && day === startDay;

    if (frequency === 'specific_days') {
        // No days chosen means no schedule, not every day. Generating a daily reminder for
        // someone who meant "Mondays and Thursdays" and never finished choosing is worse
        // than generating nothing and letting the setup screen prompt them.
        if (!daysOfWeek?.length) return false;
        return daysOfWeek.includes(weekdayOf(day));
    }

    if (frequency === 'weekly') {
        if (!startDay) return false;
        return daysBetween(startDay, day) % 7 === 0;
    }

    // daily / twice_daily / three_times_daily, optionally every N days
    if (intervalDays && intervalDays > 1) {
        if (!startDay) return false;
        return daysBetween(startDay, day) % intervalDays === 0;
    }

    return true;
};

/**
 * Every dose a medication should produce between two days, inclusive.
 *
 * @param {object} medication  a `Medication`, lean or hydrated
 * @param {string} fromDay     `YYYY-MM-DD`
 * @param {string} toDay       `YYYY-MM-DD`
 * @returns {{medicationId:string, day:string, time:string, scheduledFor:Date}[]}
 */
const expand = (medication, fromDay, toDay) => {
    if (!isDayString(fromDay) || !isDayString(toDay)) {
        throw new Error('expand() needs YYYY-MM-DD bounds');
    }
    if (daysBetween(fromDay, toDay) < 0) return [];

    // Never generate doses before the medication started, however far back the caller asks
    const first = medication.startDay && medication.startDay > fromDay ? medication.startDay : fromDay;
    const last = medication.endDay && medication.endDay < toDay ? medication.endDay : toDay;
    if (daysBetween(first, last) < 0) return [];

    const times = timesFor(medication);
    const tz = medication.tzOffset ?? 0;
    const out = [];

    for (let day = first; daysBetween(day, last) >= 0; day = addDays(day, 1)) {
        if (!occursOn(medication, day)) continue;
        for (const time of times) {
            out.push({
                medicationId: String(medication._id),
                day,
                time,
                scheduledFor: instantFor(day, time, tz),
            });
        }
    }

    return out;
};

/**
 * How late is "late"?
 *
 * A dose taken within this window of its scheduled time counts as on time. Half an hour is
 * the grace an ordinary morning needs — the alternative is an adherence figure that
 * punishes someone for making coffee first, which teaches them to log dishonestly.
 */
const ON_TIME_WINDOW_MINUTES = 30;

/** Classify a recorded dose. Pure, so the same rule runs on write and on read. */
const punctuality = (dose) => {
    if (dose.status !== 'taken' || !dose.takenAt) return null;
    const driftMs = new Date(dose.takenAt).getTime() - new Date(dose.scheduledFor).getTime();
    return Math.abs(driftMs) <= ON_TIME_WINDOW_MINUTES * 60_000 ? 'on_time' : 'late';
};

/**
 * Adherence over a set of doses.
 *
 * The design's home header reads "80% On Time · 20% Taken Late · 5% Not Taken". Those are
 * three shares of the doses that have already come due — a dose scheduled for this evening
 * is neither taken nor missed yet, and counting it as missed would show everyone a failing
 * score every morning.
 *
 * Returns `score: null`, never 0, when nothing has come due. The nutrition tracker's
 * `alignment: 'unassessed'` makes the same distinction for the same reason: rendering "0%"
 * tells someone they failed at something that has not happened.
 */
const adherence = (doses = [], now = new Date()) => {
    const due = doses.filter((d) => new Date(d.scheduledFor) <= now || d.status !== 'scheduled');

    const counts = { onTime: 0, late: 0, taken: 0, skipped: 0, missed: 0, pending: 0 };

    for (const dose of due) {
        if (dose.status === 'taken') {
            counts.taken++;
            if (punctuality(dose) === 'on_time') counts.onTime++;
            else counts.late++;
        } else if (dose.status === 'skipped') {
            counts.skipped++;
        } else if (new Date(dose.scheduledFor) <= now) {
            // Came due and nothing was recorded
            counts.missed++;
        } else {
            counts.pending++;
        }
    }

    const assessed = counts.taken + counts.skipped + counts.missed;

    return {
        assessed,
        ...counts,
        /** Share of due doses actually taken, 0-100. Null when nothing has come due. */
        score: assessed === 0 ? null : Math.round((counts.taken / assessed) * 100),
        onTimeRate: assessed === 0 ? null : Math.round((counts.onTime / assessed) * 100),
        lateRate: assessed === 0 ? null : Math.round((counts.late / assessed) * 100),
        missedRate: assessed === 0 ? null : Math.round((counts.missed / assessed) * 100),
    };
};

/**
 * One entry per calendar day, for the design's monthly grid.
 * A day is `taken` only when every dose on it was taken — a partial day is `partial`, not a
 * tick, because a tick on a day someone missed their evening dose is a lie they will act on.
 */
const byDay = (doses = [], now = new Date()) => {
    const days = new Map();

    for (const dose of doses) {
        if (!days.has(dose.day)) days.set(dose.day, []);
        days.get(dose.day).push(dose);
    }

    return [...days.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, list]) => {
            const taken = list.filter((d) => d.status === 'taken').length;
            const skipped = list.filter((d) => d.status === 'skipped').length;
            const missed = list.filter(
                (d) => d.status === 'scheduled' && new Date(d.scheduledFor) <= now
            ).length;
            const pending = list.length - taken - skipped - missed;

            let status;
            if (pending === list.length) status = 'upcoming';
            else if (taken === list.length) status = 'taken';
            else if (missed > 0) status = 'missed';
            else if (skipped > 0 && taken === 0) status = 'skipped';
            else status = 'partial';

            return { day, total: list.length, taken, skipped, missed, pending, status };
        });
};

/**
 * Is the supply low enough to prompt a refill?
 * Counted in doses remaining rather than days, because a twice-daily medicine at ten
 * tablets left is five days and a weekly one is ten weeks.
 */
const needsRefill = (medication) => {
    const { remainingDoses, refillThreshold, refillReminder } = medication;
    if (!refillReminder) return false;
    if (typeof remainingDoses !== 'number' || typeof refillThreshold !== 'number') return false;
    return remainingDoses <= refillThreshold;
};

module.exports = {
    FREQUENCIES,
    DOSES_PER_DAY,
    DEFAULT_TIMES,
    ON_TIME_WINDOW_MINUTES,
    localDay,
    isDayString,
    isTimeString,
    addDays,
    daysBetween,
    weekdayOf,
    instantFor,
    timesFor,
    occursOn,
    expand,
    punctuality,
    adherence,
    byDay,
    needsRefill,
};
