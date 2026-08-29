/**
 * Device sync — the two things that will otherwise go wrong.
 *
 * A watch and the phone paired to it both write the same workout, and the client re-syncs
 * on every foreground, so a row arriving twice is the normal case. And a calendar day is a
 * local question: grouping by UTC files an evening run in the Americas under the following
 * day, on the one screen the whole feature is built around.
 *
 * Both are silent failures. Neither throws, and both are only visible as numbers a person
 * knows are wrong.
 */
const mongoose = require('mongoose');
const ActivitySession = require('../models/ActivitySession');
const SleepSession = require('../models/SleepSession');
const HeartRateSample = require('../models/HeartRateSample');
const DailyMetrics = require('../models/DailyMetrics');
const { ingestBatch, recomputeDay, localDay, normaliseType } = require('../utils/healthSync');
const { scoreNight, bandFor, BANDS } = require('../utils/sleepScore');

const userId = () => new mongoose.Types.ObjectId();

const workout = (over = {}) => ({
    externalId: 'HK-1234',
    type: 'HKWorkoutActivityTypeRunning',
    startedAt: '2026-08-20T09:00:00.000Z',
    endedAt: '2026-08-20T09:30:00.000Z',
    durationSec: 1800,
    distanceM: 5000,
    activeKcal: 320,
    ...over,
});

describe('de-duplication', () => {
    it('syncing the same workout twice leaves one session and one day total', async () => {
        const id = userId();

        await ingestBatch({
            userId: id, platform: 'healthkit', tzOffset: 0, activities: [workout()],
        });
        await ingestBatch({
            userId: id, platform: 'healthkit', tzOffset: 0, activities: [workout()],
        });

        expect(await ActivitySession.countDocuments({ userId: id })).toBe(1);

        const rollup = await DailyMetrics.findOne({ userId: id, day: '2026-08-20' }).lean();
        expect(rollup.activity.sessions).toBe(1);
        expect(rollup.activity.exerciseMin).toBe(30);
    });

    it('a corrected re-sync updates the row rather than adding one', async () => {
        const id = userId();

        await ingestBatch({
            userId: id, platform: 'healthkit', tzOffset: 0, activities: [workout()],
        });
        await ingestBatch({
            userId: id,
            platform: 'healthkit',
            tzOffset: 0,
            activities: [workout({ distanceM: 5400, activeKcal: 350 })],
        });

        const sessions = await ActivitySession.find({ userId: id }).lean();
        expect(sessions).toHaveLength(1);
        expect(sessions[0].distanceM).toBe(5400);
    });

    it('keeps what the person added when the same workout syncs again', async () => {
        const id = userId();
        await ingestBatch({
            userId: id, platform: 'healthkit', tzOffset: 0, activities: [workout()],
        });

        await ActivitySession.updateOne(
            { userId: id, externalId: 'HK-1234' },
            { $set: { effort: 4, notes: 'Felt strong' } }
        );

        await ingestBatch({
            userId: id, platform: 'healthkit', tzOffset: 0, activities: [workout()],
        });

        const session = await ActivitySession.findOne({ userId: id }).lean();
        // A sync overwriting someone's own effort rating is data loss they will notice
        expect(session.effort).toBe(4);
        expect(session.notes).toBe('Felt strong');
    });

    it('manual sessions carry no external id and never collide', async () => {
        const id = userId();

        await ActivitySession.create([
            {
                userId: id, type: 'yoga', startedAt: new Date('2026-08-20T07:00:00Z'),
                day: '2026-08-20', durationSec: 1200, source: 'manual',
            },
            {
                userId: id, type: 'walking', startedAt: new Date('2026-08-20T18:00:00Z'),
                day: '2026-08-20', durationSec: 1800, source: 'manual',
            },
        ]);

        expect(await ActivitySession.countDocuments({ userId: id })).toBe(2);
    });
});

describe('local calendar days', () => {
    it('files an evening session under the local day, not the UTC one', () => {
        // 20:00 on 2026-08-20 in UTC-8 is 04:00 on the 21st in UTC
        const instant = '2026-08-21T04:00:00.000Z';
        expect(localDay(instant, 480)).toBe('2026-08-20');
        expect(localDay(instant, 0)).toBe('2026-08-21');
    });

    it('a workout at 20:00 UTC-8 rolls up on that local day', async () => {
        const id = userId();

        await ingestBatch({
            userId: id,
            platform: 'healthkit',
            tzOffset: 480, // UTC-8, as getTimezoneOffset() reports it
            activities: [workout({
                externalId: 'HK-EVENING',
                startedAt: '2026-08-21T04:00:00.000Z',
                endedAt: '2026-08-21T04:30:00.000Z',
            })],
        });

        const session = await ActivitySession.findOne({ userId: id }).lean();
        expect(session.day).toBe('2026-08-20');

        expect(await DailyMetrics.findOne({ userId: id, day: '2026-08-21' })).toBeNull();
    });
});

describe('sleep files under the wake day', () => {
    it('a night spanning midnight belongs to the morning it ended', async () => {
        const id = userId();

        await ingestBatch({
            userId: id,
            platform: 'health_connect',
            tzOffset: 0,
            sleep: [{
                externalId: 'HC-NIGHT-1',
                startedAt: '2026-08-20T23:40:00.000Z',
                endedAt: '2026-08-21T07:10:00.000Z',
                segments: [
                    { stage: 'light', startedAt: '2026-08-20T23:40:00.000Z', endedAt: '2026-08-21T01:40:00.000Z' },
                    { stage: 'deep', startedAt: '2026-08-21T01:40:00.000Z', endedAt: '2026-08-21T03:10:00.000Z' },
                    { stage: 'rem', startedAt: '2026-08-21T03:10:00.000Z', endedAt: '2026-08-21T04:40:00.000Z' },
                    { stage: 'light', startedAt: '2026-08-21T04:40:00.000Z', endedAt: '2026-08-21T06:50:00.000Z' },
                    { stage: 'awake', startedAt: '2026-08-21T06:50:00.000Z', endedAt: '2026-08-21T07:10:00.000Z' },
                ],
            }],
        });

        const night = await SleepSession.findOne({ userId: id }).lean();
        // The row someone taps on Wednesday morning has to be filed under Wednesday
        expect(night.day).toBe('2026-08-21');
        expect(night.stages.deepMin).toBe(90);
        expect(night.stages.remMin).toBe(90);
        expect(night.stages.awakeMin).toBe(20);
        expect(night.asleepMin).toBe(430);
        expect(night.efficiency).toBe(96);
    });

    it('derives stage totals from the segments so the chart and the numbers agree', async () => {
        const id = userId();

        await ingestBatch({
            userId: id,
            platform: 'health_connect',
            tzOffset: 0,
            sleep: [{
                externalId: 'HC-NIGHT-2',
                startedAt: '2026-08-22T23:00:00.000Z',
                endedAt: '2026-08-23T06:00:00.000Z',
                // Totals that disagree with the segments — the segments win, because they
                // are what the hypnogram draws
                stages: { deepMin: 999, remMin: 999, lightMin: 999, awakeMin: 999 },
                segments: [
                    { stage: 'deep', startedAt: '2026-08-22T23:00:00.000Z', endedAt: '2026-08-23T00:00:00.000Z' },
                    { stage: 'light', startedAt: '2026-08-23T00:00:00.000Z', endedAt: '2026-08-23T06:00:00.000Z' },
                ],
            }],
        });

        const night = await SleepSession.findOne({ userId: id }).lean();
        expect(night.stages.deepMin).toBe(60);
        expect(night.stages.lightMin).toBe(360);
    });
});

describe('heart rate ingest refuses raw sample streams', () => {
    it('keeps labelled readings and rejects unlabelled ones', async () => {
        const id = userId();

        const result = await ingestBatch({
            userId: id,
            platform: 'healthkit',
            tzOffset: 0,
            heart: [
                { externalId: 'HR-1', measuredAt: '2026-08-20T08:00:00Z', bpm: 58, context: 'resting' },
                { externalId: 'HR-2', measuredAt: '2026-08-20T09:15:00Z', bpm: 142, context: 'active' },
                // What a continuous stream looks like: no context, thousands of them
                { externalId: 'HR-3', measuredAt: '2026-08-20T09:15:05Z', bpm: 141, context: 'unknown' },
                { externalId: 'HR-4', measuredAt: '2026-08-20T09:15:10Z', bpm: 143 },
            ],
        });

        expect(await HeartRateSample.countDocuments({ userId: id })).toBe(2);
        expect(result.rejectedHeartSamples).toBe(2);
    });

    it('rolls the day up from the readings it kept', async () => {
        const id = userId();

        await ingestBatch({
            userId: id,
            platform: 'healthkit',
            tzOffset: 0,
            heart: [
                { externalId: 'HR-A', measuredAt: '2026-08-20T08:00:00Z', bpm: 56, context: 'resting' },
                { externalId: 'HR-B', measuredAt: '2026-08-20T08:30:00Z', bpm: 60, context: 'resting' },
                { externalId: 'HR-C', measuredAt: '2026-08-20T09:15:00Z', bpm: 150, context: 'active' },
            ],
        });

        const rollup = await DailyMetrics.findOne({ userId: id, day: '2026-08-20' }).lean();
        expect(rollup.heart.minBpm).toBe(56);
        expect(rollup.heart.maxBpm).toBe(150);
        expect(rollup.heart.restingBpm).toBe(58); // resting readings only
    });
});

describe('rollups are recomputed, never accumulated', () => {
    it('a deleted session leaves the day describing what is left', async () => {
        const id = userId();

        await ingestBatch({
            userId: id,
            platform: 'healthkit',
            tzOffset: 0,
            activities: [
                workout({ externalId: 'A', startedAt: '2026-08-20T09:00:00Z', endedAt: '2026-08-20T09:30:00Z' }),
                workout({ externalId: 'B', startedAt: '2026-08-20T18:00:00Z', endedAt: '2026-08-20T18:20:00Z', durationSec: 1200 }),
            ],
        });

        let rollup = await DailyMetrics.findOne({ userId: id, day: '2026-08-20' }).lean();
        expect(rollup.activity.sessions).toBe(2);
        expect(rollup.activity.exerciseMin).toBe(50);

        await ActivitySession.deleteOne({ userId: id, externalId: 'B' });
        await recomputeDay(id, '2026-08-20');

        rollup = await DailyMetrics.findOne({ userId: id, day: '2026-08-20' }).lean();
        expect(rollup.activity.sessions).toBe(1);
        expect(rollup.activity.exerciseMin).toBe(30);
    });

    it('whole-day figures a source reported are not derived from sessions', async () => {
        const id = userId();

        await ingestBatch({
            userId: id,
            platform: 'healthkit',
            tzOffset: 0,
            days: [{ day: '2026-08-20', steps: 11240, restingKcal: 1580 }],
        });

        const rollup = await DailyMetrics.findOne({ userId: id, day: '2026-08-20' }).lean();
        // A day with no workouts still has steps
        expect(rollup.activity.steps).toBe(11240);
        expect(rollup.activity.restingKcal).toBe(1580);
        expect(rollup.activity.sessions).toBe(0);
    });
});

describe('unrecognised activity types survive the sync', () => {
    it('maps the known ones and passes the rest through', async () => {
        const id = userId();

        await ingestBatch({
            userId: id,
            platform: 'healthkit',
            tzOffset: 0,
            activities: [
                workout({ externalId: 'T1', type: 'HKWorkoutActivityTypeRunning' }),
                workout({ externalId: 'T2', type: 'EXERCISE_TYPE_SWIMMING_POOL', startedAt: '2026-08-20T11:00:00Z', endedAt: '2026-08-20T11:40:00Z' }),
                workout({ externalId: 'T3', type: 'Kitesurfing', startedAt: '2026-08-20T12:00:00Z', endedAt: '2026-08-20T13:00:00Z' }),
            ],
        });

        const types = (await ActivitySession.find({ userId: id }).lean()).map((s) => s.type).sort();
        // The platform prefixes have to come off, or every synced run groups under
        // 'hkworkoutactivitytyperunning'. And an enum would drop the third one entirely.
        expect(types).toEqual(['jogging', 'kitesurfing', 'swimming']);
    });

    it('maps the bare names too, so a manual entry lands in the same bucket', () => {
        expect(normaliseType('Running')).toBe('jogging');
        expect(normaliseType('HKWorkoutActivityTypeRunning')).toBe('jogging');
        expect(normaliseType('EXERCISE_TYPE_RUNNING')).toBe('jogging');
    });
});

describe('sleep score', () => {
    it('is deterministic', () => {
        const night = { asleepMin: 430, efficiency: 96, stages: { deepMin: 90, remMin: 90 }, goalMinutes: 480 };
        expect(scoreNight(night)).toBe(scoreNight(night));
    });

    it('scores out of 100 when the source reported only a total', () => {
        const score = scoreNight({ asleepMin: 470, goalMinutes: 480 });
        // Renormalised, not capped at the duration weight of 60
        expect(score).toBe(100);
    });

    it('never labels anyone with a diagnosis', () => {
        const labels = BANDS.map((b) => b.label);
        expect(labels).not.toContain('Insomniac');
        expect(bandFor(20).label).toBe('Needs attention');
        expect(bandFor(85).key).toBe('good');
    });
});
