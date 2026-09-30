/**
 * When somebody's next period is likely, and what their cycles look like. **A table and some
 * arithmetic, never a model.**
 *
 * The eleventh deterministic component in the series with `medicationCatalogue.js`,
 * `bloodPressure.js`, `nutritionSafety.js`, `reviewSla.js`, `predictionForecast.js`,
 * `achievementCatalogue.js`, `sleepTargets.js`, `notificationCatalogue.js`, `appState.ts` and
 * `vitalAlerts.js`, for the same reason as every one of them: a language model asked when
 * somebody's period is due answers fluently, differently on each call, and cannot be pinned
 * in a test. A median can, and `backtest` scores it against the person's own history.
 *
 * Nine rules, and each is a way this goes wrong for a real person:
 *
 * 1. **The median of the last six usable cycles, never the mean.** One 58-day cycle after an
 *    illness drags a mean a week late for months; a median shrugs it off.
 * 2. **A window, never a day.** The next start is `expected ± spread`, the spread coming from
 *    how much this person's cycles actually vary, floored at `MIN_SPREAD`. A single date on a
 *    screen reads as a promise, and a period two days "late" against a promise worries people.
 * 3. **Where the number came from is part of the answer** — `observed` once two cycles are
 *    logged, `reported` from the setup answers before that, and no prediction at all with
 *    neither. The same provenance the score carries.
 * 4. **A logging gap is not a cycle.** Cycles outside `USABLE` (15–60 days) are shown in the
 *    history but never feed the forecast: a 140-day "cycle" is almost always somebody who
 *    stopped opening the app, and forecasting from it would predict nothing useful for a year.
 * 5. **Late is a state with a number, and it is never an alert.** `late` once past the window,
 *    `very_late` a week after that. The copy names the ordinary causes; nothing here is a
 *    vital sign, and nothing escalates.
 * 6. **Regularity is a note, never a verdict.** The thresholds are the FIGO ones — cycles of
 *    24–38 days, variation up to 9, periods up to 8 days, and 90 days without one — and each
 *    produces a neutral "worth mentioning to a doctor". None names a condition.
 * 7. **Status switches things off.** Hormonal contraception has no ovulation to estimate, so
 *    no fertile window. Pregnancy and breastfeeding pause predictions and notes entirely.
 *    Perimenopause widens the window and silences the variation notes, because variation is
 *    what perimenopause is.
 * 8. **The fertile window is opt-in and is an estimate from a calendar.** Ovulation is placed
 *    `luteal` days before the expected start and the window runs five days before it to one
 *    after. That is not a way to avoid pregnancy, and every screen that draws it says so.
 * 9. **A temperature shift confirms ovulation after the fact, never ahead of it.** See
 *    `detectShift`. Its use is behind `CYCLE_TEMPERATURE_SIGNAL` until real data from the
 *    bracelet has shown the shift is visible at all.
 */
const {
    addDays, diffDays, daysBetween, findPeriods, cyclesFrom, periodStartFor, median, isBleeding,
} = require('./cycleEngine');

/** Cycles outside this range are real history but never forecasting input. Rule 4. */
const USABLE = { min: 15, max: 60 };

/** How many recent cycles the forecast reads. */
const HISTORY = 6;

/** Days either side of the expected start. Rule 2. */
const MIN_SPREAD = 2;
const MAX_SPREAD = 7;

/** The spread when the length came from the setup answers rather than logs. */
const REPORTED_SPREAD = 3;

/** Extra spread under perimenopause. Rule 7. */
const PERIMENOPAUSE_EXTRA = 3;

/** Days past the window's end before `late` becomes `very_late`. Rule 5. */
const VERY_LATE_AFTER = 7;

/** Days since the last logged start after which the likelier story is a logging gap. */
const LONG_GAP_DAYS = 90;

/** The textbook luteal phase, and the range a measured one is trusted within. */
const DEFAULT_LUTEAL = 14;
const LUTEAL_BOUNDS = { min: 10, max: 16 };

/** Drawn when nothing better is known. Display only — it never moves the start date. */
const DEFAULT_PERIOD_LENGTH = 5;

/** FIGO's normal ranges. Rule 6. */
const NORMAL = { cycleMin: 24, cycleMax: 38, variationMax: 9, periodMax: 8 };

/** How far ahead the calendar draws predicted periods. */
const PROJECTED_CYCLES = 3;

/** Temperature: a rise of at least this over the coverline on the third high night. */
const SHIFT_MIN_RISE = 0.2;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Is the temperature signal allowed to change anything the person sees? Rule 9. */
const temperatureSignalOn = (env = process.env) => env.CYCLE_TEMPERATURE_SIGNAL === 'true';

const paused = (plan) => ['pregnant', 'breastfeeding'].includes(plan?.status);
const fertileAllowed = (plan) =>
    Boolean(plan?.showFertileWindow) && !paused(plan) && plan?.status !== 'hormonal_contraception';

/**
 * The cycle length to forecast from, and how sure to be.
 * @returns {{length:number, spread:number, source:'observed'|'reported', count:number}|null}
 */
const cycleBasis = (cycles, plan) => {
    const usable = cycles.filter((c) => c.length >= USABLE.min && c.length <= USABLE.max).slice(-HISTORY);
    const extra = plan?.status === 'perimenopause' ? PERIMENOPAUSE_EXTRA : 0;
    const widen = (spread) => clamp(spread + extra, MIN_SPREAD, MAX_SPREAD + PERIMENOPAUSE_EXTRA);

    if (usable.length >= 2) {
        const lengths = usable.map((c) => c.length);
        return {
            length: Math.round(median(lengths)),
            spread: widen(clamp(Math.ceil((Math.max(...lengths) - Math.min(...lengths)) / 2), MIN_SPREAD, MAX_SPREAD)),
            source: 'observed',
            count: usable.length,
        };
    }
    if (plan?.seed?.cycleLength) {
        return { length: plan.seed.cycleLength, spread: widen(REPORTED_SPREAD), source: 'reported', count: 0 };
    }
    if (usable.length === 1) {
        return { length: usable[0].length, spread: widen(REPORTED_SPREAD + 1), source: 'observed', count: 1 };
    }
    return null;
};

/**
 * How long a period runs. A period with one logged day is somebody who tapped "started" and
 * never came back, not a one-day period, so those are left out of the median.
 */
const periodBasis = (periods, plan) => {
    const measured = periods.filter((p) => p.length >= 2).slice(-HISTORY).map((p) => p.length);
    if (measured.length >= 2) return { length: Math.round(median(measured)), source: 'observed' };
    if (plan?.seed?.periodLength) return { length: plan.seed.periodLength, source: 'reported' };
    if (measured.length === 1) return { length: measured[0], source: 'observed' };
    return { length: DEFAULT_PERIOD_LENGTH, source: 'default' };
};

/** Median luteal length from temperature-confirmed cycles, when the signal is trusted. */
const lutealBasis = (shifts = []) => {
    const measured = shifts
        .filter((s) => Number.isFinite(s.lutealDays))
        .map((s) => s.lutealDays)
        .filter((d) => d >= LUTEAL_BOUNDS.min && d <= LUTEAL_BOUNDS.max);
    if (measured.length >= 2) return { days: Math.round(median(measured)), source: 'temperature' };
    return { days: DEFAULT_LUTEAL, source: 'default' };
};

/**
 * Three over six. The standard symptothermal rule, applied to the night-time medians
 * `utils/nightTemperature.js` produces.
 *
 * A shift is three nights in a row above the highest of the six before them (the coverline),
 * the third at least `SHIFT_MIN_RISE` above it. Ovulation is placed the day before the first
 * high night, which is where it usually sits. One missing night is tolerated inside the six
 * and inside the three; more than that and the evidence is too thin to say anything.
 *
 * It can only ever look backwards: the third high night is the earliest a shift can be known,
 * by which time the fertile window it would have described is over.
 *
 * @param {Array<{day:string, celsius:number}>} nights  one cycle's nights, any order
 * @returns {{shiftDay, ovulationDay, confirmedOn, coverline}|null}
 */
const detectShift = (nights = []) => {
    const n = nights
        .filter((x) => x && Number.isFinite(x.celsius))
        .slice()
        .sort((a, b) => (a.day < b.day ? -1 : 1));

    for (let i = 6; i + 2 < n.length; i += 1) {
        const six = n.slice(i - 6, i);
        const three = n.slice(i, i + 3);
        if (diffDays(six[0].day, six[5].day) > 6) continue;
        if (diffDays(three[0].day, three[2].day) > 3) continue;
        if (diffDays(six[5].day, three[0].day) > 2) continue;

        const coverline = Math.max(...six.map((x) => x.celsius));
        if (three.every((x) => x.celsius > coverline) && three[2].celsius >= coverline + SHIFT_MIN_RISE - 1e-9) {
            return {
                shiftDay: three[0].day,
                ovulationDay: addDays(three[0].day, -1),
                confirmedOn: three[2].day,
                coverline: Math.round(coverline * 100) / 100,
            };
        }
    }
    return null;
};

/**
 * Run `detectShift` over every cycle, completed or open.
 * @param {Array<{day, celsius}>} nights  every night with a sleep-window median
 */
const temperatureShifts = (periods, nights, today) => periods.map((p, i) => {
    const end = periods[i + 1] ? addDays(periods[i + 1].start, -1) : today;
    const all = nights.filter((x) => x.day >= p.start && x.day <= end);
    // One sensor per cycle. The bracelet and an Apple Watch sit on different baselines, and a
    // rise found by comparing one with the other is a change of device, not ovulation. The
    // source with the most nights in the cycle is the one read.
    const counts = {};
    for (const x of all) counts[x.source || 'bracelet'] = (counts[x.source || 'bracelet'] || 0) + 1;
    const main = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    const inCycle = all.filter((x) => (x.source || 'bracelet') === main);
    const shift = detectShift(inCycle);
    return {
        cycleStart: p.start,
        nights: inCycle.length,
        shift,
        lutealDays: shift && periods[i + 1] ? diffDays(shift.ovulationDay, periods[i + 1].start) : null,
    };
});

/**
 * The whole reading of somebody's cycle as of `today`.
 *
 * @param {object} args
 * @param {Array}  args.days     merged `CycleDay` rows (see `cycleEngine.mergeDays`)
 * @param {object} args.plan     `CyclePlan`
 * @param {string} args.today    local `YYYY-MM-DD`
 * @param {Array}  [args.nights] `{ day, celsius }` sleep-window medians, for rule 9
 * @param {boolean} [args.useTemperature]  defaults to `CYCLE_TEMPERATURE_SIGNAL`
 */
const forecast = ({ days = [], plan = {}, today, nights = [], useTemperature = temperatureSignalOn() }) => {
    const { periods, between } = findPeriods(days);
    const cycles = cyclesFrom(periods);
    const latest = periods[periods.length - 1] || null;

    // Rule 3: the later of the last logged start and the one given at setup.
    const seedStart = plan?.seed?.lastPeriodStart && plan.seed.lastPeriodStart <= today
        ? plan.seed.lastPeriodStart : null;
    const lastStart = [latest?.start, seedStart].filter(Boolean).sort().pop() || null;
    const lastStartSource = lastStart && lastStart === latest?.start ? 'logged' : lastStart ? 'reported' : null;

    const ongoing = Boolean(latest && latest.start <= today && diffDays(latest.end, today) <= 1);
    const cycleDay = lastStart ? diffDays(lastStart, today) + 1 : null;

    const shifts = useTemperature ? temperatureShifts(periods, nights, today) : [];
    const luteal = useTemperature ? lutealBasis(shifts) : { days: DEFAULT_LUTEAL, source: 'default' };
    const cycleB = cycleBasis(cycles, plan);
    const periodB = periodBasis(periods, plan);

    const base = {
        periods, between, cycles, lastStart, lastStartSource, cycleDay,
        periodLength: periodB, luteal,
        currentPeriod: ongoing
            ? {
                start: latest.start,
                day: diffDays(latest.start, today) + 1,
                loggedThrough: latest.end,
                // Where it will probably stop, for drawing the rest of it as predicted.
                expectedEnd: [latest.end, addDays(latest.start, periodB.length - 1)].sort().pop(),
            }
            : null,
        confirmedOvulations: shifts.filter((s) => s.shift).map((s) => s.shift.ovulationDay),
    };

    if (paused(plan)) {
        return { ...base, state: 'paused', reason: plan.status, prediction: null, projected: [] };
    }
    if (!lastStart) {
        return { ...base, state: ongoing ? 'period' : 'unknown', reason: 'needs_period', prediction: null, projected: [] };
    }
    if (!cycleB) {
        return { ...base, state: ongoing ? 'period' : 'unknown', reason: 'needs_length', prediction: null, projected: [] };
    }

    const expected = addDays(lastStart, cycleB.length);
    const window = { from: addDays(expected, -cycleB.spread), to: addDays(expected, cycleB.spread) };
    const prediction = {
        expected, window,
        cycleLength: cycleB.length, spread: cycleB.spread, source: cycleB.source, cyclesUsed: cycleB.count,
    };

    let state;
    const detail = {};
    if (ongoing) {
        state = 'period';
    } else if (today < window.from) {
        state = 'upcoming';
        detail.daysUntil = { from: diffDays(today, window.from), to: diffDays(today, window.to) };
    } else if (today <= window.to) {
        state = 'due';
    } else if (diffDays(lastStart, today) >= LONG_GAP_DAYS) {
        state = 'long_gap';
        detail.daysSinceStart = diffDays(lastStart, today);
    } else {
        detail.daysLate = diffDays(expected, today);
        state = diffDays(window.to, today) >= VERY_LATE_AFTER ? 'very_late' : 'late';
    }

    // The calendar's predicted periods. Past the window, only the overdue one is drawn:
    // stacking three more months of guesses on top of a period that has not come is a
    // prediction built on a prediction.
    const overdue = ['late', 'very_late', 'long_gap'].includes(state);
    const count = overdue ? 1 : PROJECTED_CYCLES;
    const allowFertile = fertileAllowed(plan);
    const projected = [];
    for (let k = 0; k < count; k += 1) {
        const start = addDays(expected, k * cycleB.length);
        const ovulation = addDays(start, -luteal.days);
        projected.push({
            start,
            end: addDays(start, periodB.length - 1),
            window: { from: addDays(start, -cycleB.spread), to: addDays(start, cycleB.spread) },
            ovulation: allowFertile ? ovulation : null,
            fertile: allowFertile ? { from: addDays(ovulation, -5), to: addDays(ovulation, 1) } : null,
        });
    }

    return { ...base, state, ...detail, reason: null, prediction, projected };
};

/**
 * The fertile window to show on the dashboard: the first projected one that has not ended.
 *
 * `projected[0]` belongs to the cycle ending at the next expected start, so by the week before
 * a period its window is already over — and printing "22–28 Sep" on the 30th reads as the
 * current window. Null when the window is not drawn at all.
 */
const nextFertile = (projected = [], today) => {
    const p = projected.find((x) => x.fertile && x.fertile.to >= today);
    if (!p) return null;
    return { window: p.fertile, ovulation: p.ovulation, now: p.fertile.from <= today };
};

/**
 * The "worth mentioning to a doctor" notes. Rule 6. Never a diagnosis, never a colour.
 * @returns {Array<{key:string, title:string, body:string}>}
 */
const regularityNotes = (reading, plan, today) => {
    if (paused(plan)) return [];
    const notes = [];
    const perimenopause = plan?.status === 'perimenopause';
    const recent = reading.cycles.filter((c) => c.length >= USABLE.min && c.length <= USABLE.max).slice(-HISTORY);

    if (!perimenopause) {
        const outside = recent.filter((c) => c.length < NORMAL.cycleMin || c.length > NORMAL.cycleMax);
        if (outside.length >= 2) {
            notes.push({
                key: 'cycle_length',
                title: 'Some cycles were shorter or longer than usual',
                body: `${outside.length} of your last ${recent.length} cycles fell outside the usual 24–38 days. `
                    + 'Cycles vary for many reasons, but a pattern like this is worth mentioning to a doctor.',
            });
        }
        if (recent.length >= 3) {
            const lengths = recent.map((c) => c.length);
            const spread = Math.max(...lengths) - Math.min(...lengths);
            if (spread > NORMAL.variationMax) {
                notes.push({
                    key: 'variation',
                    title: 'Your cycle length varies quite a bit',
                    body: `Your recent cycles ranged over ${spread} days, from ${Math.min(...lengths)} to ${Math.max(...lengths)}. `
                        + 'Some variation is normal; more than about 9 days is worth mentioning to a doctor.',
                });
            }
        }
    }

    const longPeriods = reading.periods.slice(-3).filter((p) => p.length > NORMAL.periodMax);
    if (longPeriods.length) {
        notes.push({
            key: 'long_period',
            title: 'A period lasted longer than 8 days',
            body: 'Periods usually last up to 8 days. If yours often run longer, it is worth mentioning to a doctor.',
        });
    }

    const since = addDays(today, -90);
    if (reading.between.some((d) => d >= since)) {
        notes.push({
            key: 'between_periods',
            title: 'Bleeding between periods',
            body: 'You logged bleeding between periods recently. It is often nothing, but it is worth mentioning to a doctor, '
                + 'especially if it keeps happening.',
        });
    }

    if (reading.state === 'long_gap' && plan?.status !== 'hormonal_contraception') {
        notes.push({
            key: 'no_period',
            title: `No period logged for ${reading.daysSinceStart} days`,
            body: 'If you have had periods since, log them to keep your predictions right. If you have not, '
                + 'three months without a period is worth mentioning to a doctor.',
        });
    }

    return notes;
};

/**
 * How the forecast would have done on this person's own history.
 *
 * For each period with at least two usable cycles before it, predict its start from those
 * cycles alone and check whether it landed inside the window. A backtest rather than a record
 * of what was shown — the rule is deterministic, so it is the same answer the screen would
 * have given. Null, never zero, when there is nothing to check.
 */
const backtest = (periods, plan) => {
    const checks = [];
    for (let k = 3; k < periods.length; k += 1) {
        const before = cyclesFrom(periods.slice(0, k));
        const basis = cycleBasis(before, { status: plan?.status });
        if (!basis || basis.source !== 'observed' || basis.count < 2) continue;
        const actualLength = diffDays(periods[k - 1].start, periods[k].start);
        if (actualLength < USABLE.min || actualLength > USABLE.max) continue;
        const expected = addDays(periods[k - 1].start, basis.length);
        const miss = diffDays(expected, periods[k].start);
        checks.push({ start: periods[k].start, expected, missDays: miss, hit: Math.abs(miss) <= basis.spread });
    }
    const recent = checks.slice(-HISTORY);
    if (!recent.length) return null;
    const hits = recent.filter((c) => c.hit).length;
    return { checked: recent.length, hits, rate: hits / recent.length, checks: recent };
};

/** Median cycle, median period, and how much the cycles move. Null wherever nothing is known. */
const stats = (reading) => {
    const usable = reading.cycles.filter((c) => c.length >= USABLE.min && c.length <= USABLE.max).slice(-HISTORY);
    const lengths = usable.map((c) => c.length);
    const periodLengths = reading.periods.filter((p) => p.length >= 2).slice(-HISTORY).map((p) => p.length);
    return {
        cyclesLogged: reading.cycles.length,
        averageCycle: lengths.length ? Math.round(median(lengths)) : null,
        averagePeriod: periodLengths.length ? Math.round(median(periodLengths)) : null,
        variation: lengths.length >= 2 ? Math.max(...lengths) - Math.min(...lengths) : null,
    };
};

/**
 * What to draw on each day in a range — the calendar and the week strip read this, so the two
 * cannot mark the same Tuesday differently.
 */
const marksForRange = ({ from, to, days = [], reading, today }) => {
    const byDay = new Map(days.map((d) => [d.day, d]));
    const periodDays = new Set();
    for (const p of reading.periods) for (const d of daysBetween(p.start, p.end)) periodDays.add(d);
    const between = new Set(reading.between);
    const confirmed = new Set(reading.confirmedOvulations || []);

    const predicted = new Map();
    const current = reading.currentPeriod;
    if (current) {
        for (const d of daysBetween(addDays(current.loggedThrough, 1), current.expectedEnd)) predicted.set(d, 'period');
    }
    for (const p of reading.projected || []) {
        for (const d of daysBetween(p.window.from, p.window.to)) if (!predicted.has(d)) predicted.set(d, 'window');
        for (const d of daysBetween(p.start, p.end)) predicted.set(d, 'period');
    }
    const fertile = new Set();
    const ovulation = new Set();
    for (const p of reading.projected || []) {
        if (p.fertile) for (const d of daysBetween(p.fertile.from, p.fertile.to)) fertile.add(d);
        if (p.ovulation) ovulation.add(p.ovulation);
    }

    return daysBetween(from, to).map((day) => {
        const row = byDay.get(day);
        const logged = periodDays.has(day) && isBleeding(row?.flow);
        // A prediction is never drawn over a day that already happened: what did happen is
        // logged, and what did not is not a missed period.
        const future = day > today;
        return {
            day,
            today: day === today,
            future,
            flow: row?.flow ?? null,
            period: logged,
            between: between.has(day),
            predicted: !logged && day >= today ? predicted.get(day) ?? null : null,
            fertile: fertile.has(day) && day >= today,
            ovulation: ovulation.has(day) && day >= today,
            ovulationConfirmed: confirmed.has(day),
            symptoms: row?.symptoms?.length ?? 0,
            mood: row?.mood ?? null,
            note: Boolean(row?.note),
        };
    });
};

/**
 * Which symptoms turn up on which cycle days. "Cramps: usually days 1–2" is the line the
 * insight screen draws from `peakDays`.
 */
const symptomPattern = (days, periods) => {
    const counts = new Map();
    for (const d of days) {
        if (!d.symptoms?.length) continue;
        const start = periodStartFor(periods, d.day);
        if (!start) continue;
        const cycleDay = diffDays(start, d.day) + 1;
        if (cycleDay > 45) continue;
        for (const s of d.symptoms) {
            if (!counts.has(s)) counts.set(s, new Map());
            const byDay = counts.get(s);
            byDay.set(cycleDay, (byDay.get(cycleDay) || 0) + 1);
        }
    }
    return [...counts.entries()]
        .map(([symptom, byDay]) => {
            const total = [...byDay.values()].reduce((a, b) => a + b, 0);
            const top = Math.max(...byDay.values());
            const peakDays = [...byDay.entries()].filter(([, c]) => c >= top / 2).map(([d]) => d).sort((a, b) => a - b);
            return { symptom, count: total, peakDays, byDay: Object.fromEntries(byDay) };
        })
        .sort((a, b) => b.count - a.count);
};

module.exports = {
    USABLE,
    HISTORY,
    MIN_SPREAD,
    MAX_SPREAD,
    VERY_LATE_AFTER,
    LONG_GAP_DAYS,
    DEFAULT_LUTEAL,
    DEFAULT_PERIOD_LENGTH,
    NORMAL,
    SHIFT_MIN_RISE,
    temperatureSignalOn,
    fertileAllowed,
    cycleBasis,
    periodBasis,
    lutealBasis,
    detectShift,
    temperatureShifts,
    forecast,
    nextFertile,
    regularityNotes,
    backtest,
    stats,
    marksForRange,
    symptomPattern,
};
