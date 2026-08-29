/**
 * Ingest of device-sourced health data, and the daily rollup that follows it.
 *
 * Everything here is written to be run repeatedly with the same input and produce the same
 * result. The client syncs on every app foreground, a batch can be retried after a dropped
 * connection, and an Apple Watch and the iPhone paired to it both write the same workout
 * into HealthKit — so "this arrived twice" is the normal case, not the error case.
 *
 * Two rules hold the whole file together:
 *
 * 1. **Rows are upserted by `externalId`, never appended.** The health store's own UUID is
 *    the identity. Anything without one came from a person typing it and is left alone.
 * 2. **`DailyMetrics` is recomputed from the rows, never incremented.** Adding to a counter
 *    on write is how a rollup drifts away from the data it summarises, and there is no way
 *    to tell someone their step count is wrong because a sync was retried.
 */
const mongoose = require('mongoose');
const ActivitySession = require('../models/ActivitySession');
const SleepSession = require('../models/SleepSession');
const HeartRateSample = require('../models/HeartRateSample');
const DailyMetrics = require('../models/DailyMetrics');
const { scoreNight } = require('./sleepScore');
const { scoreSession } = require('./activityScore');

/** `YYYY-MM-DD` for an instant in a given timezone offset (minutes, as `getTimezoneOffset()`). */
const localDay = (date, tzOffsetMinutes = 0) => {
    const shifted = new Date(new Date(date).getTime() - tzOffsetMinutes * 60_000);
    return shifted.toISOString().slice(0, 10);
};

const isDayString = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/**
 * The calendar day a row belongs to.
 *
 * The client knows its own calendar and may send `day` outright; `tzOffset` is the fallback
 * for a caller that only sends timestamps. Defaulting to UTC files an evening run in the
 * Americas under the following day — wrong on the one screen the feature is built around.
 */
const resolveDay = (day, instant, tzOffset) =>
    (isDayString(day) ? day : localDay(instant, Number(tzOffset) || 0));

/**
 * The design's ten activity types, and what the platforms call them.
 *
 * HealthKit alone defines around eighty workout activity types and Health Connect has its
 * own list, so this is a display mapping and **not** a whitelist: an unrecognised type is
 * passed through unchanged rather than dropped. Someone's kitesurfing session showing up
 * labelled "kitesurfing" is right; it silently not syncing is not.
 */
const TYPE_ALIASES = {
    walking: 'walking',
    running: 'jogging',
    jogging: 'jogging',
    hiking: 'hiking',
    cycling: 'biking',
    biking: 'biking',
    swimming: 'swimming',
    swimmingpool: 'swimming',
    swimmingopenwater: 'swimming',
    yoga: 'yoga',
    meditation: 'meditation',
    mindandbody: 'meditation',
    rowing: 'rowing',
    traditionalstrengthtraining: 'weightlifting',
    functionalstrengthtraining: 'weightlifting',
    strengthtraining: 'weightlifting',
    weightlifting: 'weightlifting',
    soccer: 'soccer',
    football: 'soccer',
};

/**
 * Platform prefixes to strip before looking a type up.
 *
 * HealthKit reports `HKWorkoutActivityTypeRunning`, not `running`, and Health Connect's
 * string form is `EXERCISE_TYPE_RUNNING`. Matching on the raw value means every synced
 * workout falls through to the pass-through branch and the dashboard groups a week of runs
 * under `hkworkoutactivitytyperunning` — which looks like it worked right up until someone
 * reads a label.
 */
const TYPE_PREFIXES = [
    'hkworkoutactivitytype',
    'exercisesessionrecordexercisetype',
    'exercisetype',
];

const normaliseType = (raw) => {
    if (!raw) return 'other';

    let key = String(raw).toLowerCase().replace(/[\s_-]/g, '');
    for (const prefix of TYPE_PREFIXES) {
        if (key.startsWith(prefix) && key.length > prefix.length) {
            key = key.slice(prefix.length);
            break;
        }
    }

    if (TYPE_ALIASES[key]) return TYPE_ALIASES[key];

    // Unknown types are passed through, never dropped — an enum here would mean someone's
    // kitesurfing session silently not syncing. Rendered from the de-prefixed form so an
    // unmapped HealthKit type still reads as a word.
    return key.replace(/([a-z])([A-Z])/g, '$1 $2').trim() || 'other';
};

/** Minutes between two instants, floored at zero. */
const minutesBetween = (from, to) =>
    Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60_000));

/**
 * Heart-rate contexts we accept from a sync.
 *
 * Raw continuous samples are deliberately refused. A worn watch emits a reading every few
 * seconds — hundreds of thousands of rows per person per year — and nothing in the design
 * plots them. The screens need the day's minimum, maximum, average, resting figure and zone
 * minutes, all of which arrive as a `days[]` summary the client computes on the device.
 * What lands in `HeartRateSample` is only what the history list actually renders.
 */
const ACCEPTED_HR_CONTEXTS = ['resting', 'active', 'recovery', 'sleeping', 'manual'];

/**
 * Build the upsert for one row.
 *
 * `$setOnInsert` guards the fields a person may have edited after the row first synced —
 * their effort rating, their notes, the analysis they were shown. Re-syncing the same
 * workout must not wipe what they added to it.
 */
const upsertOp = ({ filter, set, setOnInsert }) => ({
    updateOne: {
        filter,
        update: { $set: set, $setOnInsert: setOnInsert },
        upsert: true,
    },
});

/** Normalise and upsert workouts. Returns the days touched. */
const ingestActivities = async (userId, rows = [], { source, tzOffset }) => {
    const ops = [];
    const days = new Set();

    for (const row of rows) {
        if (!row?.startedAt) continue;

        const startedAt = new Date(row.startedAt);
        if (Number.isNaN(startedAt.getTime())) continue;

        const endedAt = row.endedAt ? new Date(row.endedAt) : null;
        const day = resolveDay(row.day, startedAt, tzOffset);
        const durationSec = Number.isFinite(row.durationSec)
            ? Math.max(0, Math.round(row.durationSec))
            : (endedAt ? Math.max(0, Math.round((endedAt - startedAt) / 1000)) : 0);

        // A zero-length workout is a health store artefact, not something a person did.
        if (durationSec <= 0) continue;

        days.add(day);

        const set = {
            userId,
            type: normaliseType(row.type),
            startedAt,
            endedAt,
            day,
            durationSec,
            distanceM: row.distanceM ?? undefined,
            activeKcal: row.activeKcal ?? undefined,
            elevationM: row.elevationM ?? undefined,
            avgBpm: row.avgBpm ?? undefined,
            maxBpm: row.maxBpm ?? undefined,
            cadence: row.cadence ?? undefined,
            source,
            externalId: row.externalId || null,
            sourceDevice: row.sourceDevice || undefined,
        };
        // Mongo rejects an update that sets and setOnInsert the same path, so only fields
        // the sync never owns belong in the insert half.
        const setOnInsert = { effort: undefined, notes: undefined, scoreDelta: 0 };
        for (const k of Object.keys(setOnInsert)) {
            if (setOnInsert[k] === undefined) delete setOnInsert[k];
        }

        ops.push(upsertOp({
            filter: row.externalId
                ? { userId, source, externalId: row.externalId }
                : { userId, source, startedAt, type: set.type },
            set,
            setOnInsert,
        }));
    }

    if (ops.length) await ActivitySession.bulkWrite(ops, { ordered: false });
    return days;
};

/**
 * Normalise and upsert nights.
 *
 * The wake day is the filing day — see the note on `SleepSession`. Stage totals are derived
 * from the segments when they are present so the hypnogram and the numbers beneath it can
 * never disagree; when a source gives only totals, those are taken as sent.
 */
const ingestSleep = async (userId, rows = [], { source, tzOffset, goalMinutes }) => {
    const ops = [];
    const days = new Set();

    for (const row of rows) {
        if (!row?.startedAt || !row?.endedAt) continue;

        const startedAt = new Date(row.startedAt);
        const endedAt = new Date(row.endedAt);
        if (Number.isNaN(startedAt.getTime()) || Number.isNaN(endedAt.getTime())) continue;
        if (endedAt <= startedAt) continue;

        // The wake day, not the day they went to bed.
        const day = resolveDay(row.day, endedAt, tzOffset);
        days.add(day);

        const segments = Array.isArray(row.segments) ? row.segments.filter(
            (s) => s?.stage && s?.startedAt && s?.endedAt
        ) : [];

        const stageTotal = (stage) => segments
            .filter((s) => s.stage === stage)
            .reduce((sum, s) => sum + minutesBetween(s.startedAt, s.endedAt), 0);

        const stages = segments.length
            ? {
                deepMin: stageTotal('deep'),
                remMin: stageTotal('rem'),
                lightMin: stageTotal('light'),
                awakeMin: stageTotal('awake'),
            }
            : {
                deepMin: row.stages?.deepMin ?? null,
                remMin: row.stages?.remMin ?? null,
                lightMin: row.stages?.lightMin ?? null,
                awakeMin: row.stages?.awakeMin ?? null,
            };

        const inBedMin = Number.isFinite(row.inBedMin)
            ? row.inBedMin
            : minutesBetween(startedAt, endedAt);

        const asleepMin = Number.isFinite(row.asleepMin)
            ? row.asleepMin
            : (segments.length
                ? Math.max(0, inBedMin - (stages.awakeMin || 0))
                : inBedMin);

        // Efficiency is only meaningful when both halves are known. Assuming 100% for a
        // source that never reported time awake would flatter every night it recorded.
        const efficiency = (inBedMin > 0 && Number.isFinite(asleepMin) && segments.length)
            ? Math.min(100, Math.round((asleepMin / inBedMin) * 100))
            : null;

        const score = scoreNight({ asleepMin, efficiency, stages, goalMinutes });

        days.add(day);
        ops.push(upsertOp({
            filter: row.externalId
                ? { userId, source, externalId: row.externalId }
                : { userId, source, endedAt },
            set: {
                userId,
                startedAt,
                endedAt,
                day,
                asleepMin,
                inBedMin,
                stages,
                segments,
                efficiency,
                score,
                source,
                externalId: row.externalId || null,
                sourceDevice: row.sourceDevice || undefined,
            },
            setOnInsert: { scoreDelta: 0 },
        }));
    }

    if (ops.length) await SleepSession.bulkWrite(ops, { ordered: false });
    return days;
};

/** Normalise and upsert the labelled heart-rate readings. Raw streams are refused above. */
const ingestHeart = async (userId, rows = [], { source, tzOffset }) => {
    const ops = [];
    const days = new Set();
    let rejected = 0;

    for (const row of rows) {
        const bpm = Number(row?.bpm);
        if (!row?.measuredAt || !Number.isFinite(bpm) || bpm < 20 || bpm > 300) continue;

        if (!ACCEPTED_HR_CONTEXTS.includes(row.context)) { rejected += 1; continue; }

        const measuredAt = new Date(row.measuredAt);
        if (Number.isNaN(measuredAt.getTime())) continue;

        const day = resolveDay(row.day, measuredAt, tzOffset);
        days.add(day);

        ops.push(upsertOp({
            filter: row.externalId
                ? { userId, source, externalId: row.externalId }
                : { userId, source, measuredAt, context: row.context },
            set: {
                userId,
                measuredAt,
                day,
                bpm: Math.round(bpm),
                context: row.context,
                source,
                externalId: row.externalId || null,
                sourceDevice: row.sourceDevice || undefined,
            },
            setOnInsert: {},
        }));
    }

    if (ops.length) await HeartRateSample.bulkWrite(ops, { ordered: false });
    return { days, rejected };
};

/**
 * Whole-day figures the store reports directly rather than as sessions — steps, resting
 * energy, the day's heart-rate spread, HRV.
 *
 * Held separately from the session-derived totals because they answer a different question.
 * Steps are not the sum of workouts, and a day with no workouts still has steps.
 */
const ingestDaySummaries = async (userId, rows = []) => {
    const days = new Set();

    for (const row of rows) {
        if (!isDayString(row?.day)) continue;
        days.add(row.day);

        const set = { reportedAt: new Date() };
        const put = (path, value) => {
            if (value === undefined || value === null) return;
            set[path] = value;
        };

        put('activity.steps', row.steps);
        put('activity.activeKcal', row.activeKcal);
        put('activity.restingKcal', row.restingKcal);
        put('activity.exerciseMin', row.exerciseMin);
        put('activity.distanceM', row.distanceM);
        put('activity.floors', row.floors);
        put('heart.restingBpm', row.restingBpm);
        put('heart.minBpm', row.minBpm);
        put('heart.maxBpm', row.maxBpm);
        put('heart.avgBpm', row.avgBpm);
        put('heart.hrvMs', row.hrvMs);
        if (Array.isArray(row.zoneMinutes)) set['heart.zoneMinutes'] = row.zoneMinutes;

        await DailyMetrics.updateOne(
            { userId, day: row.day },
            { $set: set, $setOnInsert: { userId, day: row.day } },
            { upsert: true }
        );
    }

    return days;
};

/**
 * Rebuild one day's rollup from the rows that belong to it.
 *
 * Reads rather than accumulates, so a retried sync, a corrected session and a deleted row
 * all converge on the same answer. The whole-day figures a source reported directly
 * (`ingestDaySummaries`) are left alone — steps are not derived from workouts.
 *
 * Session points are recomputed here rather than written at ingest, and that placement is
 * load-bearing. `scoreSession` reads duration *and* the effort the person rated, and effort
 * only exists after the row has been synced — so a sync that wrote the score would have to
 * either overwrite someone's effort bonus every time the workout came round again, or go
 * stale the moment they rated it. Deriving it from the row it belongs to, on every
 * recompute, makes it a pure function of that row and immune to sync ordering.
 */
const recomputeDay = async (userId, day) => {
    const [sessions, nights, samples] = await Promise.all([
        ActivitySession.find({ userId, day }).select('durationSec distanceM activeKcal effort scoreDelta').lean(),
        SleepSession.find({ userId, day }).select('asleepMin inBedMin stages efficiency score').lean(),
        HeartRateSample.find({ userId, day }).select('bpm context').lean(),
    ]);

    const set = { recomputedAt: new Date() };

    set['activity.sessions'] = sessions.length;
    if (sessions.length) {
        set['activity.exerciseMin'] = Math.round(
            sessions.reduce((s, x) => s + (x.durationSec || 0), 0) / 60
        );

        // Write back only the ones that actually moved, so a recompute over an unchanged
        // day costs nothing.
        const drifted = [];
        let total = 0;
        for (const s of sessions) {
            const points = scoreSession({ durationSec: s.durationSec, effort: s.effort });
            total += points;
            if (points !== (s.scoreDelta || 0)) {
                drifted.push({
                    updateOne: { filter: { _id: s._id }, update: { $set: { scoreDelta: points } } },
                });
            }
        }
        if (drifted.length) await ActivitySession.bulkWrite(drifted, { ordered: false });

        set['activity.score'] = total;
    }

    set['sleep.sessions'] = nights.length;
    if (nights.length) {
        // The longest night is the night. Several rows for one day happens when a watch
        // splits a disturbed night, and summing them would count a nap as more sleep than
        // it was; the design shows one figure per day.
        const main = nights.slice().sort((a, b) => (b.asleepMin || 0) - (a.asleepMin || 0))[0];
        set['sleep.asleepMin'] = main.asleepMin ?? null;
        set['sleep.inBedMin'] = main.inBedMin ?? null;
        set['sleep.deepMin'] = main.stages?.deepMin ?? null;
        set['sleep.remMin'] = main.stages?.remMin ?? null;
        set['sleep.lightMin'] = main.stages?.lightMin ?? null;
        set['sleep.awakeMin'] = main.stages?.awakeMin ?? null;
        set['sleep.efficiency'] = main.efficiency ?? null;
        set['sleep.score'] = main.score ?? null;
    }

    set['heart.samples'] = samples.length;
    if (samples.length) {
        const bpms = samples.map((s) => s.bpm);
        set['heart.minBpm'] = Math.min(...bpms);
        set['heart.maxBpm'] = Math.max(...bpms);
        set['heart.avgBpm'] = Math.round(bpms.reduce((a, b) => a + b, 0) / bpms.length);

        const resting = samples.filter((s) => s.context === 'resting').map((s) => s.bpm);
        if (resting.length) {
            set['heart.restingBpm'] = Math.round(resting.reduce((a, b) => a + b, 0) / resting.length);
        }
    }

    await DailyMetrics.updateOne(
        { userId, day },
        { $set: set, $setOnInsert: { userId, day } },
        { upsert: true }
    );
};

/**
 * Take one sync batch from a device.
 *
 * @param {object}  args
 * @param {string}  args.userId
 * @param {string}  args.platform      'apple_health' | 'health_connect' | 'aggregator'
 * @param {number}  args.tzOffset      the client's `getTimezoneOffset()`
 * @param {Array}   [args.activities]
 * @param {Array}   [args.sleep]
 * @param {Array}   [args.heart]       labelled readings only; raw streams are dropped
 * @param {Array}   [args.days]        whole-day figures the store reported directly
 * @param {number}  [args.goalMinutes] the person's sleep goal, for scoring the nights
 * @returns {Promise<{counts: object, days: string[], rejectedHeartSamples: number}>}
 */
const ingestBatch = async ({
    userId, platform, tzOffset, activities = [], sleep = [], heart = [], days = [], goalMinutes,
}) => {
    const source = platform === 'aggregator' ? 'aggregator' : platform;
    const id = new mongoose.Types.ObjectId(String(userId));
    const touched = new Set();

    const activityDays = await ingestActivities(id, activities, { source, tzOffset });
    const sleepDays = await ingestSleep(id, sleep, { source, tzOffset, goalMinutes });
    const { days: heartDays, rejected } = await ingestHeart(id, heart, { source, tzOffset });
    const summaryDays = await ingestDaySummaries(id, days);

    for (const set of [activityDays, sleepDays, heartDays, summaryDays]) {
        for (const d of set) touched.add(d);
    }

    // Rollups after every row is in place, so a day containing both a workout and a night
    // is recomputed once with all of it visible.
    for (const day of touched) await recomputeDay(id, day);

    return {
        counts: {
            activities: activities.length,
            sleep: sleep.length,
            heart: heart.length,
            days: days.length,
        },
        days: [...touched].sort(),
        rejectedHeartSamples: rejected,
    };
};

module.exports = {
    ingestBatch,
    recomputeDay,
    localDay,
    resolveDay,
    normaliseType,
    isDayString,
    ACCEPTED_HR_CONTEXTS,
};
