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
 * 3. **A stage total is only a total if every piece reported it.** Summing a staged piece with
 *    a duration-only one would report the second piece's sleep as no deep sleep at all — the
 *    null-never-zero rule `sleepInsight` holds.
 */

/** Minutes between two pieces that still makes them one sleep. See rule 1. */
const STITCH_GAP_MIN = 30;

const STAGE_KEYS = ['deepMin', 'remMin', 'lightMin', 'awakeMin'];

const time = (d) => new Date(d).getTime();
const finite = (v) => Number.isFinite(v);
const minutesBetween = (a, b) => Math.max(0, Math.round((time(b) - time(a)) / 60_000));
const asleepOf = (s) => (finite(s.asleepMin) ? s.asleepMin : minutesBetween(s.startedAt, s.endedAt));

/**
 * Consecutive runs of sessions whose gaps are all at most `gapMin`. Overlap counts as a gap of
 * zero. Sorted by start, then `externalId`, so the grouping never depends on arrival order.
 */
const clusterSessions = (sessions = [], gapMin = STITCH_GAP_MIN) => {
    const sorted = sessions
        .filter((s) => s && finite(time(s.startedAt)) && finite(time(s.endedAt)))
        .slice()
        .sort((a, b) => (time(a.startedAt) - time(b.startedAt))
            || String(a.externalId || '').localeCompare(String(b.externalId || '')));

    const clusters = [];
    let current = null;
    let reach = -Infinity;
    for (const s of sorted) {
        if (current && time(s.startedAt) - reach <= gapMin * 60_000) {
            current.push(s);
        } else {
            current = [s];
            clusters.push(current);
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

module.exports = { clusterSessions, mergeSessions, STITCH_GAP_MIN };
