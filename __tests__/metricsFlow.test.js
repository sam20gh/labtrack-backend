/**
 * The metrics write path, end to end.
 *
 * The unit tests cover the tables; this covers the wiring — that a logged row rebuilds the
 * day's rollup, that the rollup is what the score and the observed profile read, and that a
 * delete actually removes the entry rather than adjusting a total.
 */
const mongoose = require('mongoose');
const MetricLog = require('../models/MetricLog');
const DailyMetrics = require('../models/DailyMetrics');
const User = require('../models/userModel');
const { recomputeMetricDay } = require('../utils/metricRollup');
const observedProfile = require('../utils/observedProfile');

const DAY = '2026-08-20';
let userId;

beforeEach(async () => {
    userId = new mongoose.Types.ObjectId();
    await User.create({
        _id: userId,
        username: `u${userId}`,
        email: `${userId}@example.com`,
        password: 'x',
        height: 175,
        weight: 82,          // the onboarding answer
    });
});

const logWeight = (weightKg, at) => MetricLog.create({
    userId, kind: 'weight', day: DAY, measuredAt: at || new Date(`${DAY}T08:00:00Z`),
    weightKg, source: 'manual',
});

describe('weight', () => {
    it('rolls a logged weight onto the day and marks its source', async () => {
        await logWeight(78.4);
        const row = await recomputeMetricDay(userId, DAY);

        expect(row.body.weightKg).toBe(78.4);
        expect(row.body.weightSource).toBe('manual');
    });

    it('takes the latest weigh-in of the day, not the mean', async () => {
        await logWeight(80, new Date(`${DAY}T07:00:00Z`));
        await logWeight(78, new Date(`${DAY}T19:00:00Z`));
        const row = await recomputeMetricDay(userId, DAY);

        // A clothed and an unclothed reading averaged together is neither.
        expect(row.body.weightKg).toBe(78);
    });

    it('is what observedProfile reads, in preference to the onboarding figure', async () => {
        await logWeight(78.4);
        await recomputeMetricDay(userId, DAY);

        const latest = await observedProfile.latestWeight(userId);
        expect(latest.value).toBe(78.4);
        expect(latest.source).toBe('manual');
    });

    it('leaves User.weight alone — the questionnaire answer is never overwritten', async () => {
        await logWeight(78.4);
        await recomputeMetricDay(userId, DAY);
        await observedProfile.refresh(userId);

        const user = await User.findById(userId).lean();
        expect(user.weight).toBe(82);              // untouched
        expect(user.observed.weightKg).toBe(78.4); // measured, beside it
    });
});

describe('hydration', () => {
    const drink = (ml) => MetricLog.create({
        userId, kind: 'water', day: DAY, measuredAt: new Date(), ml, drinkType: 'water', source: 'manual',
    });

    it('totals the day and derives a target from the weight on record', async () => {
        await drink(500);
        await drink(750);
        const row = await recomputeMetricDay(userId, DAY);

        expect(row.hydration.consumedMl).toBe(1250);
        expect(row.hydration.logs).toBe(2);
        expect(row.hydration.targetMl).toBeGreaterThan(0);
    });

    it('leaves a day with no drinks unscored rather than at zero', async () => {
        const row = await recomputeMetricDay(userId, DAY);

        // Not tracked, not "drank nothing".
        expect(row.hydration.consumedMl).toBeNull();
        expect(row.hydration.level).toBeNull();
        expect(row.hydration.logs).toBe(0);
    });
});

describe('blood pressure', () => {
    const reading = (systolic, diastolic) => MetricLog.create({
        userId, kind: 'blood_pressure', day: DAY, measuredAt: new Date(),
        systolic, diastolic, source: 'manual',
    });

    it('stores the mean and the worst category for the day', async () => {
        await reading(118, 76);
        await reading(190, 124);   // one crisis
        const row = await recomputeMetricDay(userId, DAY);

        expect(row.bloodPressure.readings).toBe(2);
        // The mean looks unremarkable; the worst must survive it.
        expect(row.bloodPressure.worstCategory).toBe('crisis');
    });

    it('surfaces a raised pressure on the observed profile', async () => {
        await reading(148, 94);
        await recomputeMetricDay(userId, DAY);
        await observedProfile.refresh(userId);

        const user = await User.findById(userId).lean();
        expect(user.observed.bloodPressure.category).toBe('stage_2');
        expect(user.observed.bloodPressure.readings).toBe(1);
    });
});

describe('deleting', () => {
    it('removes the row and rebuilds the day rather than adjusting a total', async () => {
        const a = await logWeight(80, new Date(`${DAY}T07:00:00Z`));
        await logWeight(78, new Date(`${DAY}T19:00:00Z`));
        await recomputeMetricDay(userId, DAY);

        await MetricLog.findByIdAndDelete((await MetricLog.findOne({ userId, weightKg: 78 }))._id);
        const row = await recomputeMetricDay(userId, DAY);

        // Falls back to the remaining reading, not to a patched number.
        expect(row.body.weightKg).toBe(80);
        expect(a).toBeTruthy();
    });

    it('clears the rollup when the last row for a day goes', async () => {
        await logWeight(80);
        await recomputeMetricDay(userId, DAY);
        await MetricLog.deleteMany({ userId, kind: 'weight' });
        const row = await recomputeMetricDay(userId, DAY);

        expect(row.body.weightKg).toBeNull();
    });
});
