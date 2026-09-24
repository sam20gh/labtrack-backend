/**
 * The Sleep Record screen's arithmetic — every night and nap in a window, stacked by stage
 * and bucketed for the chart, plus the cards drawn under it.
 *
 * Pure: no database, no clock it was not handed. The same deterministic series as
 * `sleepInsight.js`, and it inherits that module's four rules unchanged — null never zero,
 * averages divide by the nights that reported, a stage nobody measured is absent, and clock
 * times are circular.
 *
 * Three things this adds, each a way the naive version is wrong:
 *
 * 1. **A nap is a separate daytime sleep, not "any session that is not the longest".** The
 *    dashboard keeps one row per day and drops the rest, which is right for a figure per day
 *    and wrong for a record that promises to show naps. But "every other session" would also
 *    call the second half of a split night a nap. So a nap is a session of at most
 *    `NAP_MAX_MIN` that either *starts* inside `NAP_WINDOW` (local 09:00–20:00), or starts
 *    inside the wider `NAP_WINDOW_SEPARATED` (06:00–22:00) **and** is at least
 *    `NAP_GAP_MIN` clear of the night. The second rule is what files a 08:42 sleep after a
 *    night that ended at 06:58 as the nap it was — under the first rule alone it was
 *    silently discarded as a "fragment". A 05:30 fragment after a disturbed night is still
 *    not one, and neither is anything that touches the night; a day sleep after a night
 *    shift is longer than three hours and is not one either. It is still that person's main
 *    sleep.
 * 1b. **Naps count toward the day's total sleep.** `totalAsleepMin` is the night plus the
 *    day's naps, which is what every health store reports as "total sleep", and the goal is
 *    judged against it. The score is still the night's own — efficiency and stage balance
 *    are properties of a night, and a nap has neither.
 * 2. **The night is chosen exactly as the dashboard chooses it**, from what is left once the
 *    naps are set aside: the longest. The only day where the two screens can disagree is one
 *    whose only session was a 40-minute afternoon nap — the dashboard draws it as a very
 *    short night and this draws it as what it was.
 * 3. **The stacked bar sums to the time asleep.** A source that reports a total and no stages
 *    still measured a night, so the remainder is drawn as `unstagedMin` rather than being
 *    dropped — dropping it would draw a seven-hour night as a two-hour bar. Awake is drawn
 *    on top and is not part of the sum, because time awake in bed is not sleep.
 */
const { meanClock, clockSpread, localMinutes, stageBreakdown, comparePeriods } = require('./sleepInsight');

const finite = (v) => Number.isFinite(v);
const sum = (values) => values.reduce((a, b) => a + b, 0);
const mean = (values) => {
    const v = values.filter(finite);
    return v.length ? Math.round(sum(v) / v.length) : null;
};

/** Longest session a nap can be. Three hours covers a sick-day sleep; past that it is a sleep. */
const NAP_MAX_MIN = 180;
/** Local start times that make a short session a nap on their own: 09:00 to 20:00. */
const NAP_WINDOW = { fromMin: 9 * 60, toMin: 20 * 60 };
/**
 * Wider local window for a short session that is clearly apart from the night — a morning
 * nap two hours after waking, or an evening doze before bed. Before 06:00 is still the night.
 */
const NAP_WINDOW_SEPARATED = { fromMin: 6 * 60, toMin: 22 * 60 };
/** Awake time between a session and the night that makes it a separate sleep, not a fragment. */
const NAP_GAP_MIN = 60;

/** Calendar days each range spans. `all` is from the first recorded session. */
const RECORD_RANGES = { '1d': 1, '1w': 7, '1m': 30, '1y': 364, all: null };
/** How the chart groups the days. 364 bars on a phone is a smear; 52 is a year. */
const BUCKET_FOR = { '1d': 'day', '1w': 'day', '1m': 'day', '1y': 'week', all: 'month' };

const minutesBetween = (a, b) => Math.max(0, Math.round((new Date(b) - new Date(a)) / 60_000));

const asleepOf = (session) =>
    (finite(session.asleepMin) ? session.asleepMin : minutesBetween(session.startedAt, session.endedAt));

const inWindow = (session, window, tzOffset) => {
    const start = localMinutes(session.startedAt, tzOffset);
    return start !== null && start >= window.fromMin && start < window.toMin;
};

/** A short session that starts in the core daytime window — a nap whatever else happened. */
const isNap = (session, tzOffset = 0) =>
    asleepOf(session) <= NAP_MAX_MIN && inWindow(session, NAP_WINDOW, tzOffset);

/** Minutes of wakefulness between two sessions; 0 when they touch or overlap. */
const gapBetween = (a, b) => {
    const [first, second] = new Date(a.startedAt) <= new Date(b.startedAt) ? [a, b] : [b, a];
    return Math.max(0, Math.round((new Date(second.startedAt) - new Date(first.endedAt)) / 60_000));
};

/**
 * One day's sessions split into its night and its naps. Fragments that are neither — the
 * shorter half of a split night — are left out, which is what the dashboard does with them.
 *
 * Two passes: the core-window naps come out first, the night is the longest of what is
 * left, and only then can "clear of the night" be asked of the remainder.
 */
const classifyDay = (sessions = [], tzOffset = 0) => {
    const naps = [];
    const rest = [];
    for (const s of sessions) (isNap(s, tzOffset) ? naps : rest).push(s);
    const night = rest.slice().sort((a, b) => (b.asleepMin || 0) - (a.asleepMin || 0))[0] || null;
    if (night) {
        for (const s of rest) {
            if (s === night) continue;
            if (asleepOf(s) <= NAP_MAX_MIN
                && inWindow(s, NAP_WINDOW_SEPARATED, tzOffset)
                && gapBetween(s, night) >= NAP_GAP_MIN) naps.push(s);
        }
    }
    naps.sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
    return { night, naps };
};

/** Night plus naps, or null when the day has neither. */
const dayTotal = ({ night, naps = [] } = {}) => {
    const nightMin = night && finite(night.asleepMin) ? night.asleepMin : null;
    const napMin = naps.length ? sum(naps.map(asleepOf)) : 0;
    if (nightMin === null && !naps.length) return null;
    return { nightMin, napMin, totalMin: (nightMin || 0) + napMin };
};

/**
 * A night as stacked minutes. `unstagedMin` is whatever of the time asleep no stage accounts
 * for — all of it for a source that reports only a total.
 */
const stackNight = (night) => {
    if (!night || !finite(night.asleepMin)) return null;
    const st = night.stages || {};
    const deep = finite(st.deepMin) ? st.deepMin : null;
    const rem = finite(st.remMin) ? st.remMin : null;
    const light = finite(st.lightMin) ? st.lightMin : null;
    const staged = sum([deep, rem, light].filter(finite));
    return {
        asleepMin: night.asleepMin,
        deepMin: deep,
        remMin: rem,
        lightMin: light,
        unstagedMin: Math.max(0, night.asleepMin - staged),
        awakeMin: finite(st.awakeMin) ? st.awakeMin : null,
        staged: [deep, rem, light].some(finite),
    };
};

const napView = (nap, tzOffset) => ({
    id: String(nap._id),
    startMin: localMinutes(nap.startedAt, tzOffset),
    endMin: localMinutes(nap.endedAt, tzOffset),
    minutes: finite(nap.asleepMin) ? nap.asleepMin : minutesBetween(nap.startedAt, nap.endedAt),
});

/** Every session in the window, grouped by its (wake) day and split. */
const byDay = (sessions = [], tzOffset = 0) => {
    const grouped = new Map();
    for (const s of sessions) grouped.set(s.day, [...(grouped.get(s.day) || []), s]);
    const out = new Map();
    for (const [day, rows] of grouped) out.set(day, classifyDay(rows, tzOffset));
    return out;
};

/** The window's days grouped into the chart's bars. */
const chunkDays = (days, bucket) => {
    if (bucket === 'day') return days.map((d) => [d]);
    if (bucket === 'month') {
        const map = new Map();
        for (const d of days) map.set(d.slice(0, 7), [...(map.get(d.slice(0, 7)) || []), d]);
        return [...map.values()];
    }
    // Weeks counted back from the last day, so the newest bar is always a whole week ending
    // on the day the window ends, rather than a stub.
    const out = [];
    for (let i = days.length; i > 0; i -= 7) out.unshift(days.slice(Math.max(0, i - 7), i));
    return out;
};

/**
 * One bar. For a day, that night's figures; for a week or a month, the typical night in it —
 * every stage divided by the same count of nights, so the segments still sum to the average
 * time asleep. Naps are per day that had any sleep at all, which is the question somebody
 * reading "naps" on a monthly bar is asking.
 */
const bucketView = (days, split, tzOffset) => {
    const entries = days.map((d) => ({ day: d, ...(split.get(d) || { night: null, naps: [] }) }));
    const nights = entries.map((e) => stackNight(e.night)).filter(Boolean);
    const withSleep = entries.filter((e) => e.night || e.naps.length);
    const napMinutes = sum(entries.flatMap((e) => e.naps.map((n) => napView(n, tzOffset).minutes)));
    const napCount = sum(entries.map((e) => e.naps.length));
    const n = nights.length;

    const avgOf = (key) => (n ? Math.round(sum(nights.map((x) => x[key] || 0)) / n) : null);
    const avgReported = (key) => mean(nights.map((x) => x[key]));
    const nightRows = entries.map((e) => e.night).filter(Boolean);

    const view = {
        from: days[0],
        to: days[days.length - 1],
        dayCount: days.length,
        nights: n,
        asleepMin: avgOf('asleepMin'),
        deepMin: nights.some((x) => finite(x.deepMin)) ? avgOf('deepMin') : null,
        remMin: nights.some((x) => finite(x.remMin)) ? avgOf('remMin') : null,
        lightMin: nights.some((x) => finite(x.lightMin)) ? avgOf('lightMin') : null,
        unstagedMin: n ? avgOf('unstagedMin') : null,
        awakeMin: avgReported('awakeMin'),
        inBedMin: mean(nightRows.map((r) => r.inBedMin)),
        score: mean(nightRows.map((r) => r.score)),
        efficiency: mean(nightRows.map((r) => r.efficiency)),
        bedtimeMin: meanClock(nightRows.map((r) => localMinutes(r.startedAt, tzOffset))),
        wakeMin: meanClock(nightRows.map((r) => localMinutes(r.endedAt, tzOffset))),
        napMin: withSleep.length && napCount ? Math.round(napMinutes / withSleep.length) : (withSleep.length ? 0 : null),
        napCount,
        /** Night plus naps, per day that had any sleep — "total sleep" in every health store. */
        totalAsleepMin: mean(withSleep.map((e) => dayTotal(e)?.totalMin)),
    };

    // Only a single day can point at one night and list its naps; a week cannot.
    if (days.length === 1) {
        const e = entries[0];
        view.nightId = e.night ? String(e.night._id) : null;
        view.naps = e.naps.map((nap) => napView(nap, tzOffset));
    }
    return view;
};

const highlight = (rows, pick, compare) => {
    const candidates = rows.filter((r) => finite(pick(r)));
    if (!candidates.length) return null;
    const best = candidates.slice().sort((a, b) => compare(pick(a), pick(b)))[0];
    return { id: String(best._id), day: best.day, value: pick(best) };
};

/**
 * The whole screen's payload, from the window's sessions and the previous window's.
 *
 * `previous` is only used for the two comparisons; it is not bucketed or drawn.
 */
const buildRecord = ({
    sessions = [], previous = null, days = [], range = '1w', goalMinutes = null, tzOffset = 0,
}) => {
    const bucket = BUCKET_FOR[range] || 'day';
    const split = byDay(sessions, tzOffset);
    const series = chunkDays(days, bucket).map((chunk) => bucketView(chunk, split, tzOffset));

    const nights = days.map((d) => split.get(d)?.night).filter(Boolean);
    const naps = days.flatMap((d) => (split.get(d)?.naps || []).map((nap) => ({ day: d, ...napView(nap, tzOffset) })));
    const stacked = nights.map(stackNight).filter(Boolean);

    const asleep = nights.map((n) => n.asleepMin).filter(finite);
    const breakdown = stageBreakdown(nights);

    const stageAvg = (field) => mean(stacked.map((s) => s[field]));

    let comparison = null;
    if (previous) {
        const prevNights = [...byDay(previous, tzOffset).values()].map((x) => x.night).filter(Boolean);
        comparison = {
            asleepMin: comparePeriods(nights, prevNights, 'asleepMin'),
            score: comparePeriods(nights, prevNights, 'score'),
        };
    }

    // The goal is judged on the day's total, naps included: a 5h 53m night and a 1h 57m nap
    // is 7h 50m of sleep, which is what the person's other health apps will tell them too.
    const totals = days.map((d) => dayTotal(split.get(d))).filter(Boolean);
    const measuredGoal = finite(goalMinutes) && goalMinutes > 0 ? totals.map((t) => t.totalMin) : [];

    return {
        range,
        bucket,
        days,
        series,
        summary: {
            nights: nights.length,
            dayCount: days.length,
            totalAsleepMin: asleep.length ? sum(asleep) : null,
            /** Night plus naps. `avgMin` is per day that had any sleep; null with none. */
            totalSleep: {
                avgMin: mean(totals.map((t) => t.totalMin)),
                totalMin: totals.length ? sum(totals.map((t) => t.totalMin)) : null,
                days: totals.length,
            },
            avgAsleepMin: mean(asleep),
            avgInBedMin: mean(nights.map((n) => n.inBedMin)),
            avgEfficiency: mean(nights.map((n) => n.efficiency)),
            avgScore: mean(nights.map((n) => n.score)),
            stages: {
                deep: { avgMin: stageAvg('deepMin'), share: shareOf(breakdown, 'deep') },
                rem: { avgMin: stageAvg('remMin'), share: shareOf(breakdown, 'rem') },
                light: { avgMin: stageAvg('lightMin'), share: shareOf(breakdown, 'light') },
                awake: { avgMin: stageAvg('awakeMin'), share: shareOf(breakdown, 'awake') },
            },
            stagedNights: stacked.filter((s) => s.staged).length,
            bedtime: {
                avgMin: meanClock(nights.map((n) => localMinutes(n.startedAt, tzOffset))),
                spreadMin: clockSpread(nights.map((n) => localMinutes(n.startedAt, tzOffset))),
            },
            wake: {
                avgMin: meanClock(nights.map((n) => localMinutes(n.endedAt, tzOffset))),
                spreadMin: clockSpread(nights.map((n) => localMinutes(n.endedAt, tzOffset))),
            },
            /** Null with no goal — nobody has missed a target nobody set. */
            goal: finite(goalMinutes) && goalMinutes > 0
                ? {
                    minutes: goalMinutes,
                    met: measuredGoal.filter((m) => m >= goalMinutes).length,
                    nights: measuredGoal.length,
                    includesNaps: true,
                }
                : null,
            naps: {
                count: naps.length,
                totalMin: naps.length ? sum(naps.map((n) => n.minutes)) : null,
                avgMin: mean(naps.map((n) => n.minutes)),
                days: new Set(naps.map((n) => n.day)).size,
            },
            highlights: {
                longest: highlight(nights, (n) => n.asleepMin, (a, b) => b - a),
                shortest: highlight(nights, (n) => n.asleepMin, (a, b) => a - b),
                bestScore: highlight(nights, (n) => n.score, (a, b) => b - a),
                mostDeep: highlight(nights, (n) => n.stages?.deepMin, (a, b) => b - a),
            },
            comparison,
        },
        naps: naps.reverse(),
    };
};

/**
 * A stage's share of the reported stage minutes, as a percentage — `stageBreakdown`'s own
 * figure, so it matches the donut on Sleep Insight to the decimal. Null when unmeasured.
 */
function shareOf(breakdown, stage) {
    const row = (breakdown?.stages || []).find((s) => s.stage === stage);
    return row && finite(row.share) ? row.share : null;
}

module.exports = {
    buildRecord,
    classifyDay,
    dayTotal,
    stackNight,
    isNap,
    gapBetween,
    chunkDays,
    NAP_MAX_MIN,
    NAP_WINDOW,
    NAP_WINDOW_SEPARATED,
    NAP_GAP_MIN,
    RECORD_RANGES,
    BUCKET_FOR,
};
