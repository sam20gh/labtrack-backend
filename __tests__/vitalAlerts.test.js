/**
 * Out-of-range vital signs: the table, the record, the patient's card, the clinician's review.
 *
 * What has to hold:
 *   - Blood pressure alerts exactly where `bloodPressure.classify` stages 2 and crisis, and
 *     nowhere else. A threshold of its own would drift from the metrics screen.
 *   - Heart rate is only judged at rest. A run is not tachycardia.
 *   - The copy describes the reading, never names a condition, and every urgent card says
 *     what to do if you feel unwell.
 *   - A re-sync changes nothing. Same readings, same episode, no second card.
 *   - A backfill goes on the record but does not notify the patient about last month.
 *   - A reading the patient deletes is withdrawn, and an all-typo episode leaves the worklist.
 *   - A review closes the episode once. The next reading opens a new one.
 *   - An open alert lets a clinician open that patient, and nothing else does.
 */
const mongoose = require('mongoose');

jest.mock('../utils/pushSender', () => {
    const actual = jest.requireActual('../utils/pushSender');
    return {
        ...actual,
        send: jest.fn(async (messages) => ({ sent: messages.length, failed: 0, pruned: 0 })),
    };
});
// Both run unawaited from the write paths and have their own suites.
jest.mock('../controllers/scoreController', () => ({ touch: jest.fn() }));
jest.mock('../controllers/achievementController', () => ({ touch: jest.fn() }));

const pushSender = require('../utils/pushSender');
const User = require('../models/userModel');
const Notification = require('../models/Notification');
const VitalAlert = require('../models/VitalAlert');
const MetricLog = require('../models/MetricLog');
const table = require('../utils/vitalAlerts');
const { recordReadings, withdrawReading } = require('../utils/vitalAlertCentre');
const { CATEGORIES } = require('../utils/notificationCatalogue');
const bp = require('../utils/bloodPressure');
const { requireReviewScope } = require('../middleware/reviewScope');
const review = require('../controllers/reviewController');
const metrics = require('../controllers/metricsController');
const wearables = require('../controllers/wearableController');

const TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]';
const NOW = new Date('2026-09-28T12:00:00Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600_000);

const mockRes = () => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
};

let userId;

beforeEach(async () => {
    pushSender.send.mockClear();
    await VitalAlert.init();
    userId = new mongoose.Types.ObjectId();
    await User.create({
        _id: userId,
        username: `u${userId}`,
        email: `${userId}@example.com`,
        password: 'x',
        firstName: 'Pat',
        lastName: 'Vitals',
        pushTokens: [{ token: TOKEN, platform: 'ios' }],
    });
});

const bpReading = (systolic, diastolic, at = hoursAgo(1), extra = {}) =>
    ({ metric: 'blood_pressure', measuredAt: at, systolic, diastolic, source: 'manual', ...extra });
const spo2Reading = (spo2, at = hoursAgo(1), extra = {}) =>
    ({ metric: 'spo2', measuredAt: at, spo2, source: 'bracelet', ...extra });
const hrReading = (bpm, context = 'resting', at = hoursAgo(1), extra = {}) =>
    ({ metric: 'heart_rate', measuredAt: at, bpm, context, source: 'bracelet', ...extra });

/* ------------------------------------------------------------------ *
 * The table
 * ------------------------------------------------------------------ */

describe('the threshold table', () => {
    it('alerts on blood pressure exactly where the metrics screen stages 2 and crisis', () => {
        const pairs = [];
        for (let s = 90; s <= 220; s += 5) for (let d = 50; d <= 130; d += 5) if (s > d) pairs.push([s, d]);

        for (const [s, d] of pairs) {
            const staged = bp.classify(s, d)?.key;
            const hit = table.evaluateOne(bpReading(s, d));
            const expected = staged === 'crisis' ? 'urgent' : staged === 'stage_2' ? 'attention' : undefined;
            expect([`${s}/${d}`, hit?.level]).toEqual([`${s}/${d}`, expected]);
        }
    });

    it('does not alert on stage 1 or elevated, which cover most adults', () => {
        expect(table.evaluateOne(bpReading(135, 85))).toBeNull();
        expect(table.evaluateOne(bpReading(125, 75))).toBeNull();
    });

    it('stages 118/92 as attention on its diastolic alone', () => {
        expect(table.evaluateOne(bpReading(118, 92)).level).toBe('attention');
    });

    it('alerts on low oxygen, at the NEWS2 steps', () => {
        expect(table.evaluateOne(spo2Reading(95))).toBeNull();
        expect(table.evaluateOne(spo2Reading(94))).toBeNull();
        expect(table.evaluateOne(spo2Reading(93)).level).toBe('attention');
        expect(table.evaluateOne(spo2Reading(92)).level).toBe('attention');
        expect(table.evaluateOne(spo2Reading(91)).level).toBe('urgent');
        // A wrist sensor cannot read below ~70; the vendor sends 0 for a failed sample.
        expect(table.evaluateOne(spo2Reading(0))).toBeNull();
        expect(table.evaluateOne(spo2Reading(65))).toBeNull();
    });

    it('judges heart rate only at rest', () => {
        expect(table.evaluateOne(hrReading(100))).toBeNull();
        expect(table.evaluateOne(hrReading(101)).level).toBe('attention');
        expect(table.evaluateOne(hrReading(131)).level).toBe('urgent');
        expect(table.evaluateOne(hrReading(115, 'sleeping')).level).toBe('attention');
        expect(table.evaluateOne(hrReading(115, 'manual')).level).toBe('attention');
        // 160 on a run is the point of the run.
        expect(table.evaluateOne(hrReading(160, 'active'))).toBeNull();
        expect(table.evaluateOne(hrReading(140, 'recovery'))).toBeNull();
        expect(table.evaluateOne(hrReading(140, null))).toBeNull();
    });

    it('alerts on a low resting heart rate, softer than NEWS2', () => {
        expect(table.evaluateOne(hrReading(41))).toBeNull();
        expect(table.evaluateOne(hrReading(40)).level).toBe('attention');
        expect(table.evaluateOne(hrReading(38, 'sleeping')).level).toBe('attention');
        expect(table.evaluateOne(hrReading(31)).level).toBe('attention');
        expect(table.evaluateOne(hrReading(30)).level).toBe('urgent');
        // A low rate during a workout reading is a sensor dropout, not a finding.
        expect(table.evaluateOne(hrReading(35, 'active'))).toBeNull();
    });

    it('drops the ≤40 band, and keeps ≤30, when a clinician expects a low rate', () => {
        const athlete = { lowHeartRateExpected: true };
        expect(table.evaluateOne(hrReading(36), athlete)).toBeNull();
        expect(table.evaluateOne(hrReading(30), athlete).level).toBe('urgent');
        expect(table.evaluateOne(hrReading(120), athlete).level).toBe('attention');
    });

    it('moves SpO2 to NEWS2 scale 2 for a hypercapnic target', () => {
        const copd = { spo2Scale: 'hypercapnic' };
        for (const v of [93, 92, 90, 88, 86]) expect(table.evaluateOne(spo2Reading(v), copd)).toBeNull();
        expect(table.evaluateOne(spo2Reading(85), copd)).toMatchObject({ level: 'attention', rule: 'spo2.scale2_at_most_85' });
        expect(table.evaluateOne(spo2Reading(83), copd)).toMatchObject({ level: 'urgent', rule: 'spo2.scale2_at_most_83' });
    });

    it('never lets a target alert where the defaults would not', () => {
        // The centre skips the targets read when the defaults find nothing; this is what
        // makes that safe.
        const targets = [{ spo2Scale: 'hypercapnic' }, { lowHeartRateExpected: true }, { spo2Scale: 'hypercapnic', lowHeartRateExpected: true }];
        for (let v = 70; v <= 100; v++) {
            for (const t of targets) {
                if (table.evaluateOne(spo2Reading(v), t)) expect(table.evaluateOne(spo2Reading(v))).not.toBeNull();
            }
        }
        for (let bpm = 20; bpm <= 200; bpm++) {
            for (const t of targets) {
                if (table.evaluateOne(hrReading(bpm), t)) expect(table.evaluateOne(hrReading(bpm))).not.toBeNull();
            }
        }
    });

    it('treats only the last day as fresh', () => {
        expect(table.isFresh(hoursAgo(23), NOW)).toBe(true);
        expect(table.isFresh(hoursAgo(25), NOW)).toBe(false);
        expect(table.isFresh(new Date(NOW.getTime() + 30 * 60_000), NOW)).toBe(true);
        expect(table.isFresh(new Date(NOW.getTime() + 3 * 3600_000), NOW)).toBe(false);
    });
});

describe('the copy', () => {
    // One reading that fires each rule, so every entry in COPY is exercised.
    const FIRING = {
        'blood_pressure.stage_2': [bpReading(152, 94, NOW, { method: 'optical_estimate' })],
        'blood_pressure.crisis': [bpReading(186, 94)],
        'spo2.at_most_93': [spo2Reading(93)],
        'spo2.at_most_91': [spo2Reading(88)],
        'spo2.scale2_at_most_85': [spo2Reading(85), { spo2Scale: 'hypercapnic' }],
        'spo2.scale2_at_most_83': [spo2Reading(80), { spo2Scale: 'hypercapnic' }],
        'heart_rate.resting_over_100': [hrReading(110)],
        'heart_rate.resting_at_least_131': [hrReading(140)],
        'heart_rate.resting_at_most_40': [hrReading(38)],
        'heart_rate.resting_at_most_30': [hrReading(28)],
    };
    const cases = table.RULES.map((rule) => {
        const [reading, targets] = FIRING[rule] || [];
        const evaluated = reading && table.evaluate([reading], targets)[0];
        return [rule, evaluated?.level, evaluated && table.copyFor(evaluated)];
    });

    it('has a firing reading, and copy, for every rule', () => {
        expect(Object.keys(FIRING).sort()).toEqual([...table.RULES].sort());
        for (const [rule, , copy] of cases) expect([rule, Boolean(copy)]).toEqual([rule, true]);
        for (const [rule] of cases) expect(table.evaluate([FIRING[rule][0]], FIRING[rule][1])[0].rule).toBe(rule);
    });

    it.each(cases)('%s fits the card', (rule, level, copy) => {
        expect(copy.title.length).toBeLessThanOrEqual(80);
        expect(copy.body.length).toBeLessThanOrEqual(240);
        expect(copy.body).toContain(copy.chip);
    });

    it.each(cases)('%s never names a condition', (rule, level, copy) => {
        const text = `${copy.title} ${copy.body}`.toLowerCase();
        for (const word of ['hypertension', 'tachycardia', 'bradycardia', 'hypoxia', 'hypoxaemia', 'hypoxemia', 'arrhythmia', 'copd']) {
            expect(text).not.toContain(word);
        }
        // "If you have chest pain" is advice; "you have high blood pressure" is a diagnosis.
        expect(text).not.toMatch(/(?<!if )you have/);
    });

    it.each(cases.filter(([, level]) => level === 'urgent'))('%s says when to seek care', (rule, level, copy) => {
        expect(copy.body).toMatch(/seek emergency care now/i);
    });

    it('names the bracelet when the blood pressure is an estimate', () => {
        const [estimate] = table.evaluate([bpReading(152, 94, NOW, { method: 'optical_estimate' })]);
        const [cuff] = table.evaluate([bpReading(152, 94, NOW, { method: 'cuff' })]);
        expect(table.copyFor(estimate).body).toMatch(/^Your bracelet estimated/);
        expect(table.copyFor(cuff).body).toMatch(/^You logged/);
    });

    it('routes to the screen the metrics dashboard opens for that card', () => {
        expect(table.METRIC_ROUTE).toEqual({
            blood_pressure: '/metrics/blood-pressure',
            heart_rate: '/activity',
            spo2: '/bracelet',
        });
        expect(CATEGORIES[table.CATEGORY_FOR_LEVEL.urgent].priority).toBe('critical');
        expect(CATEGORIES[table.CATEGORY_FOR_LEVEL.attention].priority).toBe('normal');
    });

    it('has review wording for every outcome, never naming a condition', () => {
        expect(Object.keys(table.REVIEW_COPY).sort()).toEqual([...VitalAlert.OUTCOMES].sort());
        for (const metric of table.METRICS) {
            for (const outcome of VitalAlert.OUTCOMES) {
                const copy = table.reviewCopyFor(metric, outcome);
                expect(copy.title.length).toBeLessThanOrEqual(80);
                expect(copy.body.length).toBeLessThanOrEqual(240);
                expect(copy.body.toLowerCase()).not.toMatch(/hypertension|tachycardia|bradycardia|copd/);
            }
        }
        expect(table.reviewCopyFor('spo2', 'escalated').body).toMatch(/seek emergency care/);
    });
});

/* ------------------------------------------------------------------ *
 * The record and the card
 * ------------------------------------------------------------------ */

describe('recording readings', () => {
    it('writes nothing for readings in range', async () => {
        const result = await recordReadings(userId, [bpReading(118, 76), spo2Reading(97), hrReading(64)], { now: NOW });
        expect(result.alerts).toHaveLength(0);
        expect(await VitalAlert.countDocuments()).toBe(0);
        expect(await Notification.countDocuments()).toBe(0);
    });

    it('opens an episode on the record and puts a card in front of the patient', async () => {
        await recordReadings(userId, [bpReading(152, 96, hoursAgo(1), { logId: new mongoose.Types.ObjectId() })], { now: NOW });

        const alert = await VitalAlert.findOne({ userId }).lean();
        expect(alert).toMatchObject({ metric: 'blood_pressure', level: 'attention', status: 'open', readingCount: 1 });
        expect(alert.worst).toMatchObject({ systolic: 152, diastolic: 96, category: 'stage_2' });
        expect(alert.notified).toHaveLength(1);
        expect(alert.notified[0].pushed).toBe(true);

        const card = await Notification.findOne({ userId }).lean();
        expect(card.category).toBe('vitals_review');
        expect(card.route).toBe('/metrics/blood-pressure');
        expect(card.chip.label).toBe('152/96 mmHg');
        expect(card.data.alertId).toBe(String(alert._id));
        expect(pushSender.send).toHaveBeenCalledTimes(1);
    });

    it('folds a night of low oxygen into one episode and one card', async () => {
        const night = [97, 93, 92, 93, 96].map((v, i) =>
            spo2Reading(v, hoursAgo(8 - i), { externalId: `o${i}` }));
        await recordReadings(userId, night, { now: NOW });

        expect(await VitalAlert.countDocuments()).toBe(1);
        const alert = await VitalAlert.findOne().lean();
        expect(alert.readingCount).toBe(3);
        expect(alert.worst.spo2).toBe(92);
        expect(await Notification.countDocuments()).toBe(1);
        expect((await Notification.findOne().lean()).chip.label).toBe('92%');
    });

    it('is idempotent across a re-sync', async () => {
        const batch = [spo2Reading(90, hoursAgo(2), { externalId: 'x1' }), spo2Reading(93, hoursAgo(1), { externalId: 'x2' })];
        await recordReadings(userId, batch, { now: NOW });
        pushSender.send.mockClear();

        await recordReadings(userId, batch, { now: NOW });

        const alert = await VitalAlert.findOne().lean();
        expect(alert.readingCount).toBe(2);
        expect(alert.readings).toHaveLength(2);
        expect(await Notification.countDocuments()).toBe(1);
        expect(pushSender.send).not.toHaveBeenCalled();
    });

    it('escalates the episode, and urgent supersedes attention for the day', async () => {
        await recordReadings(userId, [hrReading(108, 'resting', hoursAgo(3), { externalId: 'h1' })], { now: NOW });
        await recordReadings(userId, [hrReading(138, 'resting', hoursAgo(2), { externalId: 'h2' })], { now: NOW });
        await recordReadings(userId, [hrReading(106, 'resting', hoursAgo(1), { externalId: 'h3' })], { now: NOW });

        const alert = await VitalAlert.findOne().lean();
        expect(alert.level).toBe('urgent');
        expect(alert.readingCount).toBe(3);
        expect(alert.worst.bpm).toBe(138);

        const cards = await Notification.find().sort({ createdAt: 1 }).lean();
        expect(cards.map((c) => c.category)).toEqual(['vitals_review', 'vitals']);
    });

    it('never rewrites a card to a milder reading', async () => {
        await recordReadings(userId, [spo2Reading(92, hoursAgo(3), { externalId: 'a' })], { now: NOW });
        pushSender.send.mockClear();
        await recordReadings(userId, [spo2Reading(93, hoursAgo(1), { externalId: 'b' })], { now: NOW });

        expect((await Notification.findOne().lean()).chip.label).toBe('92%');
        expect(pushSender.send).not.toHaveBeenCalled();
    });

    it('records a backfill for the clinician without telling the patient about last month', async () => {
        await recordReadings(userId, [bpReading(190, 125, hoursAgo(24 * 20), { externalId: 'old' })], { now: NOW });

        const alert = await VitalAlert.findOne().lean();
        expect(alert).toMatchObject({ level: 'urgent', status: 'open' });
        expect(alert.notified).toHaveLength(0);
        expect(await Notification.countDocuments()).toBe(0);
    });

    it('carries the optical-estimate flag onto the episode', async () => {
        await recordReadings(userId, [bpReading(185, 110, hoursAgo(1), { method: 'optical_estimate', source: 'bracelet', externalId: 'e' })], { now: NOW });
        expect((await VitalAlert.findOne().lean()).hasEstimate).toBe(true);
    });

    it('keeps one open episode per metric when two syncs race', async () => {
        await Promise.all([
            recordReadings(userId, [spo2Reading(90, hoursAgo(2), { externalId: 'r1' })], { now: NOW }),
            recordReadings(userId, [spo2Reading(91, hoursAgo(1), { externalId: 'r2' })], { now: NOW }),
        ]);
        expect(await VitalAlert.countDocuments({ isOpen: true })).toBe(1);
    });

    it('never throws at the caller', async () => {
        const spy = jest.spyOn(VitalAlert, 'findOne').mockRejectedValueOnce(new Error('db down'));
        const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
        await expect(recordReadings(userId, [spo2Reading(88)], { now: NOW }))
            .resolves.toEqual({ alerts: [], notified: 0 });
        spy.mockRestore();
        errors.mockRestore();
    });
});

describe('a reading the patient deletes', () => {
    it('is withdrawn, and an episode of nothing but typos leaves the worklist', async () => {
        const logId = new mongoose.Types.ObjectId();
        await recordReadings(userId, [bpReading(250, 150, hoursAgo(1), { logId })], { now: NOW });

        await withdrawReading(userId, { logId });

        const alert = await VitalAlert.findOne().lean();
        expect(alert).toMatchObject({ status: 'withdrawn', isOpen: false });
        // Still visible to anyone who looks, and marked.
        expect(alert.readings[0].withdrawnAt).toBeTruthy();
    });

    it('recomputes around the withdrawn reading when others stand', async () => {
        const typo = new mongoose.Types.ObjectId();
        await recordReadings(userId, [
            bpReading(250, 150, hoursAgo(2), { logId: typo }),
            bpReading(148, 92, hoursAgo(1), { logId: new mongoose.Types.ObjectId() }),
        ], { now: NOW });

        await withdrawReading(userId, { logId: typo });

        const alert = await VitalAlert.findOne().lean();
        expect(alert).toMatchObject({ status: 'open', level: 'attention' });
        expect(alert.worst.systolic).toBe(148);
    });

    it('is withdrawn through the real delete route', async () => {
        const res = mockRes();
        await metrics.logBloodPressure({ auth: { userId: String(userId) }, body: { systolic: 250, diastolic: 150, tzOffset: 0 } }, res);
        expect(res.status).toHaveBeenCalledWith(201);
        expect(await VitalAlert.countDocuments({ isOpen: true })).toBe(1);

        const log = await MetricLog.findOne({ userId }).lean();
        await metrics.deleteLog({ auth: { userId: String(userId) }, params: { id: String(log._id) } }, mockRes());

        expect(await VitalAlert.countDocuments({ isOpen: true })).toBe(0);
    });
});

/* ------------------------------------------------------------------ *
 * The write paths
 * ------------------------------------------------------------------ */

describe('the write paths', () => {
    it('a bracelet sync records low oxygen and a high resting heart rate, and ignores a run', async () => {
        const recent = new Date(Date.now() - 30 * 60_000).toISOString();
        const res = mockRes();
        await wearables.sync({
            user: { id: String(userId) },
            body: {
                platform: 'jstyle_bracelet',
                tzOffset: 0,
                spo2: [{ externalId: 's1', measuredAt: recent, spo2: 89 }],
                heart: [
                    { externalId: 'h1', measuredAt: recent, bpm: 118, context: 'resting' },
                    { externalId: 'h2', measuredAt: recent, bpm: 170, context: 'active' },
                ],
                bloodPressure: [{ externalId: 'b1', measuredAt: recent, systolic: 122, diastolic: 78, method: 'optical_estimate' }],
            },
        }, res);

        expect(res.status).not.toHaveBeenCalled();
        const alerts = await VitalAlert.find().sort({ metric: 1 }).lean();
        expect(alerts.map((a) => [a.metric, a.level])).toEqual([['heart_rate', 'attention'], ['spo2', 'urgent']]);
        expect(alerts.every((a) => a.readings[0].source === 'bracelet')).toBe(true);

        const categories = (await Notification.find().lean()).map((n) => n.category).sort();
        expect(categories).toEqual(['vitals', 'vitals_review']);
    });

    it('a manual crisis reading notifies at critical priority', async () => {
        await metrics.logBloodPressure({
            auth: { userId: String(userId) },
            body: { systolic: 192, diastolic: 124, tzOffset: 0 },
        }, mockRes());

        const card = await Notification.findOne().lean();
        expect(card.category).toBe('vitals');
        expect(card.actions.map((a) => a.label)).toEqual(['View readings']);
        const alert = await VitalAlert.findOne().lean();
        expect(alert.readings[0]).toMatchObject({ source: 'manual', method: 'cuff' });
    });
});

/* ------------------------------------------------------------------ *
 * The clinician
 * ------------------------------------------------------------------ */

describe('clinician review', () => {
    const doctor = (id = new mongoose.Types.ObjectId()) =>
        ({ userId: String(id), role: 'professional', email: 'doc@example.com' });

    const openAlert = async () => {
        await recordReadings(userId, [bpReading(160, 100, hoursAgo(1), { externalId: `p${Math.random()}` })], { now: NOW });
        return VitalAlert.findOne({ isOpen: true }).lean();
    };

    it('lists open alerts, urgent first, and logs the read with a count', async () => {
        await openAlert();
        await recordReadings(userId, [spo2Reading(88, hoursAgo(1), { externalId: 'q' })], { now: NOW });

        const res = mockRes();
        await review.getVitalAlerts({ auth: doctor(), query: {} }, res);

        const body = res.json.mock.calls[0][0];
        expect(body.alerts.map((a) => a.level)).toEqual(['urgent', 'attention']);
        expect(body.counts).toEqual({ openUrgent: 1, openAttention: 1 });
        expect(body.alerts[0].patient.lastName).toBe('Vitals');
        expect(body.alerts[1].worst.value).toBe('160/100 mmHg');

        const AccessLog = require('../models/AccessLog');
        const entry = await AccessLog.findOne({ resource: 'vital_alerts' }).lean();
        expect(entry.count).toBe(2);
    });

    it('closes an episode once, and the next reading opens a new one', async () => {
        const alert = await openAlert();
        const me = doctor();

        const res = mockRes();
        await review.reviewVitalAlert({
            auth: me, params: { alertId: String(alert._id) },
            body: { outcome: 'advised_patient', note: 'Called; repeat readings at home for a week.' },
        }, res);
        expect(res.status).not.toHaveBeenCalled();
        expect(res.json.mock.calls[0][0].alert.review).toMatchObject({ outcome: 'advised_patient' });

        const second = mockRes();
        await review.reviewVitalAlert({
            auth: doctor(), params: { alertId: String(alert._id) }, body: { outcome: 'no_action', note: 'x' },
        }, second);
        expect(second.status).toHaveBeenCalledWith(409);

        await recordReadings(userId, [bpReading(158, 98, hoursAgo(0.5), { externalId: 'later' })], { now: NOW });
        expect(await VitalAlert.countDocuments()).toBe(2);
        expect(await VitalAlert.countDocuments({ isOpen: true })).toBe(1);
    });

    it('requires an outcome, and a reason for setting an alert aside', async () => {
        const alert = await openAlert();

        const noOutcome = mockRes();
        await review.reviewVitalAlert({ auth: doctor(), params: { alertId: String(alert._id) }, body: {} }, noOutcome);
        expect(noOutcome.status).toHaveBeenCalledWith(400);

        const noNote = mockRes();
        await review.reviewVitalAlert({ auth: doctor(), params: { alertId: String(alert._id) }, body: { outcome: 'measurement_error' } }, noNote);
        expect(noNote.status).toHaveBeenCalledWith(400);
    });

    it('puts the alerts on the patient record', async () => {
        await openAlert();
        const res = mockRes();
        await review.getPatientContext({ auth: doctor(), params: { userId: String(userId) } }, res);
        const body = res.json.mock.calls[0][0];
        expect(body.vitalAlerts).toHaveLength(1);
        expect(body.vitalAlerts[0].readings[0].value).toBe('160/100 mmHg');
    });

    describe('scope', () => {
        const reach = async (auth) => {
            const next = jest.fn();
            const res = mockRes();
            await requireReviewScope({ auth, params: { userId: String(userId) } }, res, next);
            return { next, res };
        };

        it('lets any clinician open a patient with an open alert', async () => {
            await openAlert();
            const { next } = await reach(doctor());
            expect(next).toHaveBeenCalled();
        });

        it('lets the reviewing clinician back in afterwards, and nobody else', async () => {
            const alert = await openAlert();
            const me = doctor();
            await review.reviewVitalAlert({
                auth: me, params: { alertId: String(alert._id) },
                body: { outcome: 'appointment', note: '' },
            }, mockRes());

            expect((await reach(me)).next).toHaveBeenCalled();
            const stranger = await reach(doctor());
            expect(stranger.next).not.toHaveBeenCalled();
            expect(stranger.res.status).toHaveBeenCalledWith(404);
        });

        it('does not open a patient whose only alert was withdrawn', async () => {
            const logId = new mongoose.Types.ObjectId();
            await recordReadings(userId, [bpReading(250, 150, hoursAgo(1), { logId })], { now: NOW });
            await withdrawReading(userId, { logId });

            expect((await reach(doctor())).next).not.toHaveBeenCalled();
        });
    });
});

/* ------------------------------------------------------------------ *
 * Clinician-set targets
 * ------------------------------------------------------------------ */

describe('clinician-set targets', () => {
    const VitalTarget = require('../models/VitalTarget');
    const doctor = () => ({ userId: String(new mongoose.Types.ObjectId()), role: 'professional', email: 'doc@example.com' });

    it('a COPD patient at 90% raises nothing; at 84% raises the scale 2 alert', async () => {
        await VitalTarget.create({ userId, spo2Scale: 'hypercapnic', reason: 'COPD, LTOT' });

        await recordReadings(userId, [spo2Reading(90, hoursAgo(2), { externalId: 'c1' })], { now: NOW });
        expect(await VitalAlert.countDocuments()).toBe(0);

        await recordReadings(userId, [spo2Reading(84, hoursAgo(1), { externalId: 'c2' })], { now: NOW });
        const alert = await VitalAlert.findOne().lean();
        expect(alert.readings[0].rule).toBe('spo2.scale2_at_most_85');
        expect((await Notification.findOne().lean()).title).toBe('Blood oxygen below your target');
    });

    it('requires a reason for anything but the defaults, and keeps the history', async () => {
        const refused = mockRes();
        await review.setVitalTargets({
            auth: doctor(), params: { userId: String(userId) }, body: { spo2Scale: 'hypercapnic' },
        }, refused);
        expect(refused.status).toHaveBeenCalledWith(400);

        const first = mockRes();
        await review.setVitalTargets({
            auth: doctor(), params: { userId: String(userId) },
            body: { spo2Scale: 'hypercapnic', lowHeartRateExpected: true, reason: 'COPD; on bisoprolol' },
        }, first);
        expect(first.status).not.toHaveBeenCalled();
        expect(first.json.mock.calls[0][0].effective).toEqual({ spo2Scale: 'hypercapnic', lowHeartRateExpected: true });

        await review.setVitalTargets({
            auth: doctor(), params: { userId: String(userId) }, body: { spo2Scale: 'standard' },
        }, mockRes());

        const row = await VitalTarget.findOne({ userId }).lean();
        expect(row.spo2Scale).toBe('standard');
        expect(row.history.map((h) => h.spo2Scale)).toEqual(['hypercapnic', 'standard']);
    });

    it('rejects an unknown scale', async () => {
        const res = mockRes();
        await review.setVitalTargets({
            auth: doctor(), params: { userId: String(userId) }, body: { spo2Scale: 'lenient', reason: 'x' },
        }, res);
        expect(res.status).toHaveBeenCalledWith(400);
    });

    it('is on the patient record', async () => {
        await VitalTarget.create({ userId, spo2Scale: 'hypercapnic', reason: 'COPD' });
        const res = mockRes();
        await review.getPatientContext({ auth: doctor(), params: { userId: String(userId) } }, res);
        const { vitalTargets } = res.json.mock.calls[0][0];
        expect(vitalTargets).toMatchObject({ spo2Scale: 'hypercapnic', reason: 'COPD' });
        expect(vitalTargets.scales.map((sc) => sc.key)).toEqual(['standard', 'hypercapnic']);
    });
});

/* ------------------------------------------------------------------ *
 * Telling the patient a clinician looked
 * ------------------------------------------------------------------ */

describe('the review reaches the patient', () => {
    const doctor = () => ({ userId: String(new mongoose.Types.ObjectId()), role: 'professional', email: 'doc@example.com' });
    const openAlert = async () => {
        await recordReadings(userId, [spo2Reading(92, hoursAgo(1), { externalId: `m${Math.random()}` })], { now: NOW });
        return VitalAlert.findOne({ isOpen: true }).lean();
    };
    const reviewed = () => Notification.findOne({ dedupeKey: /^vitals:reviewed:/ }).lean();

    it('sends the clinician\'s own message, never the internal note', async () => {
        const alert = await openAlert();
        await review.reviewVitalAlert({
            auth: doctor(), params: { alertId: String(alert._id) },
            body: {
                outcome: 'measurement_error',
                note: 'Cold peripheries on video call; poor waveform.',
                patientMessage: 'Your reading was probably affected by cold hands. Warm up and try again.',
            },
        }, mockRes());

        const card = await reviewed();
        expect(card.category).toBe('vitals_review');
        expect(card.title).toBe('A clinician reviewed your blood oxygen readings');
        expect(card.body).toBe('Your reading was probably affected by cold hands. Warm up and try again.');
        expect(card.body).not.toContain('peripheries');
        expect((await VitalAlert.findById(alert._id).lean()).review.patientNotifiedAt).toBeTruthy();
    });

    it('falls back to the outcome\'s wording, with its action', async () => {
        const alert = await openAlert();
        await review.reviewVitalAlert({
            auth: doctor(), params: { alertId: String(alert._id) }, body: { outcome: 'plan_item' },
        }, mockRes());

        const card = await reviewed();
        expect(card.body).toBe(table.REVIEW_COPY.plan_item.body);
        expect(card.route).toBe('/myplans');
        expect(card.actions.map((a) => a.route)).toEqual(['/myplans']);
    });

    it('stays silent when the clinician turns it off', async () => {
        const alert = await openAlert();
        await review.reviewVitalAlert({
            auth: doctor(), params: { alertId: String(alert._id) },
            body: { outcome: 'no_action', note: 'Known, managed.', notifyPatient: false },
        }, mockRes());

        expect(await reviewed()).toBeNull();
        expect((await VitalAlert.findById(alert._id).lean()).review.patientNotifiedAt).toBeNull();
    });

    it('refuses a patient message over the card limit', async () => {
        const alert = await openAlert();
        const res = mockRes();
        await review.reviewVitalAlert({
            auth: doctor(), params: { alertId: String(alert._id) },
            body: { outcome: 'advised_patient', patientMessage: 'x'.repeat(241) },
        }, res);
        expect(res.status).toHaveBeenCalledWith(400);
        expect((await VitalAlert.findById(alert._id).lean()).status).toBe('open');
    });
});

/* ------------------------------------------------------------------ *
 * The AI context
 * ------------------------------------------------------------------ */

describe('the interpretation and the assistant see the alerts', () => {
    const { _gatherVitalAlerts } = require('../controllers/interpretationController');
    const { buildContext } = require('../utils/interpretationEngine');
    const { hasNewDataSince } = require('../utils/regenerationGuard');
    const VitalTarget = require('../models/VitalTarget');

    it('says nothing when there is nothing to say', async () => {
        expect(await _gatherVitalAlerts(userId)).toBeNull();
    });

    it('states open episodes, reviewed outcomes and targets, but never the internal note', async () => {
        await recordReadings(userId, [bpReading(188, 124, hoursAgo(1), { externalId: 'ai1', method: 'optical_estimate', source: 'bracelet' })]);
        await recordReadings(userId, [spo2Reading(89, hoursAgo(1), { externalId: 'ai2' })]);
        const spo2 = await VitalAlert.findOne({ metric: 'spo2' });
        spo2.status = 'reviewed';
        spo2.isOpen = false;
        spo2.review = { at: new Date(), outcome: 'measurement_error', note: 'SECRET internal reasoning' };
        await spo2.save();
        await VitalTarget.create({ userId, spo2Scale: 'hypercapnic', reason: 'COPD' });

        const vitals = await _gatherVitalAlerts(userId);
        const text = buildContext({ user: { firstName: 'Pat' }, vitalAlerts: vitals });

        expect(text).toContain('## Vital signs flagged out of range');
        expect(text).toContain('Blood pressure: worst 188/124 mmHg');
        expect(text).toContain('includes cuffless bracelet estimates');
        expect(text).toContain('awaiting clinician review');
        expect(text).toContain('judged NOT a valid reading');
        expect(text).toContain('88–92%');
        expect(text).not.toContain('SECRET');
    });

    it('counts a new alert as new data for regeneration', async () => {
        const since = new Date(Date.now() - 1000);
        expect(await hasNewDataSince(userId, since)).toBe(false);
        await recordReadings(userId, [spo2Reading(88, hoursAgo(0.5), { externalId: 'rg' })]);
        expect(await hasNewDataSince(userId, since)).toBe(true);
    });
});
