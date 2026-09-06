/**
 * What a person has actually done, and which badges that earns.
 *
 * Two halves, deliberately in one file because the split is what makes the feature testable:
 *
 *   - `gather()`  — reads the rows. Needs a database, and is where all the cost is.
 *   - `measure()` — turns those rows into the 24 numbers the catalogue grades against.
 *                   **Pure.** No database, no clock beyond what it is handed.
 *
 * `evaluate()` is the two composed. Every threshold in `achievementCatalogue.js` is asserted
 * against `measure()` rather than against a seeded Mongo, which is the difference between a
 * test suite that runs in a second and one nobody runs.
 *
 * ## Nothing here reads a clinical value
 *
 * The catalogue explains why at length; this file is where it would be broken. `gather()`
 * selects counts, days and identifiers — never a measured result. It reads *that* a blood
 * pressure was logged, never *what it was*; *that* a marker is on record, never its flag.
 * A metric added here that reads a value would let a badge reward somebody for being well,
 * which is the one thing this feature must not do.
 *
 * ## Streaks
 *
 * Three metrics are runs of consecutive days, and all three use `longestRun()` over a set of
 * local `YYYY-MM-DD` strings — the same day key every tracker already writes, so an evening
 * meal in the Americas is not filed under the following day. A streak is measured over the
 * person's whole history rather than "current", because a *current* streak is a number that
 * silently drops to zero overnight and takes a badge with it. See `AchievementUnlock` on why
 * nothing here is ever revoked.
 */
const DailyMetrics = require('../models/DailyMetrics');
const ActivitySession = require('../models/ActivitySession');
const SleepSession = require('../models/SleepSession');
const MealLog = require('../models/MealLog');
const MetricLog = require('../models/MetricLog');
const Medication = require('../models/Medication');
const MedicationDose = require('../models/MedicationDose');
const Biomarker = require('../models/Biomarker');
const TestResult = require('../models/testResultModel');
const PlanItem = require('../models/PlanItem');
const Appointment = require('../models/Appointment');
const Prediction = require('../models/Prediction');
const Conversation = require('../models/Conversation');
const User = require('../models/userModel');
const { ACHIEVEMENTS, grade, describe } = require('./achievementCatalogue');

const DAY_MS = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * Pure helpers
 * ------------------------------------------------------------------ */

/**
 * The longest run of consecutive days in a set of `YYYY-MM-DD` strings.
 *
 * Dates are compared by parsing to UTC midnight, which is safe because the strings were
 * already written in the person's local time — reparsing them as UTC shifts every day by the
 * same amount and leaves the gaps between them unchanged.
 */
const longestRun = (days) => {
    const sorted = [...new Set(days)].filter(Boolean).sort();
    let best = 0;
    let run = 0;
    let previous = null;

    for (const day of sorted) {
        const t = Date.parse(`${day}T00:00:00Z`);
        if (!Number.isFinite(t)) continue;
        run = previous !== null && t - previous === DAY_MS ? run + 1 : 1;
        previous = t;
        if (run > best) best = run;
    }
    return best;
};

/** Sum a field across rows, ignoring nulls — an unworn watch is not a zero-step day. */
const sumOf = (rows, pick) =>
    rows.reduce((total, row) => {
        const v = pick(row);
        return Number.isFinite(v) ? total + v : total;
    }, 0);

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

/**
 * Every row the catalogue needs, for one person, over their whole history.
 *
 * Lifetime rather than a window, because a badge is cumulative: the score asks "how are you
 * this month", this asks "what have you done since you joined". The reads are therefore
 * projections and counts — `distinct`, `countDocuments`, and `select` of the two or three
 * fields that get summed — so the largest thing this pulls into memory is a list of day
 * strings, not a year of sessions.
 */
const gather = async (userId) => {
    const [
        user, dailyMetrics, sessions, sleep, meals, metricLogs,
        medicationCount, dosesTaken, markerNames, reportCount,
        planDone, appointmentCount, predictionCount, conversation,
    ] = await Promise.all([
        User.findById(userId).select('createdAt').lean(),
        DailyMetrics.find({ userId })
            .select('day activity.steps activity.distanceM heart.samples hydration.consumedMl hydration.targetMl hydration.logs')
            .lean(),
        ActivitySession.find({ userId }).select('day distanceM').lean(),
        SleepSession.find({ userId }).select('day').lean(),
        MealLog.find({ userId }).select('day imageUrl').lean(),
        MetricLog.find({ userId }).select('kind day').lean(),
        Medication.countDocuments({ userId }),
        MedicationDose.countDocuments({ userId, status: 'taken' }),
        Biomarker.distinct('name', { userId }),
        TestResult.countDocuments({ 'patient.user_id': userId }),
        PlanItem.countDocuments({ userId, status: 'completed' }),
        Appointment.countDocuments({ userId }),
        Prediction.countDocuments({ userId }),
        Conversation.findOne({ userId }).select('messages.role').lean(),
    ]);

    return {
        joinedAt: user?.createdAt || null,
        dailyMetrics,
        sessions,
        sleep,
        meals,
        metricLogs,
        medicationCount,
        dosesTaken,
        markerCount: markerNames.length,
        reportCount,
        planDone,
        appointmentCount,
        predictionCount,
        assistantMessages: (conversation?.messages || []).filter((m) => m.role === 'user').length,
    };
};

/* ------------------------------------------------------------------ *
 * Measuring
 * ------------------------------------------------------------------ */

/**
 * The 24 numbers, from the rows.
 *
 * Pure, and `now` is a parameter rather than `Date.now()` so `daysSinceJoining` can be
 * asserted rather than approximated.
 */
const measure = (facts, now = Date.now()) => {
    const {
        dailyMetrics = [], sessions = [], sleep = [], meals = [], metricLogs = [],
        medicationCount = 0, dosesTaken = 0, markerCount = 0, reportCount = 0,
        planDone = 0, appointmentCount = 0, predictionCount = 0, assistantMessages = 0,
        joinedAt = null,
    } = facts;

    const water = metricLogs.filter((m) => m.kind === 'water');
    const weight = metricLogs.filter((m) => m.kind === 'weight');
    const pressure = metricLogs.filter((m) => m.kind === 'blood_pressure');

    const mealDays = meals.map((m) => m.day);
    const sleepDays = sleep.map((s) => s.day);

    /**
     * Which trackers this person has ever put something into.
     *
     * Eight, matching the eight the app offers a setup row for on the home screen. A tracker
     * with no rows is absent rather than present-and-zero — this counts breadth, and a
     * tracker somebody opened once and never used is not breadth.
     */
    const trackers = [
        sessions.length > 0,
        sleep.length > 0,
        meals.length > 0,
        water.length > 0,
        weight.length > 0 || pressure.length > 0,
        dosesTaken > 0 || medicationCount > 0,
        reportCount > 0 || markerCount > 0,
        appointmentCount > 0 || planDone > 0,
    ].filter(Boolean).length;

    /**
     * Every day this person recorded anything at all.
     *
     * The union across trackers, not any single one, because the streak badge says "record
     * something" — a day someone logged only a glass of water still counts.
     */
    const activeDays = [
        ...mealDays,
        ...sleepDays,
        ...sessions.map((s) => s.day),
        ...metricLogs.map((m) => m.day),
        ...dailyMetrics.filter((d) => Number.isFinite(d.activity?.steps)).map((d) => d.day),
    ];

    return {
        stepsTotal: Math.round(sumOf(dailyMetrics, (d) => d.activity?.steps)),
        // Session distance is the honest source: a rollup's daily distance includes walking
        // about, and calling that "covered on your sessions" would inflate the badge.
        distanceKm: Math.round(sumOf(sessions, (s) => s.distanceM) / 100) / 10,
        activitySessions: sessions.length,

        sleepNights: sleep.length,
        sleepStreak: longestRun(sleepDays),

        mealsLogged: meals.length,
        mealPhotos: meals.filter((m) => typeof m.imageUrl === 'string' && m.imageUrl).length,
        nutritionStreak: longestRun(mealDays),

        hydrationLogs: water.length,
        // A day counts only when a target was actually set for it: reaching an absent target
        // is not an achievement, it is a division by nothing.
        hydrationDaysMet: dailyMetrics.filter(
            (d) => Number.isFinite(d.hydration?.targetMl)
                && d.hydration.targetMl > 0
                && Number.isFinite(d.hydration?.consumedMl)
                && d.hydration.consumedMl >= d.hydration.targetMl,
        ).length,

        medicationsTracked: medicationCount,
        dosesTaken,

        heartDays: dailyMetrics.filter((d) => (d.heart?.samples || 0) > 0).length,
        bloodPressureLogs: pressure.length,
        weightLogs: weight.length,

        reportsUploaded: reportCount,
        markersTracked: markerCount,
        predictionsRun: predictionCount,

        planItemsDone: planDone,
        appointmentsBooked: appointmentCount,
        assistantMessages,

        activeDayStreak: longestRun(activeDays),
        trackersUsed: trackers,
        daysSinceJoining: joinedAt
            ? Math.max(0, Math.floor((now - new Date(joinedAt).getTime()) / DAY_MS))
            : 0,
    };
};

/* ------------------------------------------------------------------ *
 * Grading
 * ------------------------------------------------------------------ */

/**
 * The whole catalogue graded against one set of measurements.
 *
 * Returns every achievement, locked ones included, because the grid draws them all — a badge
 * you cannot see is one nobody works towards. `points` is the sum over unlocked levels.
 */
const gradeAll = (metrics) => {
    const results = ACHIEVEMENTS.map((achievement) => ({
        ...describe(achievement),
        ...grade(achievement, metrics[achievement.metric]),
    }));

    return {
        achievements: results,
        points: results.reduce((sum, r) => sum + r.points, 0),
        unlocked: results.filter((r) => r.unlocked).length,
        total: results.length,
    };
};

/** Read, measure, grade. The one call every route makes. */
const evaluate = async (userId, { now = Date.now() } = {}) => {
    const facts = await gather(userId);
    const metrics = measure(facts, now);
    return { ...gradeAll(metrics), metrics };
};

module.exports = { gather, measure, gradeAll, evaluate, longestRun, _sumOf: sumOf };
