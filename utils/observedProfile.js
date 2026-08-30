/**
 * Everything LabTrack has actually measured about a person, and the profile derived from it.
 *
 * Two exports, deliberately in one file because they read the same rows and running the
 * queries twice on one request is the obvious way this gets slow:
 *
 *   - `gather()`   — one read per source, shaped for `labtrackScore.computeScore`
 *   - `derive()`   — the same data folded into the `User.observed` subdocument
 *
 * The point of `User.observed` is stated on the schema and worth repeating here: it does not
 * overwrite `healthAssessment`. The questionnaire answers stay exactly where they are, and
 * consumers read the measured value first and fall back. That is what lets the score, the
 * interpretation engine and the plan generator all stop trusting an onboarding answer the
 * moment there is something better, without ever destroying the answer itself.
 *
 * `refresh()` is safe to call on every sync and every log. It is a rebuild from the rows,
 * never an increment — same rule `DailyMetrics` follows, for the same reason.
 */
const DailyMetrics = require('../models/DailyMetrics');
const ActivitySession = require('../models/ActivitySession');
const ActivityPlan = require('../models/ActivityPlan');
const MealLog = require('../models/MealLog');
const Medication = require('../models/Medication');
const MedicationDose = require('../models/MedicationDose');
const PlanItem = require('../models/PlanItem');
const User = require('../models/userModel');
const { adherence: doseAdherence } = require('./medicationSchedule');
const bloodPressure = require('./bloodPressure');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 30;

/** Local `YYYY-MM-DD`, matching how every tracker stores its `day`. */
const dayString = (date, tzOffsetMinutes = 0) =>
    new Date(new Date(date).getTime() - tzOffsetMinutes * 60_000).toISOString().slice(0, 10);

/** The window's days, oldest first, so a series has a row for a day nothing reported. */
const dayRange = (days, tzOffset = 0) => {
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
        out.push(dayString(Date.now() - i * DAY_MS, tzOffset));
    }
    return out;
};

/**
 * Read every observed source for one person.
 *
 * Biomarkers and plan items are passed in by the caller rather than read here: the
 * interpretation controller has already loaded both by the time it wants a score, and this
 * module has no business owning the biomarker query.
 */
const gather = async (userId, { windowDays = DEFAULT_WINDOW_DAYS, tzOffset = 0 } = {}) => {
    const days = dayRange(windowDays, tzOffset);
    const from = new Date(Date.now() - windowDays * DAY_MS);

    const [metrics, activityPlan, meals, medications, doses, sessions] = await Promise.all([
        DailyMetrics.find({ userId, day: { $gte: days[0] } }).sort({ day: 1 }).lean(),
        ActivityPlan.findOne({ userId }).lean(),
        MealLog.find({ userId, eatenAt: { $gte: from } }).select('day calories analysis').lean(),
        Medication.find({ userId, active: true }).select('_id').lean(),
        MedicationDose.find({ userId, scheduledFor: { $gte: from } })
            .select('status scheduledFor takenAt day').lean(),
        ActivitySession.find({ userId, day: { $gte: days[0] } }).select('type day').lean(),
    ]);

    const byDay = new Map(metrics.map((m) => [m.day, m]));

    /**
     * A row per day in the window, `null` where nothing reported rather than `0`.
     *
     * A watch that was not worn and a day of no steps are different facts, and summing the
     * first as zero tells someone they walked nowhere on a day nobody measured. Identical
     * to the shape `activityController.getSummary` builds — deliberately, so the pillar and
     * the dashboard cannot disagree about one week.
     */
    const activitySeries = days.map((day) => {
        const r = byDay.get(day);
        return {
            day,
            sessions: r?.activity?.sessions || 0,
            exerciseMin: r?.activity?.exerciseMin ?? null,
            activeKcal: r?.activity?.activeKcal ?? null,
            steps: r?.activity?.steps ?? null,
            distanceM: r?.activity?.distanceM ?? null,
        };
    });

    return {
        windowDays,
        days,
        dailyMetrics: metrics,
        activitySeries,
        activityTargets: activityPlan?.targets || null,
        meals,
        doses,
        activeMedicationCount: medications.length,
        sessions,
    };
};

/* ------------------------------------------------------------------ *
 * Derivation
 * ------------------------------------------------------------------ */

const mean = (nums) => (nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null);

const median = (nums) => {
    if (!nums.length) return null;
    const s = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const round = (n, dp = 0) => (n === null ? null : Math.round(n * 10 ** dp) / 10 ** dp);

/**
 * The assessment's `fitnessLevel` vocabulary, derived from what was recorded.
 *
 * Deliberately uses the same three words the questionnaire offers rather than a new scale,
 * so a consumer can read `observed.fitnessLevel || healthAssessment.lifestyle.fitnessLevel`
 * and get a comparable answer either way. Thresholds are the WHO weekly guideline (150
 * minutes of moderate activity) and roughly double it.
 */
const fitnessFor = (weeklyMinutes, weeklySessions) => {
    if (!Number.isFinite(weeklyMinutes)) return null;
    if (weeklyMinutes >= 300 && weeklySessions >= 4) return 'Advanced';
    if (weeklyMinutes >= 150) return 'Intermediate';
    return 'Beginner';
};

/** The assessment's `exerciseFrequency` vocabulary, from sessions a week. */
const frequencyFor = (weeklySessions) => {
    if (!Number.isFinite(weeklySessions)) return null;
    if (weeklySessions < 0.5) return 'None';
    if (weeklySessions < 2) return 'Light';
    if (weeklySessions < 4) return 'Moderate';
    if (weeklySessions < 6) return 'Active';
    return 'Very Active';
};

/**
 * Fold gathered rows into the `User.observed` shape.
 *
 * Pure, so the thresholds above are testable without a database. Every field is null when
 * the window held nothing for it — `refresh` writes those nulls, because a value that
 * stopped being measured must stop being asserted rather than linger as the last thing a
 * device happened to report.
 */
const derive = (gathered, { latestWeight } = {}) => {
    const { dailyMetrics = [], activitySeries = [], meals = [], doses = [], sessions = [], windowDays } = gathered;
    const weeks = windowDays / 7;

    const restings = dailyMetrics.map((m) => m.heart?.restingBpm).filter(Number.isFinite);
    const hrvs = dailyMetrics.map((m) => m.heart?.hrvMs).filter(Number.isFinite);
    const asleep = dailyMetrics.map((m) => m.sleep?.asleepMin).filter(Number.isFinite);
    const sleepScores = dailyMetrics.map((m) => m.sleep?.score).filter(Number.isFinite);
    const steps = activitySeries.map((p) => p.steps).filter(Number.isFinite);

    const totalMinutes = activitySeries.reduce((s, p) => s + (p.exerciseMin || 0), 0);
    const totalSessions = activitySeries.reduce((s, p) => s + (p.sessions || 0), 0);
    const weeklyMinutes = totalMinutes ? round(totalMinutes / weeks) : null;
    const weeklySessions = totalSessions ? round(totalSessions / weeks, 1) : null;

    // Commonest recorded types, so the plan can suggest more of what someone already does.
    const typeCounts = {};
    for (const s of sessions) typeCounts[s.type] = (typeCounts[s.type] || 0) + 1;
    const exerciseTypes = Object.entries(typeCounts)
        .sort(([, a], [, b]) => b - a).slice(0, 4).map(([t]) => t);

    const byMealDay = new Map();
    for (const m of meals) byMealDay.set(m.day, (byMealDay.get(m.day) || 0) + (m.calories || 0));

    const adherence = doses.length ? doseAdherence(doses) : null;

    // Blood pressure is summarised rather than averaged into one figure, so the worst reading
    // in the window survives alongside the mean — see `bloodPressure.summarise`.
    const pressures = dailyMetrics
        .filter((m) => m.bloodPressure?.readings > 0
            && Number.isFinite(m.bloodPressure.systolic) && Number.isFinite(m.bloodPressure.diastolic))
        .map((m) => ({ systolic: m.bloodPressure.systolic, diastolic: m.bloodPressure.diastolic }));
    const bpSummary = pressures.length ? bloodPressure.summarise(pressures) : null;

    const hydrationDays = dailyMetrics.filter((m) => m.hydration?.logs > 0);

    return {
        weightKg: latestWeight?.value ?? null,
        weightAt: latestWeight?.at ?? null,
        weightSource: latestWeight?.source ?? null,

        restingBpm: round(median(restings)),
        hrvMs: round(median(hrvs)),

        sleepMinutes: round(mean(asleep)),
        sleepScore: round(mean(sleepScores)),
        nightsRecorded: sleepScores.length,

        weeklyExerciseMin: weeklyMinutes,
        weeklySessions,
        dailySteps: round(mean(steps)),

        fitnessLevel: fitnessFor(weeklyMinutes, weeklySessions),
        exerciseFrequency: frequencyFor(weeklySessions),
        exerciseTypes: exerciseTypes.length ? exerciseTypes : undefined,

        dailyCalories: byMealDay.size ? round(mean([...byMealDay.values()])) : null,
        daysLogged: byMealDay.size,

        medicationAdherence: adherence?.score ?? null,

        bloodPressure: bpSummary ? {
            systolic: bpSummary.mean.systolic,
            diastolic: bpSummary.mean.diastolic,
            category: bpSummary.mean.category?.key ?? null,
            readings: bpSummary.readings,
            // Carried separately so an interpretation cannot read a reassuring mean over a
            // window that contained a crisis reading.
            hadCrisis: bpSummary.hadCrisis,
        } : null,

        dailyWaterMl: hydrationDays.length
            ? round(mean(hydrationDays.map((m) => m.hydration.consumedMl ?? 0)))
            : null,
        waterDaysLogged: hydrationDays.length,

        windowDays,
        refreshedAt: new Date(),
    };
};

/**
 * Recompute `User.observed` and write it.
 *
 * Called after a device sync and after a meal, dose or session is logged. Returns the
 * derived object so a caller that has just refreshed does not have to read the user back.
 */
const refresh = async (userId, { windowDays = DEFAULT_WINDOW_DAYS, tzOffset = 0, gathered } = {}) => {
    const data = gathered || await gather(userId, { windowDays, tzOffset });
    const observed = derive(data, { latestWeight: await latestWeight(userId) });

    await User.findByIdAndUpdate(userId, { $set: { observed } });
    return observed;
};

/**
 * The most recent weight measurement.
 *
 * Reads the health-store rollup only. `User.weight` is deliberately not consulted: that field
 * holds what someone typed during onboarding, and treating it as a measurement is exactly the
 * conflation this module exists to end. When nothing has been measured the score falls back
 * to `User.weight` itself and labels the body pillar `reported` — which is honest, and
 * visible to the person on the breakdown screen.
 */
const latestWeight = async (userId) => {
    const row = await DailyMetrics.findOne({ userId, 'body.weightKg': { $ne: null } })
        .sort({ day: -1 }).select('day body').lean();
    if (!row?.body?.weightKg) return null;
    return {
        value: row.body.weightKg,
        // The measurement's own timestamp where the rollup kept one; the day is the fallback.
        at: row.body.measuredAt || new Date(row.day),
        source: row.body.weightSource || 'device',
    };
};

module.exports = {
    gather,
    derive,
    refresh,
    latestWeight,
    DEFAULT_WINDOW_DAYS,
    _fitnessFor: fitnessFor,
    _frequencyFor: frequencyFor,
    _dayRange: dayRange,
};
