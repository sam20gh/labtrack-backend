/**
 * What the activity dashboard is given to draw.
 *
 * The screen once showed two numbers out of the eleven `DailyMetrics` records, because the
 * summary only returned those two. That is the failure this file guards: a phone syncing
 * steps, distance, floors and a full day of heart rate looked, to the person holding it,
 * like a tracker that was not working.
 *
 * The second half is the rule the whole feature turns on — **a figure nobody reported is
 * null, not zero**. A day a watch was not worn and a day of no steps are different facts,
 * and averaging over the range rather than over the days that reported turns the first into
 * a smaller number wearing the word "average".
 */
const mongoose = require('mongoose');
const DailyMetrics = require('../models/DailyMetrics');
const User = require('../models/userModel');
const { getSummary } = require('../controllers/activityController');

/** Today in UTC, which is the local day the controller resolves at `tzOffset` 0. */
const todayUTC = () => new Date().toISOString().slice(0, 10);
const daysAgoUTC = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

const call = async (userId, query = {}) => {
    let body;
    let status = 200;
    const res = {
        json: (payload) => { body = payload; return res; },
        status: (code) => { status = code; return res; },
    };
    await getSummary({ user: { id: String(userId) }, query: { range: '1w', tzOffset: 0, ...query } }, res);
    return { status, body };
};

const seedUser = async () => {
    const suffix = `${Date.now()}${Math.round(Math.random() * 1e6)}`;
    const user = await User.create({
        username: `tester-${suffix}`,
        firstName: 'Test',
        lastName: 'Person',
        email: `u${suffix}@example.com`,
        password: 'hashed',
    });
    return user._id;
};

describe('summary carries every figure the rollup holds', () => {
    it('returns steps, distance, floors, resting energy and the day’s heart rate', async () => {
        const userId = await seedUser();

        await DailyMetrics.create({
            userId,
            day: todayUTC(),
            activity: { steps: 8412, distanceM: 6200, floors: 11, activeKcal: 430, restingKcal: 1580, exerciseMin: 35, sessions: 1 },
            heart: { restingBpm: 58, minBpm: 49, avgBpm: 74, maxBpm: 151, hrvMs: 42, samples: 900 },
        });

        const { status, body } = await call(userId);
        expect(status).toBe(200);

        const day = body.series.find((p) => p.day === todayUTC());
        expect(day).toMatchObject({
            steps: 8412,
            distanceM: 6200,
            floors: 11,
            activeKcal: 430,
            restingKcal: 1580,
            restingBpm: 58,
            minBpm: 49,
            avgBpm: 74,
            maxBpm: 151,
            hrvMs: 42,
        });

        expect(body.totals.steps).toBe(8412);
        expect(body.totals.floors).toBe(11);
        expect(body.totals.restingKcal).toBe(1580);
    });

    it('averages over the days that reported, not over the range', async () => {
        const userId = await seedUser();

        // Two days with steps inside a seven-day window. The average is over the two.
        await DailyMetrics.create({ userId, day: todayUTC(), activity: { steps: 10000 } });
        await DailyMetrics.create({ userId, day: daysAgoUTC(1), activity: { steps: 6000 } });

        const { body } = await call(userId);

        expect(body.averages.steps).toEqual({ value: 8000, days: 2 });
    });
});

describe('missing is not zero', () => {
    it('a day nobody measured is null throughout, not a row of zeros', async () => {
        const userId = await seedUser();
        await DailyMetrics.create({ userId, day: todayUTC(), activity: { steps: 5000 } });

        const { body } = await call(userId);
        const quiet = body.series.find((p) => p.day === daysAgoUTC(3));

        expect(quiet.steps).toBeNull();
        expect(quiet.distanceM).toBeNull();
        expect(quiet.restingBpm).toBeNull();
        // Sessions are a count of rows that exist, so zero is the honest answer there.
        expect(quiet.sessions).toBe(0);
    });

    it('a metric nothing in the range reported has no total and no average', async () => {
        const userId = await seedUser();
        await DailyMetrics.create({ userId, day: todayUTC(), activity: { steps: 5000 } });

        const { body } = await call(userId);

        expect(body.totals.floors).toBeNull();
        expect(body.averages.floors).toBeNull();
        expect(body.averages.restingBpm).toBeNull();
    });
});
