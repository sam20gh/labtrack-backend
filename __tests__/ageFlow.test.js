/**
 * Predyqt Age, end to end.
 *
 * The two unit suites cover the tables. This covers the wiring: that six months of rollups
 * reach the hazard table in the right shape and the right units, that a blood panel reaches
 * the equation, that the two halves blend with the provenance intact, and that a refusal
 * never reaches the snapshot collection the pace regression will read.
 */
const mongoose = require('mongoose');
const User = require('../models/userModel');
const DailyMetrics = require('../models/DailyMetrics');
const ActivitySession = require('../models/ActivitySession');
const SleepSession = require('../models/SleepSession');
const Biomarker = require('../models/Biomarker');
const BiologicalAge = require('../models/BiologicalAge');
const ageProfile = require('../utils/ageProfile');
const ageController = require('../controllers/ageController');

const DAY_MS = 86400000;
let userId;

/** Born 45 years ago, to the day, so every assertion about age is stable. */
const DOB = new Date(Date.now() - 45 * 365.2425 * DAY_MS).toISOString().slice(0, 10);

const dayString = (daysAgo) =>
    new Date(Date.now() - daysAgo * DAY_MS).toISOString().slice(0, 10);

beforeEach(async () => {
    userId = new mongoose.Types.ObjectId();
    await User.create({
        _id: userId,
        username: `u${userId}`,
        email: `${userId}@example.com`,
        password: 'x',
        dob: DOB,
        gender: 'Male',
        height: 178,
    });
});

/** A run of ordinary days, each carrying the same figures. */
const seedDays = async (count, totals, startDaysAgo = 1) => {
    const rows = [];
    for (let i = 0; i < count; i += 1) {
        rows.push({ userId, day: dayString(startDaysAgo + i), ...totals });
    }
    await DailyMetrics.insertMany(rows);
};

/** A complete PhenoAge panel, in canonical units. */
const seedPanel = async (daysAgo = 20, overrides = {}) => {
    const markers = {
        albumin: 45, creatinine: 80, fasting_glucose: 5.0, crp: 1.0,
        lymphocytes_pct: 32, mcv: 90, rdw: 12.8, alp: 70, wbc: 6.0,
        ...overrides,
    };
    await Biomarker.insertMany(Object.entries(markers).map(([name, value]) => ({
        userId, name, value, unit: '', measuredAt: new Date(Date.now() - daysAgo * DAY_MS),
        flag: 'normal', needsReview: false,
    })));
};

describe('gather', () => {
    it('averages over the days that hold data, never over the calendar', async () => {
        // A watch left on a charger is not a day of no steps. Averaging the gap in as zero
        // reports a sedentary half-year to somebody who went on holiday.
        await seedDays(10, { activity: { steps: 9000 } });
        const { inputs } = await ageProfile.gather(userId);

        expect(inputs.steps.value).toBe(9000);
        expect(inputs.steps.days).toBe(10);
    });

    it('takes the median of the figures a watch reports sparsely and noisily', async () => {
        // One morning a watch misreads a resting rate as 110. A mean carries that into
        // somebody's biological age; a median does not.
        await seedDays(6, { heart: { restingBpm: 58 } });
        await DailyMetrics.create({ userId, day: dayString(30), heart: { restingBpm: 110 } });

        const { inputs } = await ageProfile.gather(userId);
        expect(inputs.resting_hr.value).toBe(58);
    });

    it('reads vigorous minutes from heart-rate zones 4 and 5', async () => {
        // `zoneMinutes` is indexed from zone 1, so 4 and 5 are array positions 3 and 4. An
        // off-by-one here does not throw: it silently scores easy jogging as hard effort.
        await seedDays(7, { heart: { zoneMinutes: [100, 60, 30, 12, 3] } });
        const { inputs } = await ageProfile.gather(userId);

        // 15 minutes a day over 7 measured days, expressed weekly.
        expect(inputs.vigorous_minutes.value).toBeCloseTo(105, 0);
    });

    it('spreads strength minutes across the days somebody trained, not only the days they lifted', async () => {
        // Otherwise a person who lifts once a month averages as though they lift daily.
        await ActivitySession.insertMany([
            { userId, type: 'weightlifting', day: dayString(3), startedAt: new Date(Date.now() - 3 * DAY_MS), durationSec: 3600, source: 'manual' },
            { userId, type: 'jogging', day: dayString(4), startedAt: new Date(Date.now() - 4 * DAY_MS), durationSec: 1800, source: 'manual' },
            { userId, type: 'jogging', day: dayString(5), startedAt: new Date(Date.now() - 5 * DAY_MS), durationSec: 1800, source: 'manual' },
            { userId, type: 'jogging', day: dayString(6), startedAt: new Date(Date.now() - 6 * DAY_MS), durationSec: 1800, source: 'manual' },
        ]);
        const { inputs } = await ageProfile.gather(userId);

        // 60 minutes over 4 active days = 15/day = 105/week, not 420.
        expect(inputs.strength_minutes.value).toBeCloseTo(105, 0);
    });

    it('derives BMI from the logged weight and the profile height', async () => {
        await seedDays(4, { body: { weightKg: 82 } });
        const { inputs } = await ageProfile.gather(userId);

        expect(inputs.bmi.value).toBeCloseTo(82 / 1.78 ** 2, 2);
    });

    it('leaves a contributor null rather than zero when nothing measured it', async () => {
        await seedDays(8, { activity: { steps: 7000 } });
        const { inputs } = await ageProfile.gather(userId);

        expect(inputs.vo2max.value).toBeNull();
        expect(inputs.vo2max.days).toBe(0);
        expect(inputs.blood_pressure.value).toBeNull();
    });

    it('measures sleep consistency on the clock, through sleepInsight', async () => {
        // A schedule averaging 23:40 and 00:20 to midday is the failure meanClock exists to
        // prevent, and reimplementing it here would be a second place for it to go wrong.
        const nights = [];
        for (let i = 1; i <= 8; i += 1) {
            const wake = new Date(Date.now() - i * DAY_MS);
            wake.setUTCHours(7, 0, 0, 0);
            const bed = new Date(wake.getTime() - 7.5 * 3600000);
            nights.push({
                userId, day: dayString(i), startedAt: bed, endedAt: wake,
                source: 'manual', asleepMin: 450,
            });
        }
        await SleepSession.insertMany(nights);

        const { inputs } = await ageProfile.gather(userId);
        expect(inputs.sleep_consistency.value).toBeCloseTo(0, 1);
        expect(inputs.sleep_consistency.days).toBe(8);
    });

    it('reads the chronological age off the profile, and refuses an unparseable one', async () => {
        const { chronologicalAge } = await ageProfile.gather(userId);
        expect(chronologicalAge).toBeCloseTo(45, 0);

        await User.updateOne({ _id: userId }, { dob: 'sometime in the eighties' });
        expect((await ageProfile.gather(userId)).chronologicalAge).toBeNull();
    });
});

describe('recompute', () => {
    const goodWeek = {
        activity: { steps: 9500 },
        heart: { restingBpm: 58, vo2Max: 46, zoneMinutes: [80, 50, 25, 10, 2] },
        sleep: { asleepMin: 450 },
        body: { weightKg: 76 },
        bloodPressure: { systolic: 116, diastolic: 74 },
    };

    it('blends both halves and names the provenance', async () => {
        await seedDays(60, goodWeek);
        await seedPanel(20);

        const r = await ageController.recompute(userId);
        expect(r.ok).toBe(true);
        expect(r.source).toBe('blended');
        expect(r.lab.ok).toBe(true);
        expect(r.lifestyle.ok).toBe(true);
        expect(r.weights.lab).toBeGreaterThan(0);
        expect(r.weights.lifestyle).toBeGreaterThan(0);
    });

    it('answers on bloods alone, and says so', async () => {
        await seedPanel(20);
        const r = await ageController.recompute(userId);

        expect(r.source).toBe('lab');
        expect(r.lifestyle.ok).toBe(false);
        expect(r.lifestyle.reason).toBe('insufficient_coverage');
    });

    it('answers on the trackers alone, and says so', async () => {
        await seedDays(60, goodWeek);
        const r = await ageController.recompute(userId);

        expect(r.source).toBe('lifestyle');
        expect(r.lab.ok).toBe(false);
        expect(r.lab.reason).toBe('no_results');
    });

    it('keeps both halves whole, including the one that refused', async () => {
        // "Your bloods are eighteen months old" and "connect a watch" are both things a
        // screen has to be able to say, and neither is derivable from a blended number.
        await seedDays(60, goodWeek);
        const r = await ageController.recompute(userId);

        expect(r.lab.missing).toHaveLength(9);
        expect(r.lab.message).toMatch(/blood test/i);
    });

    it('weights a stale panel down rather than trusting it equally', async () => {
        await seedDays(60, goodWeek);
        await seedPanel(500);
        const stale = await ageController.recompute(userId);

        await Biomarker.deleteMany({ userId });
        await seedPanel(10);
        const fresh = await ageController.recompute(userId);

        expect(stale.weights.lab).toBeLessThan(fresh.weights.lab);
    });

    it('ignores a panel old enough to be about somebody else', async () => {
        await seedDays(60, goodWeek);
        await seedPanel(900);
        const r = await ageController.recompute(userId);

        expect(r.source).toBe('lifestyle');
        expect(r.weights.lab).toBeUndefined();
    });

    it('withholds everything during an acute-phase response rather than ageing somebody for a cough', async () => {
        await seedPanel(10, { crp: 60 });
        const r = await ageController.recompute(userId);

        expect(r.ok).toBe(false);
        expect(r.lab.reason).toBe('acute_phase');
    });
});

describe('snapshots', () => {
    const week = {
        activity: { steps: 8000 },
        heart: { restingBpm: 62, vo2Max: 42 },
        sleep: { asleepMin: 430 },
        body: { weightKg: 80 },
    };

    it('writes a row the pace regression can later read', async () => {
        await seedDays(40, week);
        await ageController.recompute(userId, { trigger: 'manual' });

        const rows = await BiologicalAge.find({ userId }).lean();
        expect(rows).toHaveLength(1);
        expect(rows[0].value).toBeGreaterThan(0);
        expect(rows[0].source).toBe('lifestyle');
        expect(rows[0].trigger).toBe('manual');
        expect(rows[0].halves).toHaveLength(2);
    });

    it('never persists a refusal', async () => {
        // "We cannot say yet" is a state, not a data point. A regression that read one would
        // be fitting a line through an absence.
        const r = await ageController.recompute(userId);
        expect(r.ok).toBe(false);
        expect(await BiologicalAge.countDocuments({ userId })).toBe(0);
    });

    it('folds a second computation into the newest row rather than appending', async () => {
        await seedDays(40, week);
        await ageController.recompute(userId);
        await ageController.recompute(userId);

        expect(await BiologicalAge.countDocuments({ userId })).toBe(1);
    });

    it('appends once the gap has passed', async () => {
        await seedDays(40, week);
        await ageController.recompute(userId);
        await BiologicalAge.updateOne(
            { userId },
            { computedAt: new Date(Date.now() - 2 * DAY_MS) },
        );
        await ageController.recompute(userId);

        expect(await BiologicalAge.countDocuments({ userId })).toBe(2);
    });

    it('stores the refusing half too, so a historic snapshot stays explainable', async () => {
        await seedDays(40, week);
        await ageController.recompute(userId);

        const [row] = await BiologicalAge.find({ userId }).lean();
        const lab = row.halves.find((h) => h.source === 'lab');
        expect(lab.ok).toBe(false);
        expect(lab.reason).toBe('no_results');
        expect(lab.value).toBeNull();
    });
});

describe('what the API never returns', () => {
    it('keeps the mortality score out of every response shape', async () => {
        await seedDays(60, {
            activity: { steps: 9000 }, heart: { restingBpm: 60, vo2Max: 44 },
            sleep: { asleepMin: 440 }, body: { weightKg: 78 },
        });
        await seedPanel(15);

        const result = await ageController.recompute(userId);
        const row = await BiologicalAge.findOne({ userId }).lean();

        for (const payload of [result, row, ageController._fromSnapshot(row)]) {
            expect(JSON.stringify(payload).toLowerCase())
                .not.toMatch(/mortalit|death|survival|life ?expectancy/);
        }
    });
});
