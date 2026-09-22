/**
 * Everything Miovix Age reads, in one pass.
 *
 * `observedProfile.gather` does this job for the Miovix score over a thirty-day window. This
 * is its longer-window sibling rather than a parameter on it, for two reasons that are really
 * one reason: the windows are different because the questions are different. A score asks
 * what somebody has been doing lately and should move within a week; a biological age asks
 * what somebody's life looks like and must not lurch because of one good fortnight. Whoop
 * uses six months for the same reason, and so does this.
 *
 * Which is also why this must never be called from `scoreController.touch`. That runs on
 * every write path; this reads six months across five collections and produces a number that
 * cannot meaningfully change between two app opens. `ageController` rate-limits it to once a
 * day, and the only things that force it are a new blood report and an explicit recompute.
 *
 * **Every aggregate here is over the days that hold data, never over the calendar.** A watch
 * left on a charger is not a day of no steps, and averaging the gap in as a zero reports a
 * sedentary month to somebody who went on holiday. `utils/nutritionInsight.js` states the
 * same rule about meals; it matters more here, because the output is somebody's age.
 */
const DailyMetrics = require('../models/DailyMetrics');
const ActivitySession = require('../models/ActivitySession');
const SleepSession = require('../models/SleepSession');
const Biomarker = require('../models/Biomarker');
const User = require('../models/userModel');
const sleepInsight = require('./sleepInsight');
const { WINDOW_DAYS } = require('./lifestyleAge');

const DAY_MS = 86400000;

/** How far back biomarkers are read. Freshness decays them; `labAge` picks the panel. */
const BIOMARKER_LOOKBACK_DAYS = 1095;

/** Types `healthSync` normalises to, that count as muscle-strengthening activity. */
const STRENGTH_TYPES = new Set(['weightlifting']);

const localDay = (date, tzOffset = 0) =>
    new Date(date.getTime() - tzOffset * 60000).toISOString().slice(0, 10);

const dayRange = (days, tzOffset) => {
    const out = [];
    for (let i = days - 1; i >= 0; i -= 1) {
        out.push(localDay(new Date(Date.now() - i * DAY_MS), tzOffset));
    }
    return out;
};

const finite = (n) => Number.isFinite(n);

/** Mean over the entries that exist. Null, never zero, when none do. */
const mean = (values) => {
    const ok = values.filter(finite);
    return ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null;
};

/**
 * Median over the entries that exist.
 *
 * Used for the two figures a watch reports sparsely and noisily — VO2 max and resting heart
 * rate. A mean there is dragged by the one morning a watch misread a resting rate as 110,
 * and both are meant to describe a settled level rather than a week.
 */
const median = (values) => {
    const ok = values.filter(finite).sort((a, b) => a - b);
    if (!ok.length) return null;
    const mid = Math.floor(ok.length / 2);
    return ok.length % 2 ? ok[mid] : (ok[mid - 1] + ok[mid]) / 2;
};

const countOf = (values) => values.filter(finite).length;

/**
 * Chronological age in years, from `User.dob`.
 *
 * `dob` is a free string on the model, so anything unparseable has to return null rather
 * than a number — an age computed from a date nobody can read is the input to an equation
 * that will answer anyway.
 */
const ageFrom = (dob) => {
    if (!dob) return null;
    const born = new Date(dob);
    if (Number.isNaN(born.getTime())) return null;
    const years = (Date.now() - born.getTime()) / (365.2425 * DAY_MS);
    return years > 0 && years < 130 ? years : null;
};

/**
 * Weekly minutes from a per-day series, scaled by the days actually measured.
 *
 * Summing and dividing by the window would report a third of somebody's training because a
 * watch only synced for two months of the six.
 */
const weeklyFrom = (perDay, daysMeasured) => {
    if (!daysMeasured) return null;
    const total = perDay.filter(finite).reduce((a, b) => a + b, 0);
    return (total / daysMeasured) * 7;
};

/**
 * Read one person's whole picture and shape it into `lifestyleAge` inputs.
 *
 * Returns the raw rows alongside the inputs so a caller can persist provenance without a
 * second query.
 */
const gather = async (userId, { windowDays = WINDOW_DAYS, tzOffset = 0 } = {}) => {
    const days = dayRange(windowDays, tzOffset);
    const since = new Date(Date.now() - windowDays * DAY_MS);

    const [user, metrics, sessions, nights, biomarkers] = await Promise.all([
        User.findById(userId).select('dob gender height weight observed').lean(),
        DailyMetrics.find({ userId, day: { $gte: days[0] } })
            .select('day activity sleep heart body bloodPressure').sort({ day: 1 }).lean(),
        ActivitySession.find({ userId, startedAt: { $gte: since } })
            .select('type durationSec day').lean(),
        SleepSession.find({ userId, startedAt: { $gte: since } })
            .select('startedAt endedAt').lean(),
        Biomarker.find({
            userId,
            measuredAt: { $gte: new Date(Date.now() - BIOMARKER_LOOKBACK_DAYS * DAY_MS) },
        }).select('name value measuredAt needsReview').sort({ measuredAt: -1 }).lean(),
    ]);

    const chronologicalAge = ageFrom(user?.dob);
    const sex = user?.gender ?? null;

    const steps = metrics.map((m) => m.activity?.steps ?? null);
    const vo2 = metrics.map((m) => m.heart?.vo2Max ?? null);
    const resting = metrics.map((m) => m.heart?.restingBpm ?? null);
    const asleepH = metrics.map((m) => (finite(m.sleep?.asleepMin) ? m.sleep.asleepMin / 60 : null));
    const systolic = metrics.map((m) => m.bloodPressure?.systolic ?? null);
    const diastolic = metrics.map((m) => m.bloodPressure?.diastolic ?? null);

    /**
     * Minutes in heart-rate zones 4 and 5, which is what "vigorous" means here.
     *
     * `zoneMinutes` is indexed from zone 1, so zones 4 and 5 are array positions 3 and 4.
     * Off-by-one here does not throw: it silently scores somebody's easy jogging as hard
     * effort.
     */
    const vigorousPerDay = metrics.map((m) => {
        const z = m.heart?.zoneMinutes;
        if (!Array.isArray(z)) return null;
        const hard = (z[3] ?? 0) + (z[4] ?? 0);
        return finite(hard) ? hard : null;
    });

    const strengthByDay = new Map();
    for (const s of sessions) {
        if (!STRENGTH_TYPES.has(String(s.type || '').toLowerCase())) continue;
        strengthByDay.set(s.day, (strengthByDay.get(s.day) || 0) + (s.durationSec || 0) / 60);
    }
    // Zero on a measured day is a real zero here — the person trained that week and did no
    // strength work — so the series covers every day any activity was recorded, not only the
    // days strength happened. Without that, somebody who lifts once a month averages as
    // though they lift every day they lift.
    const activeDays = new Set(sessions.map((s) => s.day));
    const strengthPerDay = [...activeDays].map((d) => strengthByDay.get(d) || 0);

    const heightM = finite(user?.height) ? user.height / 100 : null;
    const weightKg = median(metrics.map((m) => m.body?.weightKg ?? null))
        ?? user?.observed?.weightKg ?? null;
    const bmi = heightM && finite(weightKg) && heightM > 0.5
        ? weightKg / (heightM * heightM)
        : null;
    const bmiDays = countOf(metrics.map((m) => m.body?.weightKg ?? null))
        || (finite(weightKg) ? 1 : 0);

    // Circular arithmetic, delegated: a schedule that averages 23:40 and 00:20 to midday is
    // the failure `sleepInsight.meanClock` exists to prevent, and reimplementing it here
    // would be a second place for it to go wrong.
    const spread = sleepInsight.consistency(nights, tzOffset);

    const bpDays = countOf(systolic);
    const meanSys = mean(systolic);
    const meanDia = mean(diastolic);

    const inputs = {
        vo2max: { value: median(vo2), days: countOf(vo2) },
        resting_hr: { value: median(resting), days: countOf(resting) },
        steps: { value: mean(steps), days: countOf(steps) },
        vigorous_minutes: {
            value: weeklyFrom(vigorousPerDay, countOf(vigorousPerDay)),
            days: countOf(vigorousPerDay),
        },
        strength_minutes: {
            value: weeklyFrom(strengthPerDay, strengthPerDay.length),
            days: activeDays.size,
        },
        sleep_duration: { value: mean(asleepH), days: countOf(asleepH) },
        sleep_consistency: {
            value: finite(spread.spreadMin) ? spread.spreadMin / 60 : null,
            days: spread.nights,
        },
        bmi: { value: bmi, days: bmiDays },
        blood_pressure: {
            value: finite(meanSys) && finite(meanDia)
                ? { systolic: meanSys, diastolic: meanDia }
                : null,
            days: bpDays,
        },
    };

    return {
        chronologicalAge,
        sex,
        windowDays,
        inputs,
        biomarkers,
        /** What the window actually held, for the snapshot's provenance. */
        observedDays: metrics.length,
    };
};

module.exports = { gather, ageFrom, BIOMARKER_LOOKBACK_DAYS, STRENGTH_TYPES, _mean: mean, _median: median };
