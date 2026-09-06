/**
 * The derived readings on the sleep screens that are not one night's rollup —
 * `Design/sleep.svg` frames 12 (Sleep Insight), 13 (Total Sleep) and the stage breakdown
 * frames 10 and 28 draw.
 *
 * A deterministic module, in the series with `medicationCatalogue.js`, `bloodPressure.js`,
 * `nutritionSafety.js`, `reviewSla.js`, `predictionForecast.js` and `activityInsight.js`,
 * and for the reason every one of those gives: these are figures a person is shown next to
 * their own records, so they have to be reproducible from those records and pinnable in a
 * test. The engine that writes prose about them is downstream of this and cannot change a
 * number here.
 *
 * Four rules hold across all of it, three inherited from the trackers this sits beside:
 *
 * 1. **Null, never zero.** A window nothing was recorded in scores `null`. A comparison
 *    against a window with no data is `null` rather than "+100%", which would tell somebody
 *    their sleep doubled because the app had not been installed yet.
 * 2. **Averages divide by the nights that reported**, never by the length of the window —
 *    the line `utils/nutritionInsight.js` holds. A fortnight away from a watch is not a
 *    fortnight of no sleep.
 * 3. **A stage nobody measured is absent, not zero.** A tracker that reports only a total
 *    must not be rendered as somebody who got no deep sleep at all.
 * 4. **Bedtime and wake are local clock times**, folded onto a 24-hour dial around the
 *    night's own midpoint. Averaging 23:40 and 00:20 as 1420 and 20 minutes gives 12:00
 *    midday, which is the one answer that cannot be right for either night.
 */

const finite = (v) => Number.isFinite(v);
const round = (v, dp = 0) => {
    const f = 10 ** dp;
    return Math.round(v * f) / f;
};

/** The four bands every screen draws, in the order the design lists them. */
const STAGES = ['deep', 'rem', 'light', 'awake'];

/** `SleepSession.stages` field name for a stage key. */
const STAGE_FIELD = { deep: 'deepMin', rem: 'remMin', light: 'lightMin', awake: 'awakeMin' };

/**
 * Local minutes-from-midnight for an instant, given the client's `getTimezoneOffset()`.
 *
 * The rows carry UTC instants and a local `day`; bucketing the instant would file a
 * 23:30 bedtime in the Americas at 04:30, on the one card whose entire content is what
 * time somebody goes to bed.
 */
const localMinutes = (instant, tzOffsetMinutes = 0) => {
    const t = new Date(instant);
    if (Number.isNaN(t.getTime())) return null;
    const shifted = new Date(t.getTime() - tzOffsetMinutes * 60_000);
    return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
};

/**
 * The mean of a set of clock times, in minutes from midnight.
 *
 * Circular: each time is a point on a 24-hour dial and the mean is the angle of their
 * resultant vector. This is what makes 23:40 and 00:20 average to midnight rather than to
 * midday, and it is the only reason bedtime is not computed with a plain mean like every
 * other figure here.
 *
 * Returns null for an empty set, and for the degenerate case where the times are spread so
 * evenly around the dial that no mean exists — somebody whose sleep has no pattern at all
 * is better told that than handed an arbitrary hour.
 */
const meanClock = (minutes = []) => {
    const values = minutes.filter(finite);
    if (!values.length) return null;

    let x = 0;
    let y = 0;
    for (const m of values) {
        const angle = (m / 1440) * 2 * Math.PI;
        x += Math.cos(angle);
        y += Math.sin(angle);
    }

    const resultant = Math.hypot(x, y) / values.length;
    if (resultant < 0.05) return null;

    const angle = Math.atan2(y / values.length, x / values.length);
    return Math.round(((angle / (2 * Math.PI)) * 1440 + 1440) % 1440);
};

/**
 * How much the clock times scatter, in minutes.
 *
 * The circular standard deviation, which is what the design's consistency reading needs and
 * what a plain standard deviation gets wrong at exactly the hour most people go to bed.
 */
const clockSpread = (minutes = []) => {
    const values = minutes.filter(finite);
    if (values.length < 2) return null;

    let x = 0;
    let y = 0;
    for (const m of values) {
        const angle = (m / 1440) * 2 * Math.PI;
        x += Math.cos(angle);
        y += Math.sin(angle);
    }
    const resultant = Math.hypot(x, y) / values.length;
    if (resultant <= 0) return null;

    // `Math.log(1)` is `-0`, so a perfectly regular schedule otherwise comes back as `-0`
    // — which is not `0` to a strict comparison and reads as a negative spread on a screen.
    const sd = Math.sqrt(Math.max(0, -2 * Math.log(resultant)));
    return Math.round((sd / (2 * Math.PI)) * 1440) || 0;
};

/**
 * Minutes in each stage over a window, and each stage's share of time asleep.
 *
 * `minutes` is null for a stage no night in the window reported — a watch that gives only a
 * total must not be drawn as somebody with no deep sleep. `share` is over the stages that
 * *were* reported, so the four percentages the donut prints add to 100 even when a source
 * reports three of them.
 */
const stageBreakdown = (nights = []) => {
    const totals = {};
    let reportedNights = 0;

    for (const stage of STAGES) totals[stage] = null;

    for (const night of nights) {
        let any = false;
        for (const stage of STAGES) {
            const value = night?.stages?.[STAGE_FIELD[stage]];
            if (!finite(value)) continue;
            totals[stage] = (totals[stage] || 0) + value;
            any = true;
        }
        if (any) reportedNights += 1;
    }

    const measured = STAGES.filter((s) => finite(totals[s]));
    const sum = measured.reduce((acc, s) => acc + totals[s], 0);

    return {
        nights: reportedNights,
        totalMin: measured.length ? Math.round(sum) : null,
        stages: STAGES.map((stage) => ({
            stage,
            minutes: finite(totals[stage]) ? Math.round(totals[stage]) : null,
            // Null rather than 0 when the window measured nothing: a ring at zero on a
            // stage nobody recorded says the person got none of it.
            share: finite(totals[stage]) && sum > 0 ? round((totals[stage] / sum) * 100, 1) : null,
        })),
    };
};

/**
 * The design's "Average Range" rows: the typical minutes in each stage per night, and the
 * spread the middle of the window actually fell in.
 *
 * The range is the 25th to 75th percentile rather than min-to-max, because one disturbed
 * night otherwise widens every row to the point of saying nothing.
 */
const stageRanges = (nights = []) => {
    const percentile = (sorted, p) => {
        if (!sorted.length) return null;
        const idx = (sorted.length - 1) * p;
        const lo = Math.floor(idx);
        const hi = Math.ceil(idx);
        return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo));
    };

    return STAGES.map((stage) => {
        const values = nights
            .map((n) => n?.stages?.[STAGE_FIELD[stage]])
            .filter(finite)
            .sort((a, b) => a - b);

        if (!values.length) {
            return { stage, nights: 0, avgMin: null, lowMin: null, highMin: null };
        }

        return {
            stage,
            nights: values.length,
            avgMin: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
            lowMin: percentile(values, 0.25),
            highMin: percentile(values, 0.75),
        };
    });
};

/**
 * The design's "Average Sleep Time" bar chart — one bar per weekday, and the mean across
 * them drawn as a dashed line.
 *
 * A weekday nobody slept through is absent from the bar rather than drawn at zero, which is
 * the line `nutritionInsight` holds about a day nobody logged on.
 */
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const byWeekday = (nights = []) => {
    const buckets = WEEKDAYS.map((label, index) => ({ index, label, nights: 0, totalMin: 0 }));

    for (const night of nights) {
        if (!finite(night?.asleepMin) || !night?.day) continue;
        // Parsed as a local date rather than an instant: `new Date('2026-09-06')` is
        // midnight UTC, which is the previous weekday for anyone west of Greenwich.
        const [y, m, d] = String(night.day).split('-').map(Number);
        if (!y || !m || !d) continue;
        const weekday = new Date(y, m - 1, d).getDay();
        buckets[weekday].nights += 1;
        buckets[weekday].totalMin += night.asleepMin;
    }

    const rows = buckets.map((b) => ({
        index: b.index,
        label: b.label,
        nights: b.nights,
        avgMin: b.nights ? Math.round(b.totalMin / b.nights) : null,
    }));

    const measured = rows.filter((r) => finite(r.avgMin));

    return {
        days: rows,
        avgMin: measured.length
            ? Math.round(measured.reduce((a, r) => a + r.avgMin, 0) / measured.length)
            : null,
        best: measured.length
            ? measured.slice().sort((a, b) => b.avgMin - a.avgMin)[0].label
            : null,
        worst: measured.length
            ? measured.slice().sort((a, b) => a.avgMin - b.avgMin)[0].label
            : null,
    };
};

/**
 * How steady the person's bedtime and wake time are.
 *
 * `spreadMin` is the circular standard deviation of each. The band is named rather than
 * scored, because this is a description of a pattern and not a mark out of ten — an
 * irregular schedule is a fact about somebody's week, often about their job, and grading it
 * is the app taking a view on shift work.
 */
const CONSISTENCY_BANDS = [
    { key: 'steady', label: 'Steady', maxSpread: 30 },
    { key: 'variable', label: 'Variable', maxSpread: 75 },
    { key: 'irregular', label: 'Irregular', maxSpread: Infinity },
];

const consistency = (nights = [], tzOffset = 0) => {
    const bedtimes = nights.map((n) => localMinutes(n?.startedAt, tzOffset));
    const wakes = nights.map((n) => localMinutes(n?.endedAt, tzOffset));

    const measured = bedtimes.filter(finite).length;
    if (measured < 2) {
        return { nights: measured, bedtime: null, wake: null, spreadMin: null, band: null };
    }

    const bedSpread = clockSpread(bedtimes);
    const wakeSpread = clockSpread(wakes);
    // The larger of the two: a person who wakes at 06:30 every day but goes to bed anywhere
    // between 22:00 and 01:00 does not have a steady schedule, and reporting the average of
    // the two spreads would say they half do.
    const spread = [bedSpread, wakeSpread].filter(finite).length
        ? Math.max(...[bedSpread, wakeSpread].filter(finite))
        : null;

    return {
        nights: measured,
        bedtimeMin: meanClock(bedtimes),
        wakeMin: meanClock(wakes),
        bedtimeSpreadMin: bedSpread,
        wakeSpreadMin: wakeSpread,
        spreadMin: spread,
        band: finite(spread)
            ? (({ key, label }) => ({ key, label }))(CONSISTENCY_BANDS.find((b) => spread <= b.maxSpread))
            : null,
    };
};

/**
 * This window against the one before it, for one figure.
 *
 * Null on either side gives a null comparison rather than a percentage — the same call
 * `activityInsight.comparePeriods` makes, and for the same reason: a first week has no
 * previous window and "+100%" is not a true thing to print about it.
 */
const comparePeriods = (current = [], previous = [], key = 'asleepMin') => {
    const mean = (rows) => {
        const values = rows.map((r) => r?.[key]).filter(finite);
        return values.length
            ? { value: round(values.reduce((a, b) => a + b, 0) / values.length, 1), nights: values.length }
            : null;
    };

    const now = mean(current);
    const before = mean(previous);
    if (!now || !before || before.value === 0) {
        return { current: now?.value ?? null, previous: before?.value ?? null, deltaPct: null, direction: null };
    }

    const deltaPct = round(((now.value - before.value) / before.value) * 100, 1);

    return {
        current: now.value,
        previous: before.value,
        currentNights: now.nights,
        previousNights: before.nights,
        deltaPct,
        direction: deltaPct === 0 ? 'flat' : (deltaPct > 0 ? 'up' : 'down'),
    };
};

/**
 * Consecutive nights ending today that carry sleep.
 *
 * Today not having a night yet does not break the streak — somebody opening the app at
 * lunchtime has not failed to sleep, they have simply not slept again. The same
 * allowance `activityController.computeStreak` makes, for the same reason.
 */
const computeStreak = (days = [], byDay = new Map()) => {
    let streak = 0;
    for (let i = days.length - 1; i >= 0; i -= 1) {
        const night = byDay.get(days[i]);
        if (night) { streak += 1; continue; }
        if (i === days.length - 1) continue;
        break;
    }
    return streak;
};

/**
 * How much of the goal a night met, 0–1, capped at 1.
 *
 * **Null when there is no goal**, never zero — nobody has failed at a target nobody set,
 * which is the call `alignment: 'unassessed'` and `medicationSchedule.adherence` both make.
 * Capped because a ring past full has nowhere to go and because the score already declines
 * to reward oversleeping.
 */
const goalProgress = (asleepMin, goalMinutes) => {
    if (!finite(asleepMin) || !finite(goalMinutes) || goalMinutes <= 0) return null;
    return round(Math.min(1, asleepMin / goalMinutes), 3);
};

module.exports = {
    stageBreakdown,
    stageRanges,
    byWeekday,
    consistency,
    comparePeriods,
    computeStreak,
    goalProgress,
    meanClock,
    clockSpread,
    localMinutes,
    STAGES,
    STAGE_FIELD,
    WEEKDAYS,
    CONSISTENCY_BANDS,
};
