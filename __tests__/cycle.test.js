/**
 * The cycle tracker — the rules that decide what somebody is told about their own body.
 *
 * Every one of these is a way the naive version misleads a real person:
 *
 *   - spotting read as day 1 moves every prediction after it;
 *   - a skipped Tuesday read as two periods invents a two-day cycle;
 *   - one long cycle averaged in makes every prediction a week late for months;
 *   - a single date instead of a window turns "two days early" into a broken promise;
 *   - a fertile window under hormonal contraception describes an ovulation that is not
 *     happening;
 *   - a prediction drawn over a past day turns "not logged" into "missed";
 *   - a daily-average temperature mixes a cold walk into the signal.
 */
jest.mock('../utils/pushSender', () => {
    const actual = jest.requireActual('../utils/pushSender');
    return {
        ...actual,
        send: jest.fn(async (messages) => ({ sent: messages.length, failed: 0, pruned: 0 })),
    };
});

const mongoose = require('mongoose');
const pushSender = require('../utils/pushSender');
const User = require('../models/userModel');
const CycleDay = require('../models/CycleDay');
const CyclePlan = require('../models/CyclePlan');
const DailyMetrics = require('../models/DailyMetrics');
const Notification = require('../models/Notification');
const engine = require('../utils/cycleEngine');
const fc = require('../utils/cycleForecast');
const { nightMedian, affectedDays } = require('../utils/nightTemperature');
const { ingestBatch } = require('../utils/healthSync');
const { recomputeMetricDay } = require('../utils/metricRollup');
const cycleController = require('../controllers/cycleController');
const { runCycleReminders, COVER, _messageFor } = require('../jobs/cycleReminderJob');
const { renderCycle, gatherCycle } = require('../utils/cycleContext');

const { addDays, mergeDays, findPeriods, cyclesFrom } = engine;

/** A period of `len` days from `start`, as merged day rows. */
const period = (start, len = 5, flow = 'medium') =>
    Array.from({ length: len }, (_, i) => ({
        day: addDays(start, i), flow, symptoms: [], mood: null, note: null, source: 'manual',
    }));

/** Periods starting on each date, five days each. */
const history = (...starts) => starts.flatMap((s) => period(s));

/** Four cycles of 28, 29, 27 and 28 days. Next expected: 2026-09-18, window 09-16 to 09-20. */
const REGULAR = history('2026-05-01', '2026-05-29', '2026-06-27', '2026-07-24', '2026-08-21');

const call = async (handler, { user, query = {}, body = {}, params = {} } = {}) => {
    let payload = null;
    let code = 200;
    const res = {
        status(c) { code = c; return this; },
        json(p) { payload = p; return this; },
    };
    await handler({ user, query, body, params }, res);
    return { code, body: payload };
};

const makeUser = (over = {}) => User.create({
    username: `u${new mongoose.Types.ObjectId()}`,
    email: `${new mongoose.Types.ObjectId()}@example.com`,
    supabaseId: String(new mongoose.Types.ObjectId()),
    ...over,
});

/* ------------------------------------------------------------- engine */

describe('days become periods', () => {
    it('spotting never starts a period', () => {
        const { periods } = findPeriods([
            { day: '2026-09-01', flow: 'spotting' },
            { day: '2026-09-02', flow: 'medium' },
            { day: '2026-09-03', flow: 'heavy' },
        ]);
        expect(periods).toHaveLength(1);
        expect(periods[0].start).toBe('2026-09-02');
        expect(periods[0].heaviest).toBe('heavy');
    });

    it('a logging gap of up to two days is the same period', () => {
        const { periods } = findPeriods([
            { day: '2026-09-02', flow: 'medium' },
            { day: '2026-09-03', flow: 'medium' },
            { day: '2026-09-05', flow: 'light' },
        ]);
        expect(periods).toHaveLength(1);
        expect(periods[0]).toMatchObject({ start: '2026-09-02', end: '2026-09-05', length: 4, loggedDays: 3 });
    });

    it('bleeding soon after a period started is between periods, not a new cycle', () => {
        const { periods, between } = findPeriods([
            { day: '2026-09-02', flow: 'medium' },
            { day: '2026-09-03', flow: 'medium' },
            { day: '2026-09-10', flow: 'light' },
        ]);
        expect(periods).toHaveLength(1);
        expect(between).toEqual(['2026-09-10']);
        expect(cyclesFrom(periods)).toEqual([]);
    });

    it('a manual row wins over a mirrored one for the same day', () => {
        const merged = mergeDays([
            { day: '2026-09-02', flow: 'heavy', source: 'health_connect', createdAt: new Date(1) },
            { day: '2026-09-02', flow: null, source: 'manual', createdAt: new Date(2) },
        ]);
        expect(merged).toHaveLength(1);
        expect(merged[0].flow).toBeNull();
    });
});

/* ----------------------------------------------------------- forecast */

describe('the forecast', () => {
    it('predicts a window from the median of the logged cycles', () => {
        const r = fc.forecast({ days: REGULAR, plan: {}, today: '2026-09-10' });
        expect(r.prediction).toMatchObject({
            expected: '2026-09-18', cycleLength: 28, spread: 2, source: 'observed', cyclesUsed: 4,
            window: { from: '2026-09-16', to: '2026-09-20' },
        });
        expect(r.state).toBe('upcoming');
        expect(r.daysUntil).toEqual({ from: 6, to: 10 });
        expect(r.cycleDay).toBe(21);
    });

    it('uses the median, so one long cycle does not drag every prediction late', () => {
        const days = history('2026-03-01', '2026-03-29', '2026-04-26', '2026-06-23', '2026-07-21');
        const r = fc.forecast({ days, plan: {}, today: '2026-08-01' });
        // Cycles 28, 28, 58, 28: the mean is 35.5, the median 28.
        expect(r.prediction.cycleLength).toBe(28);
        expect(r.prediction.spread).toBe(fc.MAX_SPREAD);
    });

    it('never forecasts from a logging gap', () => {
        const days = history('2026-01-01', '2026-05-21', '2026-06-18', '2026-07-16');
        const r = fc.forecast({ days, plan: {}, today: '2026-08-01' });
        expect(r.cycles.map((c) => c.length)).toEqual([140, 28, 28]);
        expect(r.prediction.cycleLength).toBe(28);
        expect(r.prediction.cyclesUsed).toBe(2);
    });

    it('reads the setup answers until two cycles are logged, and says so', () => {
        const plan = { seed: { cycleLength: 30 } };
        const r = fc.forecast({ days: period('2026-09-01'), plan, today: '2026-09-10' });
        expect(r.prediction).toMatchObject({ expected: '2026-10-01', source: 'reported', spread: 3 });
    });

    it('predicts nothing without a start or a length', () => {
        expect(fc.forecast({ days: [], plan: {}, today: '2026-09-10' }))
            .toMatchObject({ prediction: null, reason: 'needs_period', state: 'unknown' });
        expect(fc.forecast({ days: period('2026-08-20'), plan: {}, today: '2026-09-10' }))
            .toMatchObject({ prediction: null, reason: 'needs_length' });
    });

    it('can start from the setup date alone', () => {
        const plan = { seed: { lastPeriodStart: '2026-09-01', cycleLength: 28 } };
        const r = fc.forecast({ days: [], plan, today: '2026-09-10' });
        expect(r.lastStartSource).toBe('reported');
        expect(r.prediction.expected).toBe('2026-09-29');
    });

    it.each([
        ['2026-09-17', 'due', {}],
        ['2026-09-21', 'late', { daysLate: 3 }],
        ['2026-09-27', 'very_late', { daysLate: 9 }],
        ['2026-11-25', 'long_gap', { daysSinceStart: 96 }],
    ])('on %s the state is %s', (today, state, extra) => {
        const r = fc.forecast({ days: REGULAR, plan: {}, today });
        expect(r.state).toBe(state);
        expect(r).toMatchObject(extra);
    });

    it('knows somebody is on their period, and what day of it', () => {
        const days = [...REGULAR.slice(0, -5), ...period('2026-08-21', 2)];
        const r = fc.forecast({ days, plan: {}, today: '2026-08-22' });
        expect(r.state).toBe('period');
        expect(r.currentPeriod).toMatchObject({ start: '2026-08-21', day: 2, expectedEnd: '2026-08-25' });
    });

    it('pauses under pregnancy and breastfeeding', () => {
        for (const status of ['pregnant', 'breastfeeding']) {
            const r = fc.forecast({ days: REGULAR, plan: { status }, today: '2026-09-21' });
            expect(r).toMatchObject({ state: 'paused', prediction: null, projected: [] });
            expect(fc.regularityNotes(r, { status }, '2026-09-21')).toEqual([]);
        }
    });

    it('widens the window under perimenopause', () => {
        const r = fc.forecast({ days: REGULAR, plan: { status: 'perimenopause' }, today: '2026-09-10' });
        expect(r.prediction.spread).toBe(5);
    });

    it('draws only the overdue period once somebody is late', () => {
        expect(fc.forecast({ days: REGULAR, plan: {}, today: '2026-09-10' }).projected).toHaveLength(3);
        expect(fc.forecast({ days: REGULAR, plan: {}, today: '2026-09-22' }).projected).toHaveLength(1);
    });
});

describe('the fertile window', () => {
    it('is drawn only when asked for', () => {
        const off = fc.forecast({ days: REGULAR, plan: {}, today: '2026-08-25' });
        expect(off.projected[0].fertile).toBeNull();

        const on = fc.forecast({ days: REGULAR, plan: { showFertileWindow: true }, today: '2026-08-25' });
        expect(on.projected[0].ovulation).toBe('2026-09-04');
        expect(on.projected[0].fertile).toEqual({ from: '2026-08-30', to: '2026-09-05' });
    });

    it('the dashboard shows the next window that has not ended, not one already over', () => {
        const r = fc.forecast({ days: REGULAR, plan: { showFertileWindow: true }, today: '2026-09-10' });
        // projected[0]'s window ended on 5 Sep; the next one is the cycle after.
        expect(fc.nextFertile(r.projected, '2026-09-10')).toEqual({
            window: { from: '2026-09-27', to: '2026-10-03' }, ovulation: '2026-10-02', now: false,
        });
        expect(fc.nextFertile(r.projected, '2026-09-28').now).toBe(true);
        expect(fc.nextFertile(fc.forecast({ days: REGULAR, plan: {}, today: '2026-09-10' }).projected, '2026-09-10')).toBeNull();
    });

    it('is never drawn under hormonal contraception, whatever the switch says', () => {
        const plan = { showFertileWindow: true, status: 'hormonal_contraception' };
        const r = fc.forecast({ days: REGULAR, plan, today: '2026-08-25' });
        expect(r.projected[0].fertile).toBeNull();
        expect(r.projected[0].ovulation).toBeNull();
        expect(fc.fertileAllowed(plan)).toBe(false);
    });
});

describe('regularity notes', () => {
    const keys = (days, today, plan = {}) =>
        fc.regularityNotes(fc.forecast({ days, plan, today }), plan, today).map((n) => n.key);

    it('say nothing about a regular history', () => {
        expect(keys(REGULAR, '2026-09-10')).toEqual([]);
    });

    it('mention cycles outside 24–38 days and variation over 9', () => {
        const days = history('2026-04-01', '2026-04-23', '2026-06-02', '2026-06-30', '2026-07-30');
        // 22, 40, 28, 30
        expect(keys(days, '2026-08-10')).toEqual(expect.arrayContaining(['cycle_length', 'variation']));
    });

    it('stay quiet about variation under perimenopause', () => {
        const days = history('2026-04-01', '2026-04-23', '2026-06-02', '2026-06-30', '2026-07-30');
        const k = keys(days, '2026-08-10', { status: 'perimenopause' });
        expect(k).not.toContain('variation');
        expect(k).not.toContain('cycle_length');
    });

    it('mention a period over 8 days, and bleeding between periods', () => {
        const days = [...REGULAR.slice(0, -5), ...period('2026-08-21', 9), { day: '2026-09-02', flow: 'light', symptoms: [] }];
        expect(keys(days, '2026-09-10')).toEqual(expect.arrayContaining(['long_period', 'between_periods']));
    });

    it('mention 90 days without a period, and ask whether one was missed from the log', () => {
        const days = REGULAR;
        const notes = fc.regularityNotes(fc.forecast({ days, plan: {}, today: '2026-11-25' }), {}, '2026-11-25');
        const note = notes.find((n) => n.key === 'no_period');
        expect(note.body).toMatch(/log them/);
    });

    it('never name a condition', () => {
        const days = history('2026-04-01', '2026-04-23', '2026-06-02', '2026-06-30', '2026-07-30');
        const notes = fc.regularityNotes(fc.forecast({ days, plan: {}, today: '2026-12-01' }), {}, '2026-12-01');
        for (const n of notes) {
            expect(`${n.title} ${n.body}`).not.toMatch(/PCOS|polycystic|endometriosis|fibroid|menopause|infertil|cancer/i);
        }
    });
});

describe('the backtest', () => {
    it('scores the forecast against the history it would have been made from', () => {
        const result = fc.backtest(findPeriods(REGULAR).periods, {});
        expect(result.checked).toBe(2);
        expect(result.hits).toBe(2);
        expect(result.rate).toBe(1);
    });

    it('is null, not zero, with nothing to check', () => {
        expect(fc.backtest(findPeriods(history('2026-08-01', '2026-08-29')).periods, {})).toBeNull();
    });
});

describe('what the calendar draws', () => {
    it('never draws a prediction over a day that has passed', () => {
        const today = '2026-09-22';
        const r = fc.forecast({ days: REGULAR, plan: {}, today });
        const marks = fc.marksForRange({ from: '2026-09-15', to: '2026-09-25', days: REGULAR, reading: r, today });
        for (const m of marks.filter((x) => x.day < today)) expect(m.predicted).toBeNull();
    });

    it('draws the rest of an ongoing period as predicted', () => {
        const days = [...REGULAR.slice(0, -5), ...period('2026-08-21', 2)];
        const today = '2026-08-22';
        const r = fc.forecast({ days, plan: {}, today });
        const marks = fc.marksForRange({ from: '2026-08-21', to: '2026-08-26', days, reading: r, today });
        expect(marks.map((m) => [m.period, m.predicted])).toEqual([
            [true, null], [true, null], [false, 'period'], [false, 'period'], [false, 'period'], [false, null],
        ]);
    });
});

/* -------------------------------------------------------- temperature */

describe('the temperature shift', () => {
    const nights = (start, values) => values.map((celsius, i) => ({ day: addDays(start, i), celsius }));

    it('finds three nights over the six before them', () => {
        const n = nights('2026-09-01', [33.0, 32.95, 33.05, 33.0, 32.98, 33.02, 33.01, 33.03, 33.3, 33.35, 33.4]);
        expect(fc.detectShift(n)).toMatchObject({
            shiftDay: '2026-09-09', ovulationDay: '2026-09-08', confirmedOn: '2026-09-11', coverline: 33.05,
        });
    });

    it('ignores a rise too small to be one', () => {
        const n = nights('2026-09-01', [33.0, 32.95, 33.05, 33.0, 32.98, 33.02, 33.01, 33.03, 33.1, 33.12, 33.15]);
        expect(fc.detectShift(n)).toBeNull();
    });

    it('says nothing from too few nights', () => {
        expect(fc.detectShift(nights('2026-09-01', [33.0, 33.4, 33.5, 33.6]))).toBeNull();
    });

    it('changes nothing the person sees unless the signal is switched on', () => {
        const days = REGULAR;
        const n = nights('2026-08-21', [33.0, 32.95, 33.05, 33.0, 32.98, 33.02, 33.01, 33.03, 33.3, 33.35, 33.4]);
        expect(fc.forecast({ days, plan: {}, today: '2026-09-10', nights: n, useTemperature: false }).confirmedOvulations).toEqual([]);
        expect(fc.forecast({ days, plan: {}, today: '2026-09-10', nights: n, useTemperature: true }).confirmedOvulations)
            .toEqual(['2026-08-28']);
    });
});

describe('the night-time temperature', () => {
    const night = { startedAt: '2026-08-19T22:30:00.000Z', endedAt: '2026-08-20T06:30:00.000Z' };
    const at = (iso, celsius) => ({ measuredAt: iso, celsius });

    it('is the median of the readings inside the night, and ignores the day', () => {
        const result = nightMedian([
            at('2026-08-19T23:00:00Z', 33.1), at('2026-08-20T00:00:00Z', 33.3), at('2026-08-20T01:00:00Z', 33.2),
            at('2026-08-20T02:00:00Z', 20.5), at('2026-08-20T03:00:00Z', 33.25),
            at('2026-08-20T12:00:00Z', 29.0),
        ], night);
        // 20.5 is a band that slipped; a mean would sit near 30.7.
        expect(result).toEqual({ median: 33.2, readings: 5 });
    });

    it('is null from too few readings', () => {
        expect(nightMedian([at('2026-08-20T00:00:00Z', 33.3), at('2026-08-20T01:00:00Z', 33.3)], night))
            .toEqual({ median: null, readings: 2 });
    });

    it('recomputes the next wake day for a reading taken before midnight', () => {
        expect(affectedDays({ tempDays: ['2026-08-19'], sleepDays: [] })).toEqual(['2026-08-19', '2026-08-20']);
    });

    it('lands on the wake day through a real sync, whichever half arrives first, and survives the rollup', async () => {
        const userId = new mongoose.Types.ObjectId();
        const temperature = [];
        for (let h = 0; h < 8; h += 1) {
            temperature.push({
                externalId: `t${h}`,
                measuredAt: new Date(Date.parse('2026-08-19T23:00:00Z') + h * 3_600_000).toISOString(),
                celsius: 33 + h * 0.01,
                site: 'wrist',
            });
        }
        temperature.push({ externalId: 'noon', measuredAt: '2026-08-20T12:00:00Z', celsius: 29.0, site: 'wrist' });

        // Temperatures first, the night in a later batch.
        await ingestBatch({ userId, platform: 'jstyle_bracelet', tzOffset: 0, temperature });
        let row = await DailyMetrics.findOne({ userId, day: '2026-08-20' }).lean();
        expect(row.temperature.wristSleepMedian).toBeNull();

        await ingestBatch({
            userId, platform: 'health_connect', tzOffset: 0, goalMinutes: 480,
            sleep: [{ externalId: 'n1', startedAt: '2026-08-19T22:30:00.000Z', endedAt: '2026-08-20T06:30:00.000Z' }],
        });
        row = await DailyMetrics.findOne({ userId, day: '2026-08-20' }).lean();
        expect(row.temperature.wristSleepMedian).toBeCloseTo(33.035, 2);
        expect(row.temperature.wristSleepReadings).toBe(8);

        await recomputeMetricDay(userId, '2026-08-20');
        row = await DailyMetrics.findOne({ userId, day: '2026-08-20' }).lean();
        expect(row.temperature.wristSleepMedian).toBeCloseTo(33.035, 2);
    });
});

/* --------------------------------------------------------- controller */

describe('who is offered the tracker', () => {
    it.each([
        ['Female', null, 'suggested'],
        [null, null, 'offer'],
        ['Other', null, 'offer'],
        ['Male', null, 'hidden'],
        ['Male', { enabled: true }, 'enabled'],
        ['Female', { onboarded: true, enabled: false }, 'off'],
        ['Other', { offerDismissedAt: new Date() }, 'dismissed'],
    ])('gender %s with plan %j is %s', (gender, plan, access) => {
        expect(cycleController._accessFor({ gender }, plan)).toBe(access);
    });
});

describe('logging', () => {
    const today = engine.localDay(new Date(), 0);

    it('refuses a day that has not happened', async () => {
        const user = await makeUser({ gender: 'Female' });
        const { code } = await call(cycleController.putDay, {
            user: { id: user._id }, params: { day: addDays(today, 2) }, body: { flow: 'medium' }, query: { tzOffset: 0 },
        });
        expect(code).toBe(400);
    });

    it('deletes a day left with nothing on it', async () => {
        const user = await makeUser({ gender: 'Female' });
        const req = { user: { id: user._id }, params: { day: today }, query: { tzOffset: 0 } };
        await call(cycleController.putDay, { ...req, body: { flow: 'light', symptoms: ['cramps', 'not_a_symptom'] } });
        const saved = await CycleDay.findOne({ userId: user._id }).lean();
        expect(saved.symptoms).toEqual(['cramps']);

        await call(cycleController.putDay, { ...req, body: { flow: null, symptoms: [] } });
        expect(await CycleDay.countDocuments({ userId: user._id })).toBe(0);
    });

    it('marks a range as period days without overwriting a chosen flow, and unmarks keeping symptoms', async () => {
        const user = await makeUser({ gender: 'Female' });
        const d1 = addDays(today, -3);
        const d2 = addDays(today, -2);
        await CycleDay.create({ userId: user._id, day: d1, flow: 'heavy', symptoms: ['cramps'] });

        await call(cycleController.putPeriodDays, {
            user: { id: user._id }, query: { tzOffset: 0 }, body: { add: [d1, d2] },
        });
        const rows = await CycleDay.find({ userId: user._id }).sort({ day: 1 }).lean();
        expect(rows.map((r) => r.flow)).toEqual(['heavy', 'unspecified']);

        await call(cycleController.putPeriodDays, {
            user: { id: user._id }, query: { tzOffset: 0 }, body: { remove: [d1, d2] },
        });
        const after = await CycleDay.find({ userId: user._id }).lean();
        expect(after).toHaveLength(1);
        expect(after[0]).toMatchObject({ day: d1, flow: null, symptoms: ['cramps'] });
    });

    it('asks when a period ended that only had its start logged', async () => {
        const user = await makeUser({ gender: 'Female' });
        await CyclePlan.create({ userId: user._id, enabled: true, onboarded: true });
        await CycleDay.create({ userId: user._id, day: addDays(today, -4), flow: 'medium' });

        const { body } = await call(cycleController.getOverview, { user: { id: user._id }, query: { tzOffset: 0 } });
        expect(body.prompt).toMatchObject({ kind: 'confirm_end', start: addDays(today, -4) });
        expect(body.access).toBe('enabled');
        expect(body.week).toHaveLength(7);
    });

    it('rejects an impossible cycle length rather than clamping it', async () => {
        const user = await makeUser({ gender: 'Female' });
        const { code } = await call(cycleController.updatePlan, {
            user: { id: user._id }, body: { seed: { cycleLength: 280 } }, query: { tzOffset: 0 },
        });
        expect(code).toBe(400);
    });

    it('erases everything and does not immediately offer the tracker again', async () => {
        const user = await makeUser({ gender: 'Female' });
        await CyclePlan.create({ userId: user._id, enabled: true, onboarded: true });
        await CycleDay.create({ userId: user._id, day: today, flow: 'medium' });

        const { body } = await call(cycleController.deleteAll, { user: { id: user._id } });
        expect(body.deletedDays).toBe(1);
        expect(await CycleDay.countDocuments({ userId: user._id })).toBe(0);
        const plan = await CyclePlan.findOne({ userId: user._id }).lean();
        expect(cycleController._accessFor(user, plan)).toBe('dismissed');
    });
});

/* -------------------------------------------------------- reminders */

describe('reminders', () => {
    const TOKEN = 'ExponentPushToken[cyclexxxxxxxxxxxxxxxxx]';

    const setUp = async (planOver = {}) => {
        const user = await makeUser({ gender: 'Female', pushTokens: [{ token: TOKEN, platform: 'ios', tzOffset: 0 }] });
        await CyclePlan.create({ userId: user._id, enabled: true, onboarded: true, ...planOver });
        await CycleDay.insertMany(REGULAR.map((d) => ({ userId: user._id, day: d.day, flow: d.flow })));
        return user;
    };

    beforeEach(() => pushSender.send.mockClear());

    it('sends "soon" two days before the window, with a discreet lock screen', async () => {
        const user = await setUp();
        const result = await runCycleReminders(new Date('2026-09-14T09:10:00Z'));
        expect(result.sent).toBe(1);

        const card = await Notification.findOne({ userId: user._id }).lean();
        expect(card).toMatchObject({ category: 'cycle', title: 'Your period may start soon' });
        expect(card.body).toMatch(/16 Sept? and 20 Sept?/);

        const [messages] = pushSender.send.mock.calls[0];
        expect(messages[0].title).toBe(COVER.title);
        expect(messages[0].body).toBe(COVER.body);
        expect(JSON.stringify(messages)).not.toMatch(/period/i);
    });

    it('puts the detail on the lock screen only when somebody asked for that', async () => {
        await setUp({ discreetPush: false });
        await runCycleReminders(new Date('2026-09-14T09:10:00Z'));
        const [messages] = pushSender.send.mock.calls[0];
        expect(messages[0].title).toBe('Your period may start soon');
    });

    it('sends "late" once, not every morning', async () => {
        const user = await setUp();
        expect((await runCycleReminders(new Date('2026-09-21T09:10:00Z'))).sent).toBe(1);
        expect((await runCycleReminders(new Date('2026-09-21T09:40:00Z'))).skipped.already_sent).toBe(1);
        const card = await Notification.findOne({ userId: user._id }).lean();
        expect(card.dedupeKey).toBe('cycle:late:2026-09-18');
    });

    it('sends nothing outside 09:00 local, with reminders off, or when paused', async () => {
        await setUp({ reminders: { periodSoon: false, late: false } });
        expect((await runCycleReminders(new Date('2026-09-21T09:10:00Z'))).sent).toBe(0);
        expect((await runCycleReminders(new Date('2026-09-21T15:00:00Z'))).sent).toBe(0);
        await CyclePlan.deleteMany({});
        await User.deleteMany({});
        await CycleDay.deleteMany({});
        await setUp({ status: 'pregnant' });
        expect((await runCycleReminders(new Date('2026-09-21T09:10:00Z'))).sent).toBe(0);
    });

    it('sends nothing to somebody who has not switched the tracker on', async () => {
        const user = await setUp();
        await CyclePlan.updateOne({ userId: user._id }, { $set: { enabled: false } });
        expect((await runCycleReminders(new Date('2026-09-21T09:10:00Z'))).considered).toBe(0);
    });

    it('keeps every message short, calm and free of a diagnosis', () => {
        for (const today of ['2026-09-14', '2026-09-21', '2026-09-28']) {
            const reading = fc.forecast({ days: REGULAR, plan: {}, today });
            const m = _messageFor(reading, {});
            expect(m).not.toBeNull();
            expect(m.body.length).toBeLessThanOrEqual(240);
            expect(m.title.length).toBeLessThanOrEqual(80);
            expect(`${m.title} ${m.body}`).not.toMatch(/PCOS|polycystic|endometriosis|urgent|emergency|danger/i);
        }
    });
});

/* ------------------------------------------------------- assistant */

describe('the assistant context', () => {
    it('is empty for somebody who has not switched the tracker on', async () => {
        const user = await makeUser({ gender: 'Female' });
        expect(await gatherCycle(user._id, '2026-09-10')).toBeNull();
        expect(renderCycle(null)).toBe('');
    });

    it('summarises the cycle and says the fertile window is not contraception', async () => {
        const user = await makeUser({ gender: 'Female' });
        await CyclePlan.create({ userId: user._id, enabled: true, onboarded: true });
        await CycleDay.insertMany(REGULAR.map((d) => ({ userId: user._id, day: d.day, flow: d.flow })));
        const text = renderCycle(await gatherCycle(user._id, '2026-09-10'));
        expect(text).toMatch(/cycle day 21/);
        expect(text).toMatch(/2026-09-16 to 2026-09-20/);
        expect(text).toMatch(/not contraception/);
    });
});
