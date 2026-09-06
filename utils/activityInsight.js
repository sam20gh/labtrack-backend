/**
 * The three derived readings on the activity dashboard that are not a day's rollup —
 * `Design/activity.svg` frame 18: **Activity Breakdown**, **Most active time**, and the
 * period-over-period comparison under **Monthly Average**.
 *
 * A deterministic module, in the series with `medicationCatalogue.js`, `bloodPressure.js`,
 * `nutritionSafety.js`, `reviewSla.js` and `predictionForecast.js`, and for the same reason
 * every one of those gives: these are figures a person is shown next to their own records,
 * so they have to be reproducible from those records and pinnable in a test. The engine that
 * writes prose about them is downstream of this and cannot change a number here.
 *
 * Three rules hold across all of it, all inherited from the trackers this sits beside:
 *
 * 1. **Null, never zero.** A period nothing was reported in scores `null`. A comparison
 *    against a period with no data is `null` rather than "+100%", which would tell somebody
 *    they doubled their output because the app had not been installed yet.
 * 2. **Averages divide by the days that reported**, never by the length of the window — the
 *    line `utils/nutritionInsight.js` holds. A fortnight's honest gap is not a fortnight of
 *    inactivity.
 * 3. **An hour bucket is a local hour.** Sessions carry `startedAt` in UTC and a local `day`;
 *    bucketing the instant would file a 7am run in the Americas under midday, on the one card
 *    whose whole content is what time of day somebody trains.
 */

/** The design's "Most active time" window: two hours, which is what the copy names. */
const PEAK_WINDOW_HOURS = 2;

/** Beyond this the breakdown collapses into one "Other" row, as frame 18 draws it. */
const MAX_BREAKDOWN_ROWS = 5;

const finite = (v) => Number.isFinite(v);
const round = (v, dp = 0) => {
    const f = 10 ** dp;
    return Math.round(v * f) / f;
};

/**
 * Which activity types the person actually did, and how much of each.
 *
 * Counted by session rather than by minutes because that is what the design's "31x" is, and
 * because minutes flatter whichever type happens to be endurance — twelve yoga sessions and
 * two long rides are not "mostly cycling".
 *
 * Minutes and calories travel alongside so the card can say more than a tally, and each is
 * null when nothing in that group reported it: a walk logged by hand has no calorie estimate
 * and summing it as zero would report a lower burn for having logged more.
 */
const breakdownByType = (sessions = []) => {
    const groups = new Map();

    for (const s of sessions) {
        const type = s?.type || 'other';
        const g = groups.get(type) || { type, count: 0, minutes: 0, kcal: null, distanceM: null };
        g.count += 1;
        g.minutes += finite(s?.durationSec) ? s.durationSec / 60 : 0;
        if (finite(s?.activeKcal)) g.kcal = (g.kcal || 0) + s.activeKcal;
        if (finite(s?.distanceM)) g.distanceM = (g.distanceM || 0) + s.distanceM;
        groups.set(type, g);
    }

    const rows = [...groups.values()]
        .map((g) => ({
            ...g,
            minutes: round(g.minutes),
            kcal: g.kcal === null ? null : Math.round(g.kcal),
            distanceM: g.distanceM === null ? null : Math.round(g.distanceM),
        }))
        // Ties broken by minutes so the order is stable between two reads of the same data.
        .sort((a, b) => b.count - a.count || b.minutes - a.minutes || a.type.localeCompare(b.type));

    if (rows.length <= MAX_BREAKDOWN_ROWS) return rows;

    const kept = rows.slice(0, MAX_BREAKDOWN_ROWS - 1);
    const rest = rows.slice(MAX_BREAKDOWN_ROWS - 1);

    // Folded rather than dropped: a person with nine kinds of workout must not be shown a
    // total that silently excludes four of them.
    const other = rest.reduce((acc, r) => ({
        type: 'other',
        count: acc.count + r.count,
        minutes: round(acc.minutes + r.minutes),
        kcal: r.kcal === null ? acc.kcal : (acc.kcal || 0) + r.kcal,
        distanceM: r.distanceM === null ? acc.distanceM : (acc.distanceM || 0) + r.distanceM,
        folded: acc.folded + 1,
    }), { type: 'other', count: 0, minutes: 0, kcal: null, distanceM: null, folded: 0 });

    return [...kept, other];
};

/**
 * The local hour a session started in.
 *
 * `tzOffset` is `Date.getTimezoneOffset()` — minutes **west** of UTC, so it is subtracted.
 */
const localHour = (startedAt, tzOffset = 0) => {
    const t = new Date(startedAt);
    if (Number.isNaN(t.getTime())) return null;
    return new Date(t.getTime() - tzOffset * 60_000).getUTCHours();
};

/**
 * A 24-slot histogram of training minutes, and the two-hour window that holds the most.
 *
 * A session is credited to the hour it **started** rather than spread across the hours it
 * spans. Spreading is more accurate about where the minutes were and less useful: the card
 * answers "when do you train", and a 90-minute ride starting at 6am is a 6am ride, not a
 * third of a 7am one.
 *
 * `peak` is null below `minSessions` — two runs do not establish a routine, and a card that
 * names an hour from a single session is a card that changes its advice every week.
 */
const activeHours = (sessions = [], tzOffset = 0, { minSessions = 3 } = {}) => {
    const hours = Array.from({ length: 24 }, () => 0);
    let counted = 0;

    for (const s of sessions) {
        const hour = localHour(s?.startedAt, tzOffset);
        if (hour === null) continue;
        hours[hour] += finite(s?.durationSec) ? s.durationSec / 60 : 0;
        counted += 1;
    }

    const rounded = hours.map((m) => round(m));
    const total = rounded.reduce((a, b) => a + b, 0);

    if (counted < minSessions || total <= 0) {
        return { hours: rounded, sessions: counted, peak: null };
    }

    let best = { from: 0, minutes: -1 };
    for (let start = 0; start < 24; start += 1) {
        let minutes = 0;
        for (let k = 0; k < PEAK_WINDOW_HOURS; k += 1) minutes += rounded[(start + k) % 24];
        if (minutes > best.minutes) best = { from: start, minutes: round(minutes) };
    }

    return {
        hours: rounded,
        sessions: counted,
        peak: {
            from: best.from,
            to: (best.from + PEAK_WINDOW_HOURS) % 24,
            minutes: best.minutes,
            /** That window's share of everything trained, 0–1. */
            share: round(best.minutes / total, 2),
        },
    };
};

/**
 * This window against the one immediately before it, for one metric.
 *
 * Both sides average over the days that reported, so a fortnight away is not counted as a
 * fortnight of zeros on either side. `deltaPct` is null when the previous window reported
 * nothing — a percentage change from no data is not a large improvement, it is unknown, and
 * the design's "12.8% vs last month" has to mean something or it should not be drawn.
 */
const comparePeriods = (current = [], previous = [], key = 'activeKcal') => {
    const mean = (rows) => {
        const values = rows.map((r) => r?.[key]).filter(finite);
        if (!values.length) return null;
        return {
            value: round(values.reduce((a, b) => a + b, 0) / values.length, 1),
            days: values.length,
        };
    };

    const now = mean(current);
    const before = mean(previous);

    if (!now) return { metric: key, current: null, previous: before, delta: null, deltaPct: null };
    if (!before || before.value === 0) {
        return { metric: key, current: now, previous: before, delta: null, deltaPct: null };
    }

    const delta = round(now.value - before.value, 1);
    return {
        metric: key,
        current: now,
        previous: before,
        delta,
        deltaPct: round((delta / before.value) * 100, 1),
    };
};

module.exports = {
    breakdownByType,
    activeHours,
    comparePeriods,
    localHour,
    PEAK_WINDOW_HOURS,
    MAX_BREAKDOWN_ROWS,
};
