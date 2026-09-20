/**
 * The notification centre.
 *
 * Four things are asserted here, and every one of them is something that was wrong before
 * the inbox existed or would be wrong again the first time somebody simplified it:
 *
 *   1. **A suppressed push still leaves a record.** Quiet hours, a muted channel and an
 *      account with no registered device each used to destroy the notification rather than
 *      the interruption. This is the whole reason `Notification` is a collection.
 *   2. **A producer cannot invent presentation, and a malformed extra costs a decoration
 *      rather than the message.** Icon, tint and the default route come off the table; a
 *      meter with a zero max, a `file://` image and a third action are dropped and the card
 *      is still written.
 *   3. **A re-run is idempotent, and does not un-read what somebody has read.** The sweeps
 *      re-run, and a reminder that came back unread every midnight is a feature people turn
 *      off.
 *   4. **Somebody else's notification answers 404.** A 403 confirms the row exists, which
 *      is the call `middleware/ownership.js` makes.
 */
const mongoose = require('mongoose');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../utils/pushSender', () => {
    const actual = jest.requireActual('../utils/pushSender');
    return {
        ...actual,
        send: jest.fn(async (messages) => ({ sent: messages.length, failed: 0, pruned: 0 })),
    };
});

const pushSender = require('../utils/pushSender');
const User = require('../models/userModel');
const Notification = require('../models/Notification');
const { publish } = require('../utils/notificationCentre');
const { CATEGORIES, CATEGORY_KEYS, TINTS, CHANNELS, pushAllowed } = require('../utils/notificationCatalogue');

const TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]';

const makeUser = (over = {}) => User.create({
    username: `u${new mongoose.Types.ObjectId()}`,
    email: `${new mongoose.Types.ObjectId()}@example.com`,
    supabaseId: String(new mongoose.Types.ObjectId()),
    pushTokens: [{ token: TOKEN, platform: 'ios' }],
    ...over,
});

beforeEach(() => pushSender.send.mockClear());

/* ------------------------------------------------------------------ *
 * The catalogue
 * ------------------------------------------------------------------ */

describe('the category table', () => {
    it('gives every category a route, a channel and a tint the client can paint', () => {
        for (const [key, spec] of Object.entries(CATEGORIES)) {
            // A category with no route is one a person is told about and cannot open — the
            // dead end `PILLAR_ROUTE` exists to prevent on the score screen.
            expect(spec.route).toMatch(/^\//);
            expect(spec.label).toBeTruthy();
            expect(spec.icon).toMatch(/-outline$|^[a-z]/);
            expect(TINTS).toContain(spec.tint);
            // A channel nobody can switch off is a category that gets the feature muted.
            expect(CHANNELS).toContain(spec.channel);
            expect(['normal', 'critical']).toContain(spec.priority);
            expect(key).toBe(key.toLowerCase());
        }
    });

    it('lets only vitals cross quiet hours', () => {
        const critical = CATEGORY_KEYS.filter((k) => CATEGORIES[k].priority === 'critical');
        // Not an arbitrary assertion: the moment a second category calls itself critical,
        // "critical" has started to mean "important to its author" and quiet hours stop
        // working. Adding one is a product decision that should have to edit this line.
        expect(critical).toEqual(['vitals']);
    });

    it('reads the master switch and the per-topic switch, in that order', () => {
        expect(pushAllowed('order', { enabled: true, orderUpdates: true })).toBe(true);
        expect(pushAllowed('order', { enabled: true, orderUpdates: false })).toBe(false);
        expect(pushAllowed('order', { enabled: false, orderUpdates: true })).toBe(false);
        // A category gated on `enabled` alone is not silenced by an unrelated topic switch.
        expect(pushAllowed('sleep', { enabled: true, orderUpdates: false })).toBe(true);
        expect(pushAllowed('not-a-category', { enabled: true })).toBe(false);
    });
});

/* ------------------------------------------------------------------ *
 * publish()
 * ------------------------------------------------------------------ */

describe('publish', () => {
    it('records the notification even when the push is suppressed', async () => {
        // Quiet hours: 00:00–23:00 covers whatever hour this suite happens to run at.
        const user = await makeUser({
            notificationPreferences: { enabled: true, quietHours: { start: 0, end: 23 } },
        });

        const { notification, pushed } = await publish(user._id, {
            category: 'plan',
            title: 'Due today',
            body: 'Your lipid panel is due today.',
        });

        expect(pushed).toBe(0);
        expect(pushSender.send).not.toHaveBeenCalled();
        expect(notification).toBeTruthy();
        expect(notification.suppressedReason).toBe('quiet_hours');
        expect(notification.readAt).toBeNull();
        // The card is there. This is the defect the whole collection exists to fix.
        expect(await Notification.countDocuments({ userId: user._id })).toBe(1);
    });

    it('records it when the channel is off, and when there is no device at all', async () => {
        const muted = await makeUser({
            notificationPreferences: { enabled: true, orderUpdates: false, quietHours: { start: 22, end: 22 } },
        });
        const r1 = await publish(muted._id, { category: 'order', title: 'Shipped', body: 'On its way.' });
        expect(r1.pushed).toBe(0);
        expect(r1.notification.suppressedReason).toBe('channel_off');

        const deviceless = await makeUser({
            pushTokens: [],
            notificationPreferences: { enabled: true, quietHours: { start: 22, end: 22 } },
        });
        const r2 = await publish(deviceless._id, { category: 'results', title: 'Ready', body: 'Your results are in.' });
        expect(r2.pushed).toBe(0);
        expect(r2.notification.suppressedReason).toBe('no_device');
        expect(await Notification.countDocuments({ userId: deviceless._id })).toBe(1);
    });

    it('lets a critical category through quiet hours and a normal one not', async () => {
        const user = await makeUser({
            notificationPreferences: { enabled: true, quietHours: { start: 0, end: 23 } },
        });

        const quiet = await publish(user._id, { category: 'sleep', title: 'Bedtime', body: 'Wind down.' });
        expect(quiet.pushed).toBe(0);

        const loud = await publish(user._id, {
            category: 'vitals',
            title: 'Blood pressure is very high',
            body: 'The reading you just logged is in the crisis band. Seek care now.',
        });
        expect(loud.pushed).toBe(1);
        expect(loud.notification.pushedAt).toBeInstanceOf(Date);
    });

    it('takes presentation from the table, not from the producer', async () => {
        const user = await makeUser({ notificationPreferences: { enabled: true, quietHours: { start: 22, end: 22 } } });
        const { notification } = await publish(user._id, {
            category: 'hydration',
            title: 'Time to hydrate',
            body: 'You need 750ml more today.',
            // No route supplied: the category's own is used rather than nothing.
        });
        expect(notification.route).toBe(CATEGORIES.hydration.route);
    });

    it('drops a malformed extra and keeps the message', async () => {
        const user = await makeUser({ notificationPreferences: { enabled: true, quietHours: { start: 22, end: 22 } } });
        const { notification } = await publish(user._id, {
            category: 'hydration',
            title: 'Time to hydrate',
            body: 'You need 750ml more today.',
            // Every one of these is wrong in a different way.
            route: 'https://example.com/not-an-app-route',
            meter: { value: 1650, max: 0 },
            imageUrl: 'file:///var/cache/photo.jpg',
            actions: [
                { label: 'Log water', route: '/metrics/log/water', tone: 'primary' },
                { label: 'Broken', route: 'nowhere' },
                { label: 'Hydration', route: '/metrics' },
                { label: 'Fourth', route: '/metrics' },
            ],
        });

        expect(notification.route).toBe(CATEGORIES.hydration.route);
        expect(notification.meter).toBeNull();
        expect(notification.imageUrl).toBeNull();
        /**
         * The cap counts what survives, not what was offered. The unopenable action is
         * dropped and the one behind it moves up into the slot it freed — right, because
         * the two-action limit is a fact about what the card *draws*, and silently
         * rendering one button when two were valid would be a stricter rule than the
         * layout needs.
         */
        expect(notification.actions.map((a) => a.label)).toEqual(['Log water', 'Hydration']);
        // And the notification itself still exists, which is the point.
        expect(notification.title).toBe('Time to hydrate');
    });

    it('keeps a good meter, chip and image', async () => {
        const user = await makeUser({ notificationPreferences: { enabled: true, quietHours: { start: 22, end: 22 } } });
        const { notification } = await publish(user._id, {
            category: 'vitals',
            title: 'Blood Pressure Insight',
            body: 'You just gained +3% higher blood pressure today.',
            meter: { value: 1650, max: 2400, label: '750ml to go' },
            chip: { label: '128/80mmHg', icon: 'pulse-outline' },
            imageUrl: 'https://imagedelivery.net/hash/id/public',
        });
        expect(notification.meter.value).toBe(1650);
        expect(notification.chip.label).toBe('128/80mmHg');
        expect(notification.imageUrl).toMatch(/^https:/);
    });

    it('is idempotent on a dedupe key and does not drag a read card back to unread', async () => {
        const user = await makeUser({ notificationPreferences: { enabled: true, quietHours: { start: 22, end: 22 } } });
        const payload = {
            category: 'plan',
            title: 'Coming up',
            body: 'Lipid panel is due in 7 days.',
            dedupeKey: 'plan:abc:7',
            reviveOnUpdate: true,
        };

        await publish(user._id, payload);
        await Notification.updateOne({ userId: user._id }, { readAt: new Date() });

        // The same sweep runs again saying exactly the same thing.
        await publish(user._id, payload);
        expect(await Notification.countDocuments({ userId: user._id })).toBe(1);
        const unchanged = await Notification.findOne({ userId: user._id });
        expect(unchanged.readAt).not.toBeNull();

        // Now the wording genuinely moves — a different thing to say, so it comes back.
        await publish(user._id, { ...payload, title: 'Overdue health check', body: 'Lipid panel was due 2 days ago.' });
        expect(await Notification.countDocuments({ userId: user._id })).toBe(1);
        const revived = await Notification.findOne({ userId: user._id });
        expect(revived.readAt).toBeNull();
        expect(revived.title).toBe('Overdue health check');
    });

    it('never throws at the caller', async () => {
        // An unknown category, a missing body, and a user that does not exist. Each returns
        // rather than rejecting: a scoring or notification bug must not be able to fail the
        // write the person actually made. Same contract `scoreController.touch` has.
        await expect(publish(new mongoose.Types.ObjectId(), { category: 'nope', title: 'a', body: 'b' }))
            .resolves.toEqual({ notification: null, pushed: 0 });
        await expect(publish(new mongoose.Types.ObjectId(), { category: 'plan', title: 'a' }))
            .resolves.toEqual({ notification: null, pushed: 0 });
        await expect(publish(new mongoose.Types.ObjectId(), { category: 'plan', title: 'a', body: 'b' }))
            .resolves.toMatchObject({ pushed: 0 });
    });

    it('records a batch sender\'s own delivery rather than sending a second push', async () => {
        const user = await makeUser({ notificationPreferences: { enabled: true, quietHours: { start: 22, end: 22 } } });
        const at = new Date();
        const { notification, pushed } = await publish(user._id, {
            category: 'medication',
            title: 'Time for Atorvastatin',
            body: '20mg, with water.',
            push: false,
            deliveredAt: at,
            pushedTo: 2,
        }, { user });

        expect(pushed).toBe(0);
        expect(pushSender.send).not.toHaveBeenCalled();
        expect(notification.pushedAt.getTime()).toBe(at.getTime());
        expect(notification.pushedTo).toBe(2);
        expect(notification.suppressedReason).toBeNull();
    });
});

/* ------------------------------------------------------------------ *
 * The feed
 * ------------------------------------------------------------------ */

describe('the feed', () => {
    const app = express();
    app.use(express.json());
    app.use('/api/notifications', require('../routes/notificationRoutes'));

    let user;
    let auth;

    beforeEach(async () => {
        user = await makeUser({ notificationPreferences: { enabled: true, quietHours: { start: 22, end: 22 } } });
        const token = jwt.sign({ id: String(user._id) }, process.env.SECRET_KEY);
        auth = (r) => r.set('Authorization', `Bearer ${token}`);
    });

    const seed = (over = {}) => Notification.create({
        userId: user._id,
        category: 'plan',
        title: 'Due today',
        body: 'Your lipid panel is due today.',
        route: '/myplans',
        ...over,
    });

    it('needs a token', async () => {
        await request(app).get('/api/notifications').expect(401);
        await request(app).get('/api/notifications/unread-count').expect(401);
    });

    it('separates unread from read, and counts both regardless of the filter', async () => {
        await seed();
        await seed({ category: 'sleep', title: 'Bedtime', readAt: new Date() });
        await seed({ category: 'sleep', title: 'Bedtime again' });

        const unread = await auth(request(app).get('/api/notifications?state=unread')).expect(200);
        expect(unread.body.notifications).toHaveLength(2);
        expect(unread.body.notifications.every((n) => n.read === false)).toBe(true);

        const read = await auth(request(app).get('/api/notifications?state=read')).expect(200);
        expect(read.body.notifications).toHaveLength(1);

        // Filtered to one category, the tab counts still describe the whole inbox — a
        // "Read" tab reading zero because of a filter looks broken rather than filtered.
        const filtered = await auth(request(app).get('/api/notifications?state=unread&category=sleep')).expect(200);
        expect(filtered.body.notifications).toHaveLength(1);
        expect(filtered.body.counts.unread).toBe(2);
        expect(filtered.body.counts.read).toBe(1);
        expect(filtered.body.counts.byCategory.sleep).toEqual({ total: 2, unread: 1 });
    });

    it('refuses a state or a category nothing knows about', async () => {
        await auth(request(app).get('/api/notifications?state=archived')).expect(400);
        await auth(request(app).get('/api/notifications?category=astrology')).expect(400);
    });

    it('groups by the person\'s local day, not by UTC', async () => {
        // 01:30 UTC on the 21st is still the evening of the 20th in New York (UTC-5, so
        // `tzOffset` 300). Grouping by UTC files it under "Today" on a screen whose header
        // should read "Yesterday" — the same defect `MealLog.day` documents.
        const at = new Date('2026-09-21T01:30:00.000Z');
        await seed({ createdAt: at });

        const utc = await auth(request(app).get('/api/notifications?tzOffset=0')).expect(200);
        expect(utc.body.notifications[0].day).toBe('2026-09-21');

        const ny = await auth(request(app).get('/api/notifications?tzOffset=300')).expect(200);
        expect(ny.body.notifications[0].day).toBe('2026-09-20');
    });

    it('carries the table\'s icon and label so a card cannot render blank', async () => {
        await seed({ category: 'medication' });
        const res = await auth(request(app).get('/api/notifications')).expect(200);
        expect(res.body.notifications[0].icon).toBe(CATEGORIES.medication.icon);
        expect(res.body.notifications[0].categoryLabel).toBe(CATEGORIES.medication.label);
        expect(res.body.notifications[0].tint).toBe(CATEGORIES.medication.tint);
    });

    it('pages on a cursor rather than an offset', async () => {
        const base = Date.now();
        for (let i = 0; i < 35; i++) {
            await seed({ title: `n${i}`, createdAt: new Date(base - i * 1000) });
        }

        const first = await auth(request(app).get('/api/notifications')).expect(200);
        expect(first.body.notifications).toHaveLength(30);
        expect(first.body.nextCursor).toBeTruthy();

        const { before, beforeId } = first.body.nextCursor;
        const second = await auth(
            request(app).get(`/api/notifications?before=${encodeURIComponent(before)}&beforeId=${beforeId}`)
        ).expect(200);
        expect(second.body.notifications).toHaveLength(5);
        expect(second.body.nextCursor).toBeNull();

        // No row appears on both pages, which is exactly what `skip` cannot promise on a
        // feed that is still being written to.
        const ids = new Set(first.body.notifications.map((n) => n.id));
        expect(second.body.notifications.some((n) => ids.has(n.id))).toBe(false);
    });

    it('marks read idempotently and never moves readAt afterwards', async () => {
        const row = await seed();
        const first = await auth(request(app).patch(`/api/notifications/${row._id}/read`)).expect(200);
        expect(first.body.notification.read).toBe(true);
        expect(first.body.unread).toBe(0);

        const at = (await Notification.findById(row._id)).readAt;
        await auth(request(app).patch(`/api/notifications/${row._id}/read`)).expect(200);
        // Re-marking on every scroll must not rewrite when the person first saw it, or the
        // one measure of whether this feature works always reads zero.
        expect((await Notification.findById(row._id)).readAt.getTime()).toBe(at.getTime());

        await auth(request(app).patch(`/api/notifications/${row._id}/read`).send({ read: false })).expect(200);
        expect((await Notification.findById(row._id)).readAt).toBeNull();
    });

    it('marks everything read, or only one category', async () => {
        await seed();
        await seed({ category: 'sleep' });
        await seed({ category: 'sleep' });

        const one = await auth(request(app).post('/api/notifications/read-all').send({ category: 'sleep' })).expect(200);
        expect(one.body.marked).toBe(2);
        expect(one.body.unread).toBe(1);

        const all = await auth(request(app).post('/api/notifications/read-all')).expect(200);
        expect(all.body.marked).toBe(1);
        expect(all.body.unread).toBe(0);
    });

    it('dismisses for real rather than archiving', async () => {
        const row = await seed();
        await auth(request(app).delete(`/api/notifications/${row._id}`)).expect(200);
        // Not a status change: keeping a hidden copy of everything somebody has swiped away
        // is special-category data with nothing asking for it.
        expect(await Notification.findById(row._id)).toBeNull();
    });

    it('answers 404, not 403, for somebody else\'s notification', async () => {
        const other = await makeUser();
        const theirs = await Notification.create({
            userId: other._id, category: 'plan', title: 'Theirs', body: 'Not yours.', route: '/myplans',
        });

        // A 403 would confirm the row exists, turning the endpoint into a way of asking
        // "is this a real notification?" one id at a time. `middleware/ownership.js` makes
        // the same call.
        await auth(request(app).patch(`/api/notifications/${theirs._id}/read`)).expect(404);
        await auth(request(app).delete(`/api/notifications/${theirs._id}`)).expect(404);
        expect(await Notification.findById(theirs._id)).not.toBeNull();
    });

    it('counts unread for the bell', async () => {
        await seed();
        await seed({ readAt: new Date() });
        const res = await auth(request(app).get('/api/notifications/unread-count')).expect(200);
        expect(res.body.unread).toBe(1);
    });

    it('writes a self-test card whether or not a push could be delivered', async () => {
        await User.updateOne({ _id: user._id }, { pushTokens: [] });
        const res = await auth(request(app).post('/api/notifications/self-test')).expect(200);
        expect(res.body.notification.title).toBe('Notifications are working');
        expect(await Notification.countDocuments({ userId: user._id })).toBe(1);
    });

    it('still registers a device — DELETE /register is not read as a dismissal', async () => {
        // `/:id` is declared after `/register` and has to stay there. Declared above it,
        // this call is read as dismissing a notification whose id is "register": it answers
        // 404, the device stays registered, and somebody who turned notifications off keeps
        // receiving them.
        await auth(request(app).delete('/api/notifications/register').send({ token: TOKEN })).expect(200);
        const after = await User.findById(user._id).lean();
        expect(after.pushTokens).toHaveLength(0);
    });
});
