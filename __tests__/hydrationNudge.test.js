/**
 * The afternoon hydration nudge — and every way it could become a nag.
 *
 * Nobody asked for this notification, so each test here is a reason it must stay quiet:
 * the wrong hour, an unknown clock, a drink already logged, somebody who does not track
 * water, a second nudge in a day, and a person who has stopped answering.
 */
const mongoose = require('mongoose');

jest.mock('../utils/pushSender', () => {
    const actual = jest.requireActual('../utils/pushSender');
    return {
        ...actual,
        send: jest.fn(async (messages) => ({ sent: messages.length, failed: 0, pruned: 0 })),
    };
});

const pushSender = require('../utils/pushSender');
const User = require('../models/userModel');
const MetricLog = require('../models/MetricLog');
const Notification = require('../models/Notification');
const { registerToken } = require('../controllers/notificationController');
const {
    runHydrationNudges, MESSAGES, _offsetFor, _MAX_UNANSWERED,
} = require('../jobs/hydrationNudgeJob');

const TOKEN = 'ExponentPushToken[hydrationxxxxxxxxxxxxx]';

/** 14:10 UTC on 2026-09-22 — ten minutes into the window for somebody on UTC. */
const AFTERNOON = new Date('2026-09-22T14:10:00.000Z');

const makeUser = (tzOffset = 0, over = {}) => User.create({
    username: `u${new mongoose.Types.ObjectId()}`,
    email: `${new mongoose.Types.ObjectId()}@example.com`,
    supabaseId: String(new mongoose.Types.ObjectId()),
    pushTokens: [{ token: TOKEN, platform: 'ios', tzOffset }],
    ...over,
});

const logWater = (userId, day, time = '10:00:00') => MetricLog.create({
    userId, kind: 'water', day, measuredAt: new Date(`${day}T${time}.000Z`), ml: 250,
});

/** Somebody with a habit: two recent days logged, nothing today. */
const tracker = async (tzOffset = 0, over) => {
    const user = await makeUser(tzOffset, over);
    await logWater(user._id, '2026-09-20');
    await logWater(user._id, '2026-09-21');
    return user;
};

beforeEach(async () => {
    pushSender.send.mockClear();
    await Promise.all([User.deleteMany({}), MetricLog.deleteMany({}), Notification.deleteMany({})]);
});

describe('who gets nudged, and when', () => {
    it('nudges a person who tracks water and has logged none today, at 14:00 local', async () => {
        const user = await tracker();

        const result = await runHydrationNudges(AFTERNOON);

        expect(result.nudged).toBe(1);
        expect(pushSender.send).toHaveBeenCalledTimes(1);

        const card = await Notification.findOne({ userId: user._id }).lean();
        expect(card.category).toBe('hydration');
        expect(card.dedupeKey).toBe('hydration:2026-09-22');
        // The push lands on the log screen; the card offers both the log and the page.
        expect(card.route).toBe('/metrics/log/water');
        expect(card.actions.map((a) => a.route)).toEqual(['/metrics/log/water', '/metrics/water']);
        expect(card.pushedAt).not.toBeNull();
    });

    it('uses the phone\'s clock, not the server\'s', async () => {
        // UTC-7: 14:10 UTC is 07:10 there. Too early — a day with no logs means nothing yet.
        await tracker(420);
        expect((await runHydrationNudges(AFTERNOON)).skipped.not_now).toBe(1);

        // 21:10 UTC is 14:10 in UTC-7.
        const result = await runHydrationNudges(new Date('2026-09-22T21:10:00.000Z'));
        expect(result.nudged).toBe(1);
    });

    it('writes the afternoon off rather than sending it at dusk', async () => {
        await tracker();
        const result = await runHydrationNudges(new Date('2026-09-22T16:30:00.000Z'));
        expect(result.nudged).toBe(0);
        expect(result.skipped.not_now).toBe(1);
    });

    it('sends nothing when no device has reported its clock', async () => {
        const user = await makeUser(null);
        await logWater(user._id, '2026-09-20');
        await logWater(user._id, '2026-09-21');

        const result = await runHydrationNudges(AFTERNOON);
        expect(result.skipped.no_clock).toBe(1);
        expect(await Notification.countDocuments()).toBe(0);
    });

    it('stays quiet once anything is logged today', async () => {
        const user = await tracker();
        await logWater(user._id, '2026-09-22', '08:30:00');

        const result = await runHydrationNudges(AFTERNOON);
        expect(result.skipped.logged_today).toBe(1);
        expect(pushSender.send).not.toHaveBeenCalled();
    });

    it('never nudges somebody who has not taken up water tracking', async () => {
        const user = await makeUser(0);
        // One day in a fortnight is trying the feature, not tracking with it.
        await logWater(user._id, '2026-09-15');

        const result = await runHydrationNudges(AFTERNOON);
        expect(result.skipped.not_tracking).toBe(1);
    });

    it('nudges at most once a day, however often the sweep runs', async () => {
        await tracker();
        await runHydrationNudges(AFTERNOON);
        const again = await runHydrationNudges(new Date('2026-09-22T14:25:00.000Z'));

        expect(again.skipped.already_nudged).toBe(1);
        expect(pushSender.send).toHaveBeenCalledTimes(1);
        expect(await Notification.countDocuments()).toBe(1);
    });

    it('goes quiet after repeated unanswered nudges, and resumes once they log again', async () => {
        const user = await tracker();
        for (let i = 0; i < _MAX_UNANSWERED; i += 1) {
            await Notification.create({
                userId: user._id,
                category: 'hydration',
                title: 't',
                body: 'b',
                route: '/metrics/log/water',
                source: 'hydrationNudgeJob',
                dedupeKey: `hydration:old-${i}`,
            });
        }

        expect((await runHydrationNudges(AFTERNOON)).skipped.backed_off).toBe(1);

        // Those nudges predate yesterday's drink, so they were answered. Written through the
        // driver because Mongoose treats `createdAt` as immutable.
        await Notification.collection.updateMany({}, { $set: { createdAt: new Date('2026-09-21T09:00:00.000Z') } });

        expect((await runHydrationNudges(AFTERNOON)).nudged).toBe(1);
    });

    it('respects a quiet window that covers the afternoon, keeping the card', async () => {
        await tracker(0, {
            notificationPreferences: { quietHours: { start: 13, end: 17 } },
        });

        await runHydrationNudges(AFTERNOON);

        expect(pushSender.send).not.toHaveBeenCalled();
        const card = await Notification.findOne().lean();
        expect(card.suppressedReason).toBe('quiet_hours');
    });
});

describe('the wording', () => {
    it('is soft: no numbers, no verdicts, and it fits the card', () => {
        for (const { title, body } of MESSAGES) {
            expect(title.length).toBeLessThanOrEqual(80);
            expect(body.length).toBeLessThanOrEqual(240);
            // A figure turns a nudge into a quota.
            expect(`${title} ${body}`).not.toMatch(/\d/);
            // A fact about the log, never a claim about the person.
            expect(`${title} ${body}`).not.toMatch(/dehydrat|should|must|failed|missed your/i);
            expect(body).toMatch(/logged yet today/);
        }
    });
});

describe('the clock comes from the phone', () => {
    it('stores a plausible offset at registration and drops an implausible one', async () => {
        const user = await makeUser(0, { pushTokens: [] });
        const res = { status() { return this; }, json() { return this; } };

        await registerToken({ auth: { userId: user._id }, body: { token: TOKEN, platform: 'ios', tzOffset: -60 } }, res);
        let row = await User.findById(user._id).lean();
        expect(row.pushTokens[0].tzOffset).toBe(-60);

        await registerToken({ auth: { userId: user._id }, body: { token: TOKEN, platform: 'ios', tzOffset: 9999 } }, res);
        row = await User.findById(user._id).lean();
        expect(row.pushTokens[0].tzOffset).toBeNull();
    });

    it('reads the most recently registered device', () => {
        const offset = _offsetFor({
            pushTokens: [
                { tzOffset: 0, registeredAt: new Date('2026-09-01') },
                { tzOffset: -120, registeredAt: new Date('2026-09-20') },
                { tzOffset: null, registeredAt: new Date('2026-09-21') },
            ],
        });
        expect(offset).toBe(-120);
    });
});
