/**
 * How one sleep went, and what would improve the next one.
 *
 * Deterministic, like `sleepScore.js` beside it: every finding is a rule over numbers the
 * screen already shows, so a sentence under a night can always be traced back to a figure on
 * the same screen. A model asked "how was this night?" answers fluently and differently each
 * time, and cannot be pinned in a test to never call a short night a disorder.
 *
 * Four rules the copy keeps:
 *
 * 1. **It describes the record, never the person.** "You slept 5h 53m" and "you woke four
 *    times", never "you have poor sleep" — the line `sleepScore.js` holds by refusing the
 *    kit's "Insomniac" band. No finding names a condition.
 * 2. **Naps count toward the day, and the night is still judged as a night.** A short night
 *    made up by a nap is a real, different day from a short night alone, and the headline
 *    says which one it was. The recommendation still points at the night, because a longer
 *    nap is the weaker repair.
 * 3. **Stage findings are hedged.** Wrist stage detection is an estimate; a finding about deep
 *    or REM sleep says "less than typical", never a deficit.
 * 4. **Null, never zero.** A number the source did not report produces no finding at all —
 *    efficiency with no awake time, stages from a total-only watch.
 */
const { meanClock, localMinutes } = require('./sleepInsight');
const { DEFAULT_GOAL_MINUTES } = require('./sleepScore');

const finite = (v) => Number.isFinite(v);

const fmtMinutes = (m) => {
    if (!finite(m)) return '—';
    const h = Math.floor(m / 60);
    const mm = Math.round(m % 60);
    if (!h) return `${mm}m`;
    return mm ? `${h}h ${mm}m` : `${h}h`;
};

const fmtClock = (minutes) => {
    if (!finite(minutes)) return '—';
    const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
    const h24 = Math.floor(m / 60);
    const h12 = h24 % 12 || 12;
    return `${h12}:${String(m % 60).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'}`;
};

/** Shortest signed distance between two clock times, in minutes (−720..720]. */
const clockDiff = (a, b) => {
    let d = (a - b) % 1440;
    if (d > 720) d -= 1440;
    if (d <= -720) d += 1440;
    return d;
};

/** Thresholds, in one place so a test can name them. */
const T = {
    enough: 0.95,          // of goal — the same point `durationScore` gives full marks
    nearly: 0.85,
    efficiencyGood: 90,
    efficiencyFloor: 85,
    wakeupMin: 5,          // an awake segment shorter than this is a stir, not a waking
    manyWakeups: 4,
    deepLow: 0.13,
    remLow: 0.20,
    lateBedFrom: 30,       // 00:30
    lateBedTo: 5 * 60,     // 05:00
    driftMin: 60,
    shortNightMin: 6 * 60,
    patternNights: 5,      // of the recent fortnight
    powerNapMax: 30,
    longNapMin: 90,
    lateNapFrom: 15 * 60,
    fallAsleepMin: 15,
};

const wakeups = (segments = []) =>
    segments.filter((s) => s.stage === 'awake'
        && (new Date(s.endedAt) - new Date(s.startedAt)) / 60_000 >= T.wakeupMin).length;

const pushOnce = (list, item) => {
    if (!list.some((x) => x.key === item.key)) list.push(item);
};

/* ----------------------------------------------------------------- night */

function analyseNight({ session, goal, day, recentNights, tzOffset, guidance }) {
    const findings = [];
    const recs = [];

    const asleep = session.asleepMin;
    const total = day?.totalMin ?? asleep;
    const napMin = day?.napMin || 0;
    const bedtime = localMinutes(session.startedAt, tzOffset);
    const wake = localMinutes(session.endedAt, tzOffset);
    const nightRatio = asleep / goal;
    const totalRatio = total / goal;

    /* -------- duration */
    let headline;
    let tone;
    if (nightRatio >= T.enough) {
        headline = 'A full night of sleep';
        tone = 'positive';
        findings.push({
            key: 'duration', tone: 'positive', title: 'Enough sleep',
            detail: `You slept ${fmtMinutes(asleep)}, against a goal of ${fmtMinutes(goal)}.`,
        });
    } else if (napMin && totalRatio >= T.enough) {
        headline = 'A short night, made up by a nap';
        tone = 'mixed';
        findings.push({
            key: 'duration', tone: 'neutral', title: 'Short night, made up during the day',
            detail: `The night itself was ${fmtMinutes(asleep)}. With ${fmtMinutes(napMin)} of napping `
                + `the day reached ${fmtMinutes(total)}, which meets your ${fmtMinutes(goal)} goal.`,
        });
    } else {
        const shortBy = goal - total;
        const nearly = totalRatio >= T.nearly;
        headline = nearly ? 'A little short of your goal' : 'Short on sleep';
        tone = nearly ? 'mixed' : 'attention';
        findings.push({
            key: 'duration', tone: nearly ? 'neutral' : 'attention',
            title: nearly ? 'Slightly short' : 'Well short of your goal',
            detail: napMin
                ? `${fmtMinutes(asleep)} at night plus ${fmtMinutes(napMin)} of naps is ${fmtMinutes(total)} — `
                    + `${fmtMinutes(shortBy)} under your ${fmtMinutes(goal)} goal.`
                : `You slept ${fmtMinutes(asleep)} — ${fmtMinutes(shortBy)} under your ${fmtMinutes(goal)} goal.`,
        });
    }

    if (nightRatio < T.enough && finite(wake)) {
        const target = wake - goal - T.fallAsleepMin;
        pushOnce(recs, {
            key: 'earlier_bedtime',
            title: `Aim to be in bed by ${fmtClock(target)}`,
            detail: `That gives ${fmtMinutes(goal)} of sleep and still wakes you at ${fmtClock(wake)}. `
                + 'Move bedtime 15–30 minutes earlier every few nights rather than all at once — '
                + 'a sudden early night usually means lying awake.',
        });
    }

    /* -------- continuity */
    const wakes = wakeups(session.segments);
    if (finite(session.efficiency)) {
        if (session.efficiency >= T.efficiencyGood && wakes < T.manyWakeups) {
            findings.push({
                key: 'efficiency', tone: 'positive', title: 'Settled sleep',
                detail: `${session.efficiency}% of your time in bed was spent asleep.`,
            });
        } else if (session.efficiency < T.efficiencyFloor || wakes >= T.manyWakeups) {
            const awake = session.stages?.awakeMin;
            findings.push({
                key: 'efficiency', tone: 'attention', title: 'Broken sleep',
                detail: [
                    `${session.efficiency}% of your time in bed was spent asleep`,
                    finite(awake) && awake > 0 ? `with ${fmtMinutes(awake)} awake` : null,
                    wakes ? `across ${wakes} ${wakes === 1 ? 'waking' : 'wakings'}` : null,
                ].filter(Boolean).join(', ') + '.',
            });
            pushOnce(recs, {
                key: 'awake_in_bed',
                title: 'Don\'t lie awake for long',
                detail: 'If you are awake for more than about 20 minutes, get up and do something calm '
                    + 'in dim light until you feel sleepy. Keep the room cool, dark and quiet.',
            });
        }
    } else if (wakes >= T.manyWakeups) {
        findings.push({
            key: 'efficiency', tone: 'attention', title: 'Broken sleep',
            detail: `Your device recorded ${wakes} wakings during the night.`,
        });
    }

    /* -------- stages, hedged */
    const deep = session.stages?.deepMin;
    const rem = session.stages?.remMin;
    if (finite(deep) && finite(rem) && asleep > 0) {
        const deepShare = deep / asleep;
        const remShare = rem / asleep;
        if (deepShare < T.deepLow) {
            findings.push({
                key: 'deep', tone: 'neutral', title: 'Less deep sleep than typical',
                detail: `${fmtMinutes(deep)} of deep sleep, about ${Math.round(deepShare * 100)}% of the night. `
                    + 'Adults typically spend 13–23% there. Wrist stage estimates are approximate.',
            });
            pushOnce(recs, {
                key: 'deep_support',
                title: 'Help your deep sleep',
                detail: 'Exercise earlier in the day, and skip alcohol in the three hours before bed — '
                    + 'it makes you drowsy but breaks up the deeper stages later on.',
            });
        }
        if (remShare < T.remLow) {
            const cut = nightRatio < T.nearly;
            findings.push({
                key: 'rem', tone: 'neutral', title: 'Less REM sleep than typical',
                detail: `${fmtMinutes(rem)} of REM, about ${Math.round(remShare * 100)}% of the night. `
                    + (cut
                        ? 'Most REM comes in the last hours of the night, so a short night loses it first.'
                        : 'Adults typically spend 20–25% there. Wrist stage estimates are approximate.'),
            });
            if (!cut) {
                pushOnce(recs, {
                    key: 'rem_support',
                    title: 'Protect the end of the night',
                    detail: 'Late caffeine and alcohol both suppress REM. Try no caffeine after 2pm.',
                });
            }
        }
        if (deepShare >= T.deepLow && remShare >= T.remLow) {
            findings.push({
                key: 'stages', tone: 'positive', title: 'Balanced stages',
                detail: `${fmtMinutes(deep)} deep and ${fmtMinutes(rem)} REM — both in the typical range.`,
            });
        }
    }

    /* -------- timing */
    if (finite(bedtime) && bedtime >= T.lateBedFrom && bedtime < T.lateBedTo) {
        findings.push({
            key: 'late', tone: 'neutral', title: 'Late bedtime',
            detail: `You fell asleep at ${fmtClock(bedtime)}.`,
        });
        pushOnce(recs, {
            key: 'wind_down',
            title: 'Start winding down an hour earlier',
            detail: 'Dim the lights and put screens away an hour before you want to sleep; '
                + 'bright light late in the evening pushes your body clock later.',
        });
    }

    const recentBeds = (recentNights || []).map((n) => localMinutes(n.startedAt, tzOffset)).filter(finite);
    if (finite(bedtime) && recentBeds.length >= 3) {
        const usual = meanClock(recentBeds);
        const drift = clockDiff(bedtime, usual);
        if (Math.abs(drift) >= T.driftMin) {
            findings.push({
                key: 'consistency', tone: 'attention',
                title: drift > 0 ? 'Later than usual' : 'Earlier than usual',
                detail: `You fell asleep ${fmtMinutes(Math.abs(drift))} ${drift > 0 ? 'later' : 'earlier'} `
                    + `than your usual ${fmtClock(usual)}.`,
            });
            pushOnce(recs, {
                key: 'consistency',
                title: 'Keep a steady schedule',
                detail: 'Going to bed and waking within about 30 minutes of the same time every day, '
                    + 'weekends included, is one of the most reliable ways to sleep better.',
            });
        }
    }

    /* -------- naps that day */
    if (napMin > T.longNapMin) {
        pushOnce(recs, {
            key: 'nap_length',
            title: 'Keep daytime naps shorter',
            detail: `You napped ${fmtMinutes(napMin)} that day. Naps over 90 minutes can make it harder to `
                + 'fall asleep the following night — 20–30 minutes refreshes without that cost.',
        });
    }

    /* -------- the fortnight */
    const recentShort = (recentNights || []).filter((n) => finite(n.asleepMin) && n.asleepMin < T.shortNightMin).length
        + (asleep < T.shortNightMin ? 1 : 0);
    if (recentShort >= T.patternNights) {
        pushOnce(recs, {
            key: 'pattern',
            title: 'Short nights have become a pattern',
            detail: `${recentShort} of your recent nights were under ${fmtMinutes(T.shortNightMin)}. `
                + 'If that keeps happening despite trying, it is worth talking to a professional.',
            route: '/(tabs)/professionals',
        });
    }

    addPlanGuidance(recs, guidance);

    return { headline, tone, findings, recommendations: recs };
}

/* ------------------------------------------------------------------- nap */

function analyseNap({ session, goal, day, night, tzOffset }) {
    const findings = [];
    const recs = [];
    const minutes = finite(session.asleepMin)
        ? session.asleepMin
        : Math.round((new Date(session.endedAt) - new Date(session.startedAt)) / 60_000);
    const start = localMinutes(session.startedAt, tzOffset);

    let headline;
    let tone;
    if (minutes <= T.powerNapMax) {
        headline = 'A short, refreshing nap';
        tone = 'positive';
        findings.push({
            key: 'nap_length', tone: 'positive', title: 'Power nap',
            detail: `${fmtMinutes(minutes)} — short enough to refresh without waking groggy.`,
        });
    } else if (minutes <= T.longNapMin) {
        headline = 'A medium-length nap';
        tone = 'mixed';
        findings.push({
            key: 'nap_length', tone: 'neutral', title: 'Medium nap',
            detail: `${fmtMinutes(minutes)}. Waking partway through a sleep cycle can leave you groggy for a while.`,
        });
        pushOnce(recs, {
            key: 'nap_length',
            title: 'Pick 20–30 minutes, or a full 90',
            detail: 'Either stays out of deep sleep or completes a whole cycle, which makes waking easier.',
        });
    } else {
        headline = 'A long nap';
        tone = 'attention';
        findings.push({
            key: 'nap_length', tone: 'attention', title: 'Long nap',
            detail: `${fmtMinutes(minutes)}. Naps this long can make it harder to fall asleep that night.`,
        });
        pushOnce(recs, {
            key: 'nap_length',
            title: 'Keep naps under 30 minutes',
            detail: 'Set an alarm when you lie down. A short nap refreshes without borrowing from tonight.',
        });
    }

    if (finite(start) && start >= T.lateNapFrom) {
        findings.push({
            key: 'nap_time', tone: 'neutral', title: 'Late in the day',
            detail: `It started at ${fmtClock(start)}.`,
        });
        pushOnce(recs, {
            key: 'nap_time',
            title: 'Nap before 3pm',
            detail: 'The later a nap, the more it eats into how sleepy you are at bedtime.',
        });
    }

    if (night && finite(night.asleepMin) && night.asleepMin < goal * T.nearly) {
        findings.push({
            key: 'recovery', tone: 'neutral', title: 'Catching up',
            detail: `It followed a ${fmtMinutes(night.asleepMin)} night`
                + (day ? `, bringing the day to ${fmtMinutes(day.totalMin)} of sleep.` : '.'),
        });
        pushOnce(recs, {
            key: 'earlier_bedtime',
            title: 'An earlier night is the better repair',
            detail: 'A nap helps today, but going to bed earlier tonight makes up lost sleep '
                + 'without the grogginess or the harder time falling asleep.',
        });
    } else if (day && finite(day.totalMin)) {
        findings.push({
            key: 'day_total', tone: day.totalMin >= goal * T.enough ? 'positive' : 'neutral',
            title: 'Counted toward the day',
            detail: `With this nap the day totals ${fmtMinutes(day.totalMin)} of sleep, against a goal of ${fmtMinutes(goal)}.`,
        });
    }

    return { headline, tone, findings, recommendations: recs };
}

/** One recommendation from the health plan, worded exactly as the plan wrote it. */
function addPlanGuidance(recs, guidance = []) {
    const item = (guidance || []).find((g) => g && g.directive);
    if (!item) return;
    pushOnce(recs, {
        key: 'plan',
        title: 'From your health plan',
        detail: item.directive,
        source: 'plan',
    });
}

const MAX_RECOMMENDATIONS = 4;
/**
 * Which advice survives the cap. A pattern worth talking to somebody about outranks a tip,
 * the fix for the biggest shortfall outranks refinements, and the plan's own words are kept
 * ahead of generic advice.
 */
const PRIORITY = [
    'pattern', 'earlier_bedtime', 'plan', 'awake_in_bed', 'consistency', 'nap_length',
    'nap_time', 'wind_down', 'deep_support', 'rem_support',
];
const rank = (key) => {
    const i = PRIORITY.indexOf(key);
    return i === -1 ? PRIORITY.length : i;
};
const BASIS = 'Based on what your device recorded. This is guidance about habits, not a medical assessment.';

/**
 * @param {object} input
 * @param {object} input.session        the SleepSession, with `segments` when available
 * @param {'night'|'nap'} input.kind
 * @param {number} [input.goalMinutes]
 * @param {{nightMin, napMin, totalMin}} [input.day]   `sleepRecord.dayTotal` for its day
 * @param {object} [input.night]        for a nap, that day's night
 * @param {object[]} [input.recentNights]  main nights before this one, for consistency
 * @param {number} [input.tzOffset]
 * @param {object[]} [input.guidance]   `SleepPlan.guidance`
 */
function analyse({
    session, kind = 'night', goalMinutes, day = null, night = null,
    recentNights = [], tzOffset = 0, guidance = [],
}) {
    if (!session || (!finite(session.asleepMin) && !session.endedAt)) return null;
    const goal = finite(goalMinutes) && goalMinutes > 0 ? goalMinutes : DEFAULT_GOAL_MINUTES;
    const out = kind === 'nap'
        ? analyseNap({ session, goal, day, night, tzOffset })
        : finite(session.asleepMin)
            ? analyseNight({ session, goal, day, recentNights, tzOffset, guidance })
            : null;
    if (!out) return null;
    return {
        kind,
        ...out,
        recommendations: out.recommendations
            .slice()
            .sort((a, b) => rank(a.key) - rank(b.key))
            .slice(0, MAX_RECOMMENDATIONS),
        basis: BASIS,
    };
}

module.exports = { analyse, clockDiff, fmtMinutes, fmtClock, THRESHOLDS: T, BASIS };
