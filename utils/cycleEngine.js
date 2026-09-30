/**
 * Logged days → periods → cycles. Pure: no database, no clock it was not handed.
 *
 * `CycleDay` stores what somebody recorded about a day. This file is the only place that
 * decides what those days *are* — which run of them is a period, where a cycle begins — so
 * the dashboard, the calendar, the history and the reminder job cannot disagree about it.
 *
 * Three rules, each one a way the naive version gets somebody's record wrong:
 *
 * 1. **Spotting never starts a period.** Light spotting before a period, or mid-cycle, is
 *    common, and treating it as day 1 would move every prediction that follows it. A period
 *    begins on the first day of light flow or heavier; spotting days are kept and drawn, but
 *    they are not bleeding here.
 * 2. **A logging gap is not a new period.** People log the days they remember. Bleeding days
 *    at most `JOIN_GAP_DAYS` apart belong to one period, so a skipped Tuesday does not split
 *    Monday–Thursday into two periods and invent a two-day cycle.
 * 3. **Bleeding soon after a period started is not the next period.** Anything within
 *    `MIN_CYCLE_DAYS` of the current period's start that is not joined to it is recorded as
 *    bleeding *between* periods — clinically a different thing, and one the regularity notes
 *    mention — rather than as the start of a cycle nobody had.
 */

const DAY_MS = 86_400_000;

/** Bleeding days at most this far apart are one period (two unlogged days between them). */
const JOIN_GAP_DAYS = 3;

/** A new period cannot start sooner than this after the previous one started. */
const MIN_CYCLE_DAYS = 14;

/** Flows that count as a period day. `spotting` is deliberately absent — rule 1. */
const BLEEDING = new Set(['light', 'medium', 'heavy', 'unspecified']);

/** Heaviness order, for "the heaviest day of this period". `unspecified` ranks with nothing. */
const FLOW_RANK = { spotting: 0, light: 1, medium: 2, heavy: 3 };

const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const toTime = (day) => Date.parse(`${day}T00:00:00.000Z`);

/** `YYYY-MM-DD` shifted by whole days. Calendar arithmetic on the string, never on a clock. */
const addDays = (day, n) => new Date(toTime(day) + n * DAY_MS).toISOString().slice(0, 10);

/** Whole days from `a` to `b` (positive when `b` is later). */
const diffDays = (a, b) => Math.round((toTime(b) - toTime(a)) / DAY_MS);

/** Every day from `from` to `to`, inclusive. Empty when `to` is earlier. */
const daysBetween = (from, to) => {
    const out = [];
    for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
    return out;
};

/** Local `YYYY-MM-DD` for an instant, `tzOffset` in minutes west of UTC. */
const localDay = (date, tzOffset = 0) =>
    new Date(new Date(date).getTime() - (Number(tzOffset) || 0) * 60_000).toISOString().slice(0, 10);

const isBleeding = (flow) => BLEEDING.has(flow);

/**
 * One row per day, oldest first, merged across sources **field by field**.
 *
 * A day can have the person's own row and rows mirrored from a health store. Flow comes
 * from the manual row when it states one, or when it explicitly cleared one
 * (`flowCleared`); otherwise from the store. Symptoms, mood and notes are only ever the
 * app's. Merging whole rows instead — the manual row simply winning — would let a logged
 * headache erase a heavy day Health Connect recorded, which is the failure this exists to
 * prevent. Between two stores the earliest-created row with a flow wins, so the answer never
 * depends on sync order.
 *
 * `source` on the result is where the **flow** came from.
 */
const mergeDays = (rows = []) => {
    const byDay = new Map();
    for (const r of rows) {
        if (!isDay(r.day)) continue;
        if (!byDay.has(r.day)) byDay.set(r.day, []);
        byDay.get(r.day).push(r);
    }
    const created = (r) => new Date(r.createdAt || 0).getTime();
    const out = [];
    for (const [day, list] of byDay) {
        const manual = list.find((r) => (r.source || 'manual') === 'manual') || null;
        const stores = list.filter((r) => (r.source || 'manual') !== 'manual').sort((a, b) => created(a) - created(b));
        const store = stores.find((r) => r.flow) || stores[0] || null;

        let flow = null;
        let source = 'manual';
        if (manual?.flow) {
            flow = manual.flow;
        } else if (!manual?.flowCleared && store?.flow) {
            flow = store.flow;
            source = store.source;
        }
        out.push({
            day,
            flow,
            symptoms: manual?.symptoms || [],
            mood: manual?.mood ?? null,
            note: manual?.note ?? null,
            source,
        });
    }
    return out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
};

/**
 * The periods in a set of merged days, and any bleeding that fell between them.
 *
 * @returns {{ periods: Array<{start, end, length, loggedDays, heaviest}>, between: string[] }}
 */
const findPeriods = (days = []) => {
    const flowByDay = new Map(days.map((d) => [d.day, d.flow]));
    const bleeding = days.filter((d) => isBleeding(d.flow)).map((d) => d.day);

    const periods = [];
    const between = [];

    for (const day of bleeding) {
        const current = periods[periods.length - 1];
        if (current && diffDays(current.end, day) <= JOIN_GAP_DAYS) {
            current.end = day;
            current.days.push(day);
        } else if (current && diffDays(current.start, day) < MIN_CYCLE_DAYS) {
            between.push(day);
        } else {
            periods.push({ start: day, end: day, days: [day] });
        }
    }

    return {
        periods: periods.map((p) => {
            const ranks = p.days.map((d) => FLOW_RANK[flowByDay.get(d)]).filter((r) => r !== undefined);
            const top = ranks.length ? Math.max(...ranks) : null;
            return {
                start: p.start,
                end: p.end,
                length: diffDays(p.start, p.end) + 1,
                loggedDays: p.days.length,
                heaviest: top === null ? null : Object.keys(FLOW_RANK).find((k) => FLOW_RANK[k] === top),
            };
        }),
        between,
    };
};

/** Complete cycles: from one period's start to the next one's. The open cycle is not one yet. */
const cyclesFrom = (periods = []) => {
    const out = [];
    for (let i = 0; i < periods.length - 1; i += 1) {
        out.push({
            start: periods[i].start,
            nextStart: periods[i + 1].start,
            length: diffDays(periods[i].start, periods[i + 1].start),
            periodLength: periods[i].length,
        });
    }
    return out;
};

/** The period a day falls in, or the latest one that started before it. For "cycle day N". */
const periodStartFor = (periods, day) => {
    let start = null;
    for (const p of periods) {
        if (p.start <= day) start = p.start;
        else break;
    }
    return start;
};

const median = (values) => {
    const v = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
    if (!v.length) return null;
    const mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
};

module.exports = {
    JOIN_GAP_DAYS,
    MIN_CYCLE_DAYS,
    FLOW_RANK,
    isDay,
    isBleeding,
    addDays,
    diffDays,
    daysBetween,
    localDay,
    mergeDays,
    findPeriods,
    cyclesFrom,
    periodStartFor,
    median,
};
