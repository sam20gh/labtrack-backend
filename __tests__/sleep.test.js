/**
 * The sleep tracker — the arithmetic, and the four things that will otherwise go wrong
 * silently.
 *
 * 1. **A clock time is circular.** Averaging a 23:40 bedtime and a 00:20 one as plain
 *    numbers gives midday, which is the one answer that cannot be right for either night.
 *    Nothing throws; the card just prints an hour nobody has ever gone to bed at.
 * 2. **A stage nobody measured is not zero.** A watch that reports only a total must not be
 *    rendered as somebody who got no deep sleep at all.
 * 3. **A goal change has to rescore the history.** The score is stored on the row and copied
 *    into the rollup, so a goal that moves without a rescore leaves the trend chart
 *    disagreeing with the dial directly above it.
 * 4. **The goal is bounded.** A four-hour goal would make a four-hour night score 100 — the
 *    app endorsing chronic short sleep with a full ring.
 */
const mongoose = require('mongoose');
const SleepSession = require('../models/SleepSession');
const SleepPlan = require('../models/SleepPlan');
const SleepSchedule = require('../models/SleepSchedule');
const DailyMetrics = require('../models/DailyMetrics');
const PlanItem = require('../models/PlanItem');
const healthSync = require('../utils/healthSync');
const { ingestBatch } = healthSync;
const { scoreNight, bandFor, BANDS } = require('../utils/sleepScore');
const targets = require('../utils/sleepTargets');
const insight = require('../utils/sleepInsight');
const sleepController = require('../controllers/sleepController');
const { runSleepReminders } = require('../jobs/sleepReminderJob');

const userId = () => new mongoose.Types.ObjectId();

const night = (over = {}) => ({
    externalId: `HC-${Math.random()}`,
    startedAt: '2026-08-19T22:30:00.000Z',
    endedAt: '2026-08-20T06:30:00.000Z',
    segments: [
        { stage: 'light', startedAt: '2026-08-19T22:30:00.000Z', endedAt: '2026-08-20T00:30:00.000Z' },
        { stage: 'deep', startedAt: '2026-08-20T00:30:00.000Z', endedAt: '2026-08-20T02:00:00.000Z' },
        { stage: 'rem', startedAt: '2026-08-20T02:00:00.000Z', endedAt: '2026-08-20T03:45:00.000Z' },
        { stage: 'light', startedAt: '2026-08-20T03:45:00.000Z', endedAt: '2026-08-20T06:00:00.000Z' },
        { stage: 'awake', startedAt: '2026-08-20T06:00:00.000Z', endedAt: '2026-08-20T06:30:00.000Z' },
    ],
    ...over,
});

/** A minimal Express double. The controllers only ever use these three. */
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

/* ------------------------------------------------------------- ingest */

describe('nights arrive through the device sync, not through this feature', () => {
    it('a Health Connect night is filed under the wake day and scored', async () => {
        const id = userId();

        await ingestBatch({
            userId: id, platform: 'health_connect', tzOffset: 0, sleep: [night()], goalMinutes: 480,
        });

        const rows = await SleepSession.find({ userId: id }).lean();
        expect(rows).toHaveLength(1);
        // Went to bed on the 19th, woke on the 20th. The 20th is the day the dashboard shows.
        expect(rows[0].day).toBe('2026-08-20');
        expect(rows[0].asleepMin).toBe(450);
        expect(rows[0].stages.deepMin).toBe(90);
        expect(rows[0].score).toBeGreaterThan(0);

        const rollup = await DailyMetrics.findOne({ userId: id, day: '2026-08-20' }).lean();
        expect(rollup.sleep.asleepMin).toBe(450);
        expect(rollup.sleep.score).toBe(rows[0].score);
    });

    it('re-syncing the same night leaves one row', async () => {
        const id = userId();
        const row = night({ externalId: 'HC-stable' });

        await ingestBatch({ userId: id, platform: 'health_connect', tzOffset: 0, sleep: [row] });
        await ingestBatch({ userId: id, platform: 'health_connect', tzOffset: 0, sleep: [row] });

        expect(await SleepSession.countDocuments({ userId: id })).toBe(1);
    });
});

/* -------------------------------------------------------------- score */

describe('the score', () => {
    it('a source that reports only a total still scores out of 100', () => {
        // Not capped at 60 because the duration weight is the only one that applied.
        expect(scoreNight({ asleepMin: 480, goalMinutes: 480 })).toBe(100);
    });

    it('the bottom band is not called what the design calls it', () => {
        expect(bandFor(20).label).toBe('Needs attention');
        expect(BANDS.map((b) => b.label)).not.toContain('Insomniac');
    });

    it('oversleeping is not scored as better than meeting the goal', () => {
        expect(scoreNight({ asleepMin: 720, goalMinutes: 480 }))
            .toBe(scoreNight({ asleepMin: 480, goalMinutes: 480 }));
    });
});

/* ------------------------------------------------------------- targets */

describe('the goal', () => {
    it('is the guideline figure when the plan says nothing about sleep', () => {
        const { minutes, guidance } = targets.computeGoal({ user: {}, sleepItems: [] });
        expect(minutes).toBe(targets.BASELINE_MINUTES);
        expect(guidance).toHaveLength(0);
    });

    it('is extended by advice that says to sleep more', () => {
        const { minutes, basis } = targets.computeGoal({
            user: {},
            sleepItems: [{ _id: 'a', title: 'Aim for more sleep on work nights' }],
        });
        expect(minutes).toBe(targets.BASELINE_MINUTES + 30);
        expect(basis.appliedKeys).toContain('extend_sleep');
    });

    it('is not extended by advice about insomnia', () => {
        // Extending time in bed is the standard wrong answer for insomnia. The advice is
        // carried; the number is not moved.
        const { minutes, guidance } = targets.computeGoal({
            user: {},
            sleepItems: [{ _id: 'a', title: 'Difficulty falling asleep — see the sleep hygiene notes' }],
        });
        expect(minutes).toBe(targets.BASELINE_MINUTES);
        expect(guidance.map((g) => g.key)).toContain('insomnia_support');
    });

    it('applies a rule once however many directives triggered it', () => {
        const one = targets.computeGoal({
            user: {}, sleepItems: [{ _id: 'a', title: 'Increase sleep' }],
        });
        const three = targets.computeGoal({
            user: {},
            sleepItems: [
                { _id: 'a', title: 'Increase sleep' },
                { _id: 'b', title: 'Chronic short sleep is affecting your markers' },
                { _id: 'c', title: 'Sleep deprivation noted' },
            ],
        });
        expect(three.minutes).toBe(one.minutes);
    });

    it('clamps a goal somebody typed to the healthy adult range, and says so', () => {
        const { minutes, basis } = targets.computeGoal({
            user: {}, sleepItems: [], override: 4 * 60,
        });
        expect(minutes).toBe(targets.CAPS.min);
        expect(basis.clamped).toBe(true);
        // The point of the clamp: four hours of sleep must not score full marks.
        expect(scoreNight({ asleepMin: 4 * 60, goalMinutes: minutes })).toBeLessThan(100);
    });

    it('carries advice that matches no rule rather than dropping it', () => {
        const guidance = targets.deriveGuidance([
            { _id: 'a', title: 'Keep the bedroom below 19 degrees' },
        ]);
        expect(guidance).toHaveLength(1);
        expect(guidance[0].key).toBe('other');
        expect(guidance[0].directive).toBe('Keep the bedroom below 19 degrees');
    });

    it('explains itself from the same arithmetic that produced the number', () => {
        const { minutes, guidance, basis } = targets.computeGoal({
            user: {}, sleepItems: [{ _id: 'a', title: 'Aim for more sleep' }],
        });
        const text = targets.explain({ minutes, guidance, basis });
        expect(text).toContain('8h 30m');
        expect(text).toContain('sleep longer');
    });
});

/* ------------------------------------------------------------- insight */

describe('derived readings', () => {
    it('averages bedtimes around midnight rather than through midday', () => {
        // 23:40 and 00:20 average to midnight. A plain mean gives 12:00.
        expect(insight.meanClock([23 * 60 + 40, 20])).toBe(0);
    });

    it('reports a stage nobody measured as null, not zero', () => {
        const breakdown = insight.stageBreakdown([
            { stages: { deepMin: 60, remMin: 90, lightMin: null, awakeMin: null } },
        ]);
        const light = breakdown.stages.find((s) => s.stage === 'light');
        expect(light.minutes).toBeNull();
        expect(light.share).toBeNull();
    });

    it('the reported shares add to 100 even when a source reports only two stages', () => {
        const breakdown = insight.stageBreakdown([
            { stages: { deepMin: 60, remMin: 140, lightMin: null, awakeMin: null } },
        ]);
        const total = breakdown.stages
            .map((s) => s.share)
            .filter((v) => v !== null)
            .reduce((a, b) => a + b, 0);
        expect(Math.round(total)).toBe(100);
    });

    it('averages over the nights that reported, never over the window', () => {
        const week = insight.byWeekday([
            { day: '2026-08-17', asleepMin: 400 },  // Monday
            { day: '2026-08-18', asleepMin: 500 },  // Tuesday
        ]);
        expect(week.avgMin).toBe(450);
        // Five days nobody slept through draw no bar rather than a bar at zero.
        expect(week.days.filter((d) => d.avgMin === null)).toHaveLength(5);
    });

    it('compares against nothing as null, never as +100%', () => {
        const cmp = insight.comparePeriods([{ asleepMin: 480 }], [], 'asleepMin');
        expect(cmp.deltaPct).toBeNull();
        expect(cmp.previous).toBeNull();
    });

    it('rates a steady schedule on the worse of bedtime and wake spread', () => {
        // Wakes at exactly 06:30 every day, goes to bed anywhere from 22:00 to 01:00.
        const nights = [
            { startedAt: '2026-08-17T22:00:00Z', endedAt: '2026-08-18T06:30:00Z' },
            { startedAt: '2026-08-19T01:00:00Z', endedAt: '2026-08-19T06:30:00Z' },
            { startedAt: '2026-08-19T23:30:00Z', endedAt: '2026-08-20T06:30:00Z' },
        ];
        const result = insight.consistency(nights, 0);
        expect(result.wakeSpreadMin).toBe(0);
        expect(result.band.key).not.toBe('steady');
    });

    it('scores progress against no goal as null, not zero', () => {
        expect(insight.goalProgress(420, null)).toBeNull();
        expect(insight.goalProgress(420, 480)).toBeCloseTo(0.875, 3);
    });
});

/* ---------------------------------------------------------- the routes */

describe('the API', () => {
    it('hands back a plan rather than a 404 for somebody who has never set one', async () => {
        const id = userId();
        const { code, body } = await call(sleepController.getPlan, { user: { id: String(id) } });

        expect(code).toBe(200);
        expect(body.plan.goalMinutes).toBe(targets.BASELINE_MINUTES);
        expect(body.explanation).toContain('8h');
    });

    it('derives the goal from the health plan on read, with no migration', async () => {
        const id = userId();
        await PlanItem.create({
            userId: id, type: 'lifestyle', condition: 'sleep',
            title: 'Aim for more sleep — your markers suggest you are running short',
            dueDate: new Date('2026-09-01'),
        });

        const { body } = await call(sleepController.getPlan, { user: { id: String(id) } });
        expect(body.plan.goalMinutes).toBe(targets.BASELINE_MINUTES + 30);
        expect(body.plan.guidance.map((g) => g.key)).toContain('extend_sleep');
    });

    it('rescores the stored nights when the goal moves', async () => {
        const id = userId();
        await ingestBatch({
            userId: id, platform: 'health_connect', tzOffset: 0, sleep: [night()], goalMinutes: 480,
        });

        const before = await SleepSession.findOne({ userId: id }).lean();

        await call(sleepController.updatePlan, {
            user: { id: String(id) },
            body: { goalMinutes: 600 },
        });

        const after = await SleepSession.findOne({ userId: id }).lean();
        expect(after.score).not.toBe(before.score);
        // The rollup the trend chart reads has to move with it, or the two disagree.
        const rollup = await DailyMetrics.findOne({ userId: id, day: '2026-08-20' }).lean();
        expect(rollup.sleep.score).toBe(after.score);
    });

    it('refuses to let a client write the guidance derived from the health plan', async () => {
        const id = userId();
        await PlanItem.create({
            userId: id, type: 'lifestyle', condition: 'sleep', title: 'Increase sleep',
            dueDate: new Date('2026-09-01'),
        });
        await call(sleepController.getPlan, { user: { id: String(id) } });

        await call(sleepController.updatePlan, {
            user: { id: String(id) },
            body: { guidance: [] },
        });

        const plan = await SleepPlan.findOne({ userId: id }).lean();
        expect(plan.guidance).toHaveLength(1);
    });

    it('the overview falls back to the most recent night when today has not synced', async () => {
        const id = userId();
        await ingestBatch({
            userId: id, platform: 'health_connect', tzOffset: 0, sleep: [night()], goalMinutes: 480,
        });

        const { body } = await call(sleepController.getOverview, {
            user: { id: String(id) },
            // A day well after the night, so nothing is filed under "today".
            query: { day: '2026-08-25', range: '1m', tzOffset: '0' },
        });

        expect(body.isToday).toBe(false);
        expect(body.latest.day).toBe('2026-08-20');
    });

    it('refuses to edit the measurements on a night a watch recorded', async () => {
        const id = userId();
        await ingestBatch({
            userId: id, platform: 'health_connect', tzOffset: 0, sleep: [night()], goalMinutes: 480,
        });
        const row = await SleepSession.findOne({ userId: id }).lean();

        const { code, body } = await call(sleepController.updateNight, {
            user: { id: String(id) },
            params: { id: String(row._id) },
            body: { asleepMin: 600 },
        });

        expect(code).toBe(409);
        expect(body.editable).toEqual(['notes']);
    });

    it('a hand-typed night gets no efficiency invented for it', async () => {
        const id = userId();

        const { code, body } = await call(sleepController.createNight, {
            user: { id: String(id) },
            body: {
                startedAt: '2026-08-19T23:00:00.000Z',
                endedAt: '2026-08-20T07:00:00.000Z',
                tzOffset: 0,
            },
        });

        expect(code).toBe(201);
        // 100% asleep-in-bed for everyone who typed one figure would flatter every entry.
        expect(body.night.efficiency).toBeNull();
        expect(body.night.editable).toBe(true);
        expect(body.night.day).toBe('2026-08-20');
    });

    it('refuses a night whose time asleep does not fit inside its time in bed', async () => {
        const { code } = await call(sleepController.createNight, {
            user: { id: String(userId()) },
            body: {
                startedAt: '2026-08-19T23:00:00.000Z',
                endedAt: '2026-08-20T03:00:00.000Z',
                asleepMin: 600,
            },
        });
        expect(code).toBe(400);
    });

    it('says a deleted synced night will come back', async () => {
        const id = userId();
        await ingestBatch({
            userId: id, platform: 'health_connect', tzOffset: 0, sleep: [night()], goalMinutes: 480,
        });
        const row = await SleepSession.findOne({ userId: id }).lean();

        const { body } = await call(sleepController.deleteNight, {
            user: { id: String(id) },
            params: { id: String(row._id) },
        });

        expect(body.willResync).toBe(true);
    });
});

/* ------------------------------------------ two apps, one night */

describe('two apps writing the same night', () => {
    /**
     * The real case this came from: Health Sync mirrors a wearable into Health Connect and
     * Google Fit republishes it, so one night arrives as two records with different UUIDs.
     * `externalId` cannot see they are the same night; overlapping clock time can.
     */
    const pair = (over = {}) => ([
        {
            externalId: '7ec344a5-4dc9-4533-a67c-c5b299f9fbc9',
            startedAt: '2026-09-04T21:52:00.000Z',
            endedAt: '2026-09-05T05:22:00.000Z',
            sourceDevice: { name: 'nl.appyhapps.healthsync' },
            ...over.a,
        },
        {
            externalId: 'b67515b4-9ab2-3bc3-85e2-b57b556dcf1b',
            startedAt: '2026-09-04T21:52:00.000Z',
            endedAt: '2026-09-05T05:22:00.000Z',
            sourceDevice: { name: 'com.google.android.apps.fitness' },
            ...over.b,
        },
    ]);

    it('stores one night, not two', async () => {
        const id = userId();
        await ingestBatch({
            userId: id, platform: 'health_connect', tzOffset: 0, sleep: pair(), goalMinutes: 480,
        });

        const rows = await SleepSession.find({ userId: id }).lean();
        expect(rows).toHaveLength(1);
    });

    it('keeps the record that carries a hypnogram', async () => {
        const id = userId();
        // Only Health Sync reports stages; Google Fit's copy is a bare duration.
        await ingestBatch({
            userId: id,
            platform: 'health_connect',
            tzOffset: 0,
            goalMinutes: 480,
            sleep: pair({
                a: {
                    segments: [
                        { stage: 'deep', startedAt: '2026-09-04T21:52:00.000Z', endedAt: '2026-09-04T23:30:00.000Z' },
                        { stage: 'rem', startedAt: '2026-09-04T23:30:00.000Z', endedAt: '2026-09-05T05:22:00.000Z' },
                    ],
                },
            }),
        });

        const rows = await SleepSession.find({ userId: id }).lean();
        expect(rows).toHaveLength(1);
        expect(rows[0].externalId).toBe('7ec344a5-4dc9-4533-a67c-c5b299f9fbc9');
        expect(rows[0].stages.deepMin).toBe(98);
    });

    it('picks the same winner however the two are ordered', async () => {
        // Arrival order must not decide it: both apps write on every sync, and a rule that
        // depended on order would flip the stored row — and the day's score with it.
        const [a, b] = pair();
        const forward = userId();
        const reverse = userId();

        await ingestBatch({ userId: forward, platform: 'health_connect', tzOffset: 0, sleep: [a, b] });
        await ingestBatch({ userId: reverse, platform: 'health_connect', tzOffset: 0, sleep: [b, a] });

        const one = await SleepSession.findOne({ userId: forward }).lean();
        const two = await SleepSession.findOne({ userId: reverse }).lean();
        expect(one.externalId).toBe(two.externalId);
    });

    it('removes a duplicate that was already stored before the rule existed', async () => {
        const id = userId();
        const [a, b] = pair();

        // Simulate the pre-fix state: both rows in the database.
        await ingestBatch({ userId: id, platform: 'health_connect', tzOffset: 0, sleep: [a] });
        await SleepSession.create({
            userId: id,
            startedAt: new Date(b.startedAt),
            endedAt: new Date(b.endedAt),
            day: '2026-09-05',
            asleepMin: 450,
            source: 'health_connect',
            externalId: b.externalId,
        });
        expect(await SleepSession.countDocuments({ userId: id })).toBe(2);

        // The next ordinary sync sees both and collapses them.
        await ingestBatch({ userId: id, platform: 'health_connect', tzOffset: 0, sleep: [a, b] });
        expect(await SleepSession.countDocuments({ userId: id })).toBe(1);
    });

    it('leaves a genuine nap alone', async () => {
        const id = userId();
        await ingestBatch({
            userId: id,
            platform: 'health_connect',
            tzOffset: 0,
            goalMinutes: 480,
            sleep: [
                ...pair(),
                {
                    externalId: 'nap-1',
                    startedAt: '2026-09-05T10:07:00.000Z',
                    endedAt: '2026-09-05T10:42:00.000Z',
                },
            ],
        });

        // The night collapses to one; the nap does not overlap it and survives.
        const rows = await SleepSession.find({ userId: id }).sort({ startedAt: 1 }).lean();
        expect(rows).toHaveLength(2);
        expect(rows[1].asleepMin).toBe(35);
    });

    it('leaves two adjacent stretches of a split night alone', async () => {
        const id = userId();
        await ingestBatch({
            userId: id,
            platform: 'health_connect',
            tzOffset: 0,
            sleep: [
                { externalId: 'part-1', startedAt: '2026-09-04T22:00:00.000Z', endedAt: '2026-09-05T01:00:00.000Z' },
                { externalId: 'part-2', startedAt: '2026-09-05T01:30:00.000Z', endedAt: '2026-09-05T06:00:00.000Z' },
            ],
        });
        // They touch but do not overlap: a watch splitting a disturbed night, not a duplicate.
        expect(await SleepSession.countDocuments({ userId: id })).toBe(2);
    });
});

describe('the overlap rule', () => {
    it('treats the same window as the same night', () => {
        expect(healthSync.sameNight(
            { startedAt: '2026-09-04T22:00:00Z', endedAt: '2026-09-05T06:00:00Z' },
            { startedAt: '2026-09-04T22:00:00Z', endedAt: '2026-09-05T06:00:00Z' },
        )).toBe(true);
    });

    it('treats a short nap inside a long night as part of it', () => {
        expect(healthSync.sameNight(
            { startedAt: '2026-09-04T22:00:00Z', endedAt: '2026-09-05T06:00:00Z' },
            { startedAt: '2026-09-05T02:00:00Z', endedAt: '2026-09-05T02:40:00Z' },
        )).toBe(true);
    });

    it('does not merge sessions that merely touch', () => {
        expect(healthSync.sameNight(
            { startedAt: '2026-09-04T22:00:00Z', endedAt: '2026-09-05T01:00:00Z' },
            { startedAt: '2026-09-05T01:00:00Z', endedAt: '2026-09-05T06:00:00Z' },
        )).toBe(false);
    });

    it('does not merge an afternoon nap into the night before', () => {
        expect(healthSync.sameNight(
            { startedAt: '2026-09-04T22:00:00Z', endedAt: '2026-09-05T06:00:00Z' },
            { startedAt: '2026-09-05T14:00:00Z', endedAt: '2026-09-05T14:30:00Z' },
        )).toBe(false);
    });
});

/* -------------------------------------------------------- the reminder */

describe('bedtime reminders', () => {
    it('does not stamp a schedule for an account with no device', async () => {
        const id = userId();
        // 22:30 bedtime, reminded 30 minutes before, in UTC.
        await SleepSchedule.create({
            userId: id, name: 'Weeknights', bedtimeMin: 22 * 60 + 30, wakeMin: 6 * 60 + 30,
            remindMinutesBefore: 30, tzOffset: 0,
        });

        const result = await runSleepReminders(new Date('2026-08-19T22:00:00.000Z'));

        expect(result.sent).toBe(0);
        expect(result.suppressed).toBe(1);
        // Not burned: enabling notifications five minutes later must still reach them.
        const row = await SleepSchedule.findOne({ userId: id }).lean();
        expect(row.lastRemindedAt).toBeNull();
    });

    it('ignores a schedule that is not active on this weekday', async () => {
        const id = userId();
        await SleepSchedule.create({
            userId: id, bedtimeMin: 22 * 60 + 30, wakeMin: 6 * 60 + 30,
            // 2026-08-19 is a Wednesday (3). This one only runs at weekends.
            days: [0, 6], remindMinutesBefore: 30, tzOffset: 0,
        });

        const result = await runSleepReminders(new Date('2026-08-19T22:00:00.000Z'));
        expect(result.considered).toBe(0);
    });

    it('writes off a reminder that is hours late rather than sending it at 3am', async () => {
        const id = userId();
        await SleepSchedule.create({
            userId: id, bedtimeMin: 22 * 60 + 30, wakeMin: 6 * 60 + 30,
            remindMinutesBefore: 30, tzOffset: 0,
        });

        const result = await runSleepReminders(new Date('2026-08-20T03:00:00.000Z'));
        expect(result.considered).toBe(0);
    });
});
