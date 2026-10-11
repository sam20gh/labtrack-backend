/**
 * The assistant's night-by-night sleep context.
 *
 * The fault this pins: "how was my sleep last night?" was refused, because the assistant was
 * handed only `user.observed` — a fortnight's averages and a count of nights — and could see
 * that 21 nights existed and not one of them.
 *
 * 1. **"Last night" is the person's night.** Filed under their local wake day, in their clock.
 * 2. **A nap is not last night.** The split is `classifyDay`'s, the same one the screens use.
 * 3. **A stage nobody measured is not zero.**
 * 4. **No night yet today is said, not papered over** with an older night.
 */
const mongoose = require('mongoose');
const SleepSession = require('../models/SleepSession');
const User = require('../models/userModel');
const { gatherSleep, renderSleep } = require('../utils/sleepContext');

const DUBAI = -240; // minutes west of UTC, as Date.getTimezoneOffset() reports it
const NOW = new Date('2026-10-11T08:00:00.000Z'); // 12:00 in Dubai

const userId = () => new mongoose.Types.ObjectId();

const session = (uid, over = {}) => ({
    userId: uid,
    startedAt: new Date('2026-10-10T19:40:00.000Z'), // 23:40 Dubai
    endedAt: new Date('2026-10-11T03:10:00.000Z'), //   07:10 Dubai
    day: '2026-10-11',
    asleepMin: 392,
    inBedMin: 450,
    stages: { deepMin: 58, remMin: 80, lightMin: 254, awakeMin: 33 },
    efficiency: 87,
    score: 71,
    source: 'jstyle_bracelet',
    sourceDevice: { name: 'Predyqt 2' },
    ...over,
});

describe('sleepContext', () => {
    it('renders last night under today, in the person\'s own clock', async () => {
        const uid = userId();
        await SleepSession.create(session(uid));

        const text = renderSleep(await gatherSleep(uid, { tzOffset: DUBAI, now: NOW }));

        expect(text).toContain('Their local date today is 2026-10-11');
        expect(text).toContain('Woke 2026-10-11 (Sun) — last night');
        expect(text).toContain('11:40 PM → 7:10 AM');
        expect(text).toContain('asleep 6h 32m of 7h 30m in bed');
        expect(text).toContain('deep 58m');
        expect(text).toContain('score 71/100');
        expect(text).toContain('from Predyqt 2');
        expect(text).toContain('their local time');
        expect(text).not.toContain('No night is recorded for today');
    });

    it('carries the findings the detail screen showed for that night', async () => {
        const uid = userId();
        await SleepSession.create(session(uid));

        const text = renderSleep(await gatherSleep(uid, { tzOffset: DUBAI, now: NOW }));

        expect(text).toMatch(/What the app showed them for this night: ".+"/);
    });

    it('files a morning nap as a nap, never as last night', async () => {
        const uid = userId();
        await SleepSession.create([
            session(uid),
            session(uid, {
                startedAt: new Date('2026-10-11T06:00:00.000Z'), // 10:00 Dubai
                endedAt: new Date('2026-10-11T06:25:00.000Z'),
                asleepMin: 25,
                inBedMin: 25,
                stages: {},
                efficiency: null,
                score: null,
            }),
        ]);

        const text = renderSleep(await gatherSleep(uid, { tzOffset: DUBAI, now: NOW }));

        expect(text).toContain('Night: 11:40 PM → 7:10 AM');
        expect(text).toContain('Nap: 10:00 AM, 25m');
        expect(text).toContain('Day total including naps: 6h 57m');
    });

    it('says "not reported" for a source with no stages, never zero', async () => {
        const uid = userId();
        await SleepSession.create(session(uid, {
            stages: { deepMin: null, remMin: null, lightMin: null, awakeMin: null },
            efficiency: null,
            source: 'manual',
            sourceDevice: undefined,
        }));

        const text = renderSleep(await gatherSleep(uid, { tzOffset: DUBAI, now: NOW }));

        expect(text).toContain('stages not reported');
        expect(text).not.toMatch(/deep 0m|REM 0m/);
        expect(text).toContain('from entered by hand');
    });

    it('says so when nothing has synced for today, rather than calling an older night last night', async () => {
        const uid = userId();
        await SleepSession.create(session(uid, {
            startedAt: new Date('2026-10-09T19:40:00.000Z'),
            endedAt: new Date('2026-10-10T03:10:00.000Z'),
            day: '2026-10-10',
        }));

        const text = renderSleep(await gatherSleep(uid, { tzOffset: DUBAI, now: NOW }));

        expect(text).toContain('No night is recorded for today yet');
        expect(text).toContain('filed under 2026-10-10');
        expect(text).not.toContain('— last night');
    });

    it('falls back to the newest registered device\'s offset, then to labelled UTC', async () => {
        const withDevice = await User.create({
            email: `tz-${Date.now()}@example.com`,
            username: `tz-${Date.now()}`,
            password: 'not-a-real-hash',
            pushTokens: [{ token: 'ExponentPushToken[x]', tzOffset: DUBAI, registeredAt: new Date() }],
        });
        await SleepSession.create(session(withDevice._id));
        const fromDevice = renderSleep(await gatherSleep(withDevice._id, { now: NOW }));
        expect(fromDevice).toContain('11:40 PM → 7:10 AM');
        expect(fromDevice).toContain('their local time');

        const uid = userId();
        await SleepSession.create(session(uid));
        const unknown = renderSleep(await gatherSleep(uid, { tzOffset: 'nonsense', now: NOW }));
        expect(unknown).toContain('7:40 PM → 3:10 AM');
        expect(unknown).toContain('UTC — their time zone is not known');
    });

    it('omits the section for somebody with no sleep recorded', async () => {
        const sleep = await gatherSleep(userId(), { tzOffset: DUBAI, now: NOW });
        expect(sleep).toBeNull();
        expect(renderSleep(sleep)).toBe('');
    });
});
