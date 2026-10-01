/**
 * Joining the pieces of one sleep back into one sleep.
 *
 * Pure: no database, no clock. Used at ingest by `healthSync.ingestSleep`, and at read time by
 * `sleepRecord.classifyDay` as a second line for pieces ingest could not join (a hand-entered
 * night beside a device one, rows stored before this existed).
 *
 * **Why it exists.** The J-Style bracelet reports a night as records of about two hours each,
 * one per block, and each has its own `externalId` — so one night of 00:23–07:05 arrived as
 * four rows. Everything downstream picks "the longest row of the day" as the night, which
 * turned a 6h 32m night into a 2h night scored 36, discarded two of the blocks as fragments and
 * called the last one a nap. Verified against real data 2026-09-29. A watch that splits a
 * disturbed night into two stretches is the same problem in Health Connect.
 *
 * Three rules:
 *
 * 1. **A gap of at most `STITCH_GAP_MIN` is the same sleep.** Getting up for twenty minutes at
 *    3am does not end a night. Past that it is a separate sleep: going back to bed 78 minutes
 *    after getting up is a nap, and `sleepRecord` files it as one.
 * 2. **The gap is not sleep and is not assumed to be awake.** Nothing recorded it. It counts
 *    toward the time in bed, which is the span, and toward nothing else.
 * 1b. **A morning wake ends the night sooner.** Once a sleep holds `MORNING_MIN_ASLEEP` of
 *    sleep, a gap of more than `MORNING_GAP_MIN` that starts between 05:00 and noon local
 *    separates what follows. On 2026-10-01 a night ended 07:01, the person was up for 25
 *    minutes and slept again 07:26–08:44; the overnight rule joined the two into one
 *    00:28–08:44 night, so the record showed no nap, a wake time of 08:44, and a night score
 *    paying for 25 minutes awake in bed. The overnight limit stays where it is: the
 *    bracelet's own blocks are up to 9 minutes apart in real data, and getting up for twenty
 *    minutes at 3am does not end a night. Applied only when the caller knows the person's
 *    `tzOffset`; without it, rule 1 alone, as before.
 * 3. **A stage total is only a total if every piece reported it.** Summing a staged piece with
 *    a duration-only one would report the second piece's sleep as no deep sleep at all — the
 *    null-never-zero rule `sleepInsight` holds.
 */

/** Minutes between two pieces that still makes them one sleep. See rule 1. */
const STITCH_GAP_MIN = 30;
/** After a morning wake, the gap that ends the night. See rule 1b. */
const MORNING_GAP_MIN = 20;
/** When a gap can be a morning wake: 05:00 to noon, local. */
const MORNING_WINDOW = { fromMin: 5 * 60, toMin: 12 * 60 };
/** ...and only once there is a night to end. */
const MORNING_MIN_ASLEEP = 180;

const STAGE_KEYS = ['deepMin', 'remMin', 'lightMin', 'awakeMin'];

const time = (d) => new Date(d).getTime();
const finite = (v) => Number.isFinite(v);
const minutesBetween = (a, b) => Math.max(0, Math.round((time(b) - time(a)) / 60_000));
const asleepOf = (s) => (finite(s.asleepMin) ? s.asleepMin : minutesBetween(s.startedAt, s.endedAt));

/** Minutes past local midnight. `tzOffset` is `getTimezoneOffset()`: UTC+4 is −240. */
const localMinute = (ms, tzOffset) => {
    const m = Math.floor((ms - tzOffset * 60_000) / 60_000) % 1440;
    return m < 0 ? m + 1440 : m;
};

/** Rule 1b: does a gap of `gapMs` from `reach`, after `asleep` minutes, end the sleep? */
const isMorningWake = (reach, gapMs, asleep, tzOffset) => {
    if (!Number.isFinite(tzOffset) || asleep < MORNING_MIN_ASLEEP) return false;
    if (gapMs <= MORNING_GAP_MIN * 60_000) return false;
    const at = localMinute(reach, tzOffset);
    return at >= MORNING_WINDOW.fromMin && at < MORNING_WINDOW.toMin;
};

/**
 * Consecutive runs of sessions whose gaps are all at most `gapMin` — less after a morning
 * wake, when `tzOffset` is given (rule 1b). Overlap counts as a gap of zero. Sorted by start,
 * then `externalId`, so the grouping never depends on arrival order.
 */
const clusterSessions = (sessions = [], gapMin = STITCH_GAP_MIN, { tzOffset = null } = {}) => {
    const sorted = sessions
        .filter((s) => s && finite(time(s.startedAt)) && finite(time(s.endedAt)))
        .slice()
        .sort((a, b) => (time(a.startedAt) - time(b.startedAt))
            || String(a.externalId || '').localeCompare(String(b.externalId || '')));

    const clusters = [];
    let current = null;
    let reach = -Infinity;
    let asleep = 0;
    for (const s of sorted) {
        const gap = time(s.startedAt) - reach;
        if (current && gap <= gapMin * 60_000 && !isMorningWake(reach, gap, asleep, tzOffset)) {
            current.push(s);
            asleep += asleepOf(s);
        } else {
            current = [s];
            clusters.push(current);
            asleep = asleepOf(s);
        }
        reach = Math.max(reach, time(s.endedAt));
    }
    return clusters;
};

/**
 * One cluster as one sleep's figures: span, time asleep, stage totals, segments, efficiency.
 * No score, no day, no identity — the caller owns those, because ingest and the record screen
 * decide them differently.
 */
const mergeSessions = (parts = []) => {
    const ordered = parts.slice().sort((a, b) => time(a.startedAt) - time(b.startedAt));
    const startedAt = new Date(Math.min(...ordered.map((p) => time(p.startedAt))));
    const endedAt = new Date(Math.max(...ordered.map((p) => time(p.endedAt))));

    const stages = {};
    for (const key of STAGE_KEYS) {
        const values = ordered.map((p) => p.stages?.[key]);
        stages[key] = values.every(finite) ? values.reduce((a, b) => a + b, 0) : null;
    }

    const segmented = ordered.every((p) => Array.isArray(p.segments) && p.segments.length);
    const segments = segmented
        ? ordered.flatMap((p) => p.segments).sort((a, b) => time(a.startedAt) - time(b.startedAt))
        : [];

    const asleepMin = ordered.reduce((sum, p) => sum + asleepOf(p), 0);
    // Rule 2: the span. A single piece keeps what its source said.
    const inBedMin = ordered.length === 1 && finite(ordered[0].inBedMin)
        ? ordered[0].inBedMin
        : minutesBetween(startedAt, endedAt);

    // Only with every piece's awake time known, as at ingest — otherwise it flatters.
    const efficiency = segmented && inBedMin > 0
        ? Math.min(100, Math.round((asleepMin / inBedMin) * 100))
        : null;

    return { startedAt, endedAt, asleepMin, inBedMin, stages, segments, efficiency };
};

module.exports = {
    clusterSessions, mergeSessions, isMorningWake,
    STITCH_GAP_MIN, MORNING_GAP_MIN, MORNING_WINDOW, MORNING_MIN_ASLEEP,
};
