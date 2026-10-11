/**
 * The daily readout — Sleep, Recovery, Effort — on the home screen.
 *
 * The fourteenth deterministic table, in the series with `medicationCatalogue.js`,
 * `bloodPressure.js`, `sleepScore.js`, `stressLevel.js` and the rest, for the same reason as
 * every one of them: a number somebody reads every morning has to be reproducible, testable,
 * and explainable from the arithmetic that produced it. Pure: no database, no clock it was not
 * handed. `readoutController` reads the rows; this decides what they mean.
 *
 * The three answer one question each, in the order they happen:
 *
 *   Sleep     how did I sleep?           last night's `sleepScore`, unchanged
 *   Recovery  how ready am I today?      HRV, resting heart rate and sleep against my own usual
 *   Effort    what have I done?          guideline minutes from `utils/effort.js`
 *
 * …and they feed each other: Recovery decides how much of the week's Effort to ask for today.
 *
 * Four rules, each a way the naive version goes wrong:
 *
 * 1. **Recovery is judged against the person's own usual, never a population figure.** The
 *    median of the 28 days before today — the window the HRV and stress cards already use —
 *    and nothing is claimed until five earlier days exist. Healthy HRV differs several-fold
 *    between people, and sources report different measures of it.
 * 2. **Null, never zero.** No signal is no score. A missing signal drops out and the weights
 *    renormalise, the way `sleepScore` handles a watch that reports no stages. Fewer than two
 *    signals is no score at all: one number is not a readout of anything.
 * 3. **States are words, not colours.** The client draws one hue and a glyph per state. A
 *    traffic light would put `danger` on a feeling, which this app reserves for a result.
 * 4. **An urgent vital alert holds the readout.** A score can read "Recharged" on the morning
 *    a crisis blood-pressure reading is waiting to be seen; the alert wins the sentence.
 *
 * Stress is deliberately not an input: it is the bracelet's HRV said again, and including it
 * would count HRV twice (`metricsController.stressCard` makes the same call for the score).
 * Blood oxygen is not one either: vital alerts already own it, with thresholds.
 */

const BASELINE_DAYS = 28;
const MIN_DAYS = 5;

/** Starting weights. HRV leads, as every published readiness model does. */
const WEIGHTS = { hrv: 0.45, resting: 0.30, sleep: 0.25 };

/**
 * How far from usual counts as "near". HRV's is the band its metrics card already uses.
 * Resting heart rate moves far less day to day — 15% of 58 bpm would call a 66 "usual".
 */
const NEAR = { hrv: 0.15, resting: 0.075 };

/** Points at exactly usual, and per band-width away from it. A normal day reads Steady. */
const AT_USUAL = 65;
const PER_BAND = 20;

/** Night temperature only ever lowers the score: a warm night is a signal, a cool one is not. */
const TEMP_NEAR_C = 0.3;
const TEMP_PENALTY_MAX = 15;
const TEMP_PENALTY_PER_C = TEMP_PENALTY_MAX / 0.5;

const STATES = [
    { key: 'recharged', min: 70, label: 'Recharged' },
    { key: 'steady', min: 40, label: 'Steady' },
    { key: 'low', min: 0, label: 'Take it easier' },
];

/** WHO: 150 moderate minutes a week. A vigorous minute counts double in `effort.js`. */
const WEEKLY_EFFORT_TARGET = 150;
const DAILY_TARGET_MIN = 10;
const DAILY_TARGET_MAX = 60;
/** How much of the week's remaining effort to ask for today, by recovery state. */
const EFFORT_SHARE = { recharged: 1.5, steady: 1, low: 0.5 };

const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

const median = (values) => {
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Days between two `YYYY-MM-DD` strings. */
const daysBetween = (from, to) =>
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

/** The Monday on or before a day. */
const weekStartOf = (day) => {
    const date = new Date(`${day}T00:00:00Z`);
    const back = (date.getUTCDay() + 6) % 7;
    return new Date(date.getTime() - back * 86400000).toISOString().slice(0, 10);
};

/** The person's usual for one figure: the median of the 28 days before today. */
const usualOf = (rows, today, pick) => {
    const history = rows
        .filter((r) => r.day < today && daysBetween(r.day, today) <= BASELINE_DAYS)
        .map(pick)
        .filter((v) => finite(v) && v > 0);
    return { usual: history.length >= MIN_DAYS ? median(history) : null, count: history.length };
};

const PICK = {
    hrv: (r) => r?.heart?.hrvMs,
    resting: (r) => r?.heart?.restingBpm,
    sleep: (r) => r?.sleep?.score,
    // One sensor at a time: the bracelet's own median when it has one, else the health store's.
    temperature: (r) => r?.temperature?.wristSleepMedian ?? r?.temperature?.wristSleepReported,
};

const directionOf = (ratio, near) => (ratio > 1 + near ? 'above' : ratio < 1 - near ? 'below' : 'near');

/**
 * Recovery, 0–100, and the signals that made it.
 *
 * Returns null when today has neither an HRV nor a resting heart rate: sleep alone is the
 * Sleep ring, not a second opinion on it.
 */
const recoveryFor = (rows, today) => {
    const row = rows.find((r) => r.day === today) ?? null;
    const hrvToday = PICK.hrv(row);
    const restingToday = PICK.resting(row);
    if (!finite(hrvToday) && !finite(restingToday)) return null;

    const signals = [];
    let learning = 0;

    const hrv = usualOf(rows, today, PICK.hrv);
    if (finite(hrvToday)) {
        learning = Math.max(learning, hrv.count);
        if (hrv.usual) {
            const ratio = hrvToday / hrv.usual;
            signals.push({
                key: 'hrv', value: Math.round(hrvToday), usual: Math.round(hrv.usual), unit: 'ms',
                direction: directionOf(ratio, NEAR.hrv),
                points: clamp(AT_USUAL + PER_BAND * ((ratio - 1) / NEAR.hrv), 0, 100),
            });
        }
    }

    const resting = usualOf(rows, today, PICK.resting);
    if (finite(restingToday)) {
        learning = Math.max(learning, resting.count);
        if (resting.usual) {
            const ratio = restingToday / resting.usual;
            signals.push({
                key: 'resting', value: Math.round(restingToday), usual: Math.round(resting.usual), unit: 'bpm',
                direction: directionOf(ratio, NEAR.resting),
                // Lower is better for a resting heart rate, so the sign is inverted.
                points: clamp(AT_USUAL + PER_BAND * ((1 - ratio) / NEAR.resting), 0, 100),
            });
        }
    }

    // Neither heart signal has a usual yet: say how far along it is, claim nothing.
    if (!signals.length) {
        return { score: null, state: 'learning', label: 'Learning your usual', learning: { have: learning, need: MIN_DAYS }, signals: [], penalty: 0 };
    }

    const sleepToday = PICK.sleep(row);
    if (finite(sleepToday)) {
        signals.push({ key: 'sleep', value: Math.round(sleepToday), usual: null, unit: '', direction: null, points: sleepToday });
    }

    let penalty = 0;
    const tempToday = PICK.temperature(row);
    const temp = usualOf(rows, today, PICK.temperature);
    if (finite(tempToday) && temp.usual) {
        const delta = tempToday - temp.usual;
        penalty = delta > TEMP_NEAR_C ? Math.min(TEMP_PENALTY_MAX, Math.round((delta - TEMP_NEAR_C) * TEMP_PENALTY_PER_C)) : 0;
        signals.push({
            key: 'temperature', value: Math.round(delta * 10) / 10, usual: Math.round(temp.usual * 10) / 10, unit: '°C',
            direction: delta > TEMP_NEAR_C ? 'above' : delta < -TEMP_NEAR_C ? 'below' : 'near',
            points: null,
        });
    }

    const weighted = signals.filter((s) => WEIGHTS[s.key] && finite(s.points));
    if (weighted.length < 2) {
        return { score: null, state: 'insufficient', label: 'Needs one more signal', learning: null, signals, penalty: 0 };
    }

    const totalWeight = weighted.reduce((sum, s) => sum + WEIGHTS[s.key], 0);
    const raw = weighted.reduce((sum, s) => sum + WEIGHTS[s.key] * s.points, 0) / totalWeight;
    const score = Math.round(clamp(raw - penalty, 0, 100));
    const state = STATES.find((s) => score >= s.min);

    return {
        score,
        state: state.key,
        label: state.label,
        learning: null,
        signals: signals.map((s) => ({ ...s, points: finite(s.points) ? Math.round(s.points) : null })),
        penalty,
    };
};

const roundTo5 = (n) => Math.round(n / 5) * 5;

/**
 * Today's effort, and how much of the week to ask for today.
 *
 * The week's target is spread over the days left in it, then scaled by recovery: more on a
 * recharged day, half on a day to take it easier. A week already done still gets a gentle
 * daily target rather than zero — moving is not something to stop once a number is reached.
 */
const effortFor = (rows, today, recoveryState, weeklyTarget = WEEKLY_EFFORT_TARGET) => {
    const row = rows.find((r) => r.day === today) ?? null;
    const weekStart = weekStartOf(today);
    const before = rows
        .filter((r) => r.day >= weekStart && r.day < today)
        .reduce((sum, r) => sum + (finite(r?.activity?.effortMin) ? r.activity.effortMin : 0), 0);
    const minutes = finite(row?.activity?.effortMin) ? row.activity.effortMin : null;

    const daysLeft = 7 - daysBetween(weekStart, today);
    const remaining = Math.max(0, weeklyTarget - before);
    const base = remaining > 0 ? remaining / daysLeft : weeklyTarget / 7;
    const share = EFFORT_SHARE[recoveryState] ?? 1;
    const target = clamp(roundTo5(base * share), DAILY_TARGET_MIN, DAILY_TARGET_MAX);

    return {
        minutes,
        moderateMin: finite(row?.activity?.moderateMin) ? row.activity.moderateMin : null,
        vigorousMin: finite(row?.activity?.vigorousMin) ? row.activity.vigorousMin : null,
        target,
        targetReason: remaining === 0 ? 'week_done' : (EFFORT_SHARE[recoveryState] ? recoveryState : 'default'),
        weekMinutes: Math.round(before + (minutes ?? 0)),
        weekTarget: weeklyTarget,
        steps: finite(row?.activity?.steps) ? row.activity.steps : null,
        source: row?.activity?.effortSource ?? null,
        note: row?.activity?.effortNote ?? null,
        breakdown: row?.activity?.effortBreakdown ?? null,
    };
};

/** Last night, as the Sleep ring draws it. Filed under the wake day, which is today. */
const sleepFor = (rows, today, goalMinutes) => {
    const s = rows.find((r) => r.day === today)?.sleep;
    if (!s || (!finite(s.asleepMin) && !finite(s.score))) return null;
    return {
        score: finite(s.score) ? Math.round(s.score) : null,
        asleepMin: finite(s.asleepMin) ? Math.round(s.asleepMin) : null,
        efficiency: finite(s.efficiency) ? Math.round(s.efficiency) : null,
        goalMinutes: finite(goalMinutes) ? goalMinutes : null,
    };
};

const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** The one heart signal furthest on the wrong side of usual, worded. */
const driverOf = (recovery) => {
    const signals = recovery?.signals ?? [];
    const resting = signals.find((s) => s.key === 'resting' && s.direction === 'above');
    const hrv = signals.find((s) => s.key === 'hrv' && s.direction === 'below');
    const worst = [resting, hrv].filter(Boolean).sort((a, b) => a.points - b.points)[0];
    if (!worst) return null;
    return worst.key === 'resting'
        ? `your resting heart rate is ${worst.value - worst.usual} bpm above your usual`
        : 'your heart rate variability is lower than usual';
};

/**
 * The sentence under the rings. Two at most, and it says what the rings mean together.
 *
 * Morning leads with the night and what it means for today; from noon it leads with the
 * day's effort. Nothing here names a condition or says how somebody feels.
 */
const sentenceFor = ({ hour, sleep, recovery, effort, held }) => {
    if (held) return 'A reading is waiting for you in your notifications. Look at it before planning a hard day.';

    const week = `${effort.weekMinutes} of ${effort.weekTarget} this week.`;

    if (hour >= 12) {
        if (finite(effort.minutes) && effort.minutes >= effort.target) {
            return `You've reached today's ${effort.target} effort minutes. ${week}`;
        }
        if (finite(effort.minutes) && effort.minutes > 0) {
            return `${effort.target - effort.minutes} effort minutes to go today. ${week}`;
        }
        return `Aim for ${effort.target} effort minutes today. ${week}`;
    }

    const lead = !sleep?.score ? null
        : sleep.score >= 80 ? 'you slept well'
            : sleep.score >= 60 ? 'a fair night'
                : "not your best night's sleep";
    const driver = driverOf(recovery);
    const target = effort.target;

    switch (recovery?.state) {
        case 'recharged':
            return `${capitalise(lead ? `${lead}, and you're well recovered` : "You're well recovered")}. A good day for something harder: aim for ${target} effort minutes.`;
        case 'steady':
            return driver
                ? `${capitalise(lead ? `${lead}, but ${driver}` : driver)}. A steady day: ${target} effort minutes is a good target.`
                : `${capitalise(lead ?? 'a steady start')}. ${target} effort minutes keeps your week on track.`;
        case 'low':
            return `${capitalise(lead ? `${lead}, and ${driver ?? 'your body is working harder than usual'}` : (driver ?? 'your body is working harder than usual'))}. Keep today light: ${target} effort minutes is plenty.`;
        case 'learning':
            return `${lead ? `${capitalise(lead)}. ` : ''}Recovery is still learning your usual: ${recovery.learning.have} of ${recovery.learning.need} nights.`;
        default:
            return `${lead ? `${capitalise(lead)}. ` : ''}Aim for ${target} effort minutes today.`;
    }
};

/**
 * Why recovery reads what it does, as plain sentences — the Recovery screen's "why" card.
 *
 * Only facts the signals carry: which side of usual each heart signal fell, the night's
 * temperature, a low sleep score. Never a cause. "Your resting heart rate is 6 bpm above your
 * usual" is a measurement; "you are coming down with something" would be a diagnosis.
 */
const reasonsFor = (recovery) => {
    if (!recovery || recovery.score == null) return [];
    const out = [];
    for (const s of recovery.signals) {
        if (s.key === 'resting' && s.direction !== 'near') {
            out.push(`Your resting heart rate is ${Math.abs(s.value - s.usual)} bpm ${s.direction} your usual.`);
        }
        if (s.key === 'hrv' && s.direction !== 'near') {
            out.push(`Your heart rate variability is ${s.direction === 'above' ? 'higher' : 'lower'} than usual.`);
        }
        if (s.key === 'temperature' && s.direction === 'above') {
            out.push(`Your wrist was ${s.value} °C warmer than usual overnight.`);
        }
        if (s.key === 'sleep' && s.value < 60) out.push(`Last night's sleep scored ${s.value}.`);
    }
    return out.length ? out : ['Everything measured is near your usual.'];
};

/**
 * Recovery for each of the last `days` days, oldest first, for the Recovery screen's trend.
 * Each day is judged against the 28 days before *it*, so `rows` must reach back that far.
 */
const recoveryTrend = (rows, today, days = 7) => {
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
        const day = new Date(Date.parse(`${today}T00:00:00Z`) - i * 86400000).toISOString().slice(0, 10);
        const r = recoveryFor(rows, day);
        out.push({ day, score: r?.score ?? null, state: r?.score != null ? r.state : null });
    }
    return out;
};

/**
 * The whole readout.
 *
 * @param {object} args
 * @param {Array}  args.rows          `DailyMetrics` rows covering at least the 28 days before today
 * @param {string} args.today         the person's local `YYYY-MM-DD`
 * @param {number} args.hour          the person's local hour, 0–23
 * @param {number} [args.goalMinutes] `SleepPlan.goalMinutes`
 * @param {boolean} [args.urgentAlert] an urgent `VitalAlert` is open
 */
const buildReadout = ({ rows = [], today, hour = 8, goalMinutes = null, urgentAlert = false }) => {
    const sleep = sleepFor(rows, today, goalMinutes);
    const recovery = recoveryFor(rows, today);
    const effort = effortFor(rows, today, recovery?.state);
    const held = Boolean(urgentAlert);

    return {
        day: today,
        // Earned like every home card: nothing to say about any ring is no readout at all.
        live: Boolean(sleep || recovery || finite(effort.minutes)),
        sleep,
        recovery: recovery ? { ...recovery, held } : null,
        effort,
        sentence: sentenceFor({ hour, sleep, recovery, effort, held }),
    };
};

module.exports = {
    BASELINE_DAYS,
    MIN_DAYS,
    WEIGHTS,
    NEAR,
    STATES,
    WEEKLY_EFFORT_TARGET,
    weekStartOf,
    recoveryFor,
    effortFor,
    sleepFor,
    sentenceFor,
    reasonsFor,
    recoveryTrend,
    buildReadout,
};
