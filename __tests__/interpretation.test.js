/**
 * GET /api/interpretation/latest
 *
 * These reproduce the state a real account was in when the home screen went blank: two
 * test results, an AIFeedback row against the *older* one, and nothing against the newer.
 * The client used to derive all of this itself — fetch the results, sort them, ask for the
 * newest one's interpretation — and rendered nothing at all in exactly this case.
 */
const mongoose = require('mongoose');
const TestResult = require('../models/testResultModel');
const AIFeedback = require('../models/AIFeedback');
const { getLatest } = require('../controllers/interpretationController');

const mockRes = () => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
};

const userId = new mongoose.Types.ObjectId();

const makeResult = (testType, dateOfTest, extra = {}) =>
    TestResult.create({
        patient: {
            user_id: userId,
            date_of_test: new Date(dateOfTest),
            lab_name: 'Test Lab',
            test_type: testType,
        },
        results: {},
        ...extra,
    });

const call = async () => {
    const res = mockRes();
    await getLatest({ auth: { userId: String(userId) } }, res);
    expect(res.status).not.toHaveBeenCalledWith(500);
    return res.json.mock.calls[0][0];
};

describe('getLatest', () => {
    it('returns nulls, not an error, for an account with no data', async () => {
        const body = await call();
        expect(body.interpretation).toBeNull();
        expect(body.latestResult).toBeNull();
        expect(body.isForLatestResult).toBe(false);
    });

    it('surfaces an older result\'s analysis when the newest has none', async () => {
        const older = await makeResult('Lipid Panel', '2026-06-09');
        await makeResult('Full Blood Count', '2026-08-24');

        await AIFeedback.create({
            userID: userId,
            testID: older._id,
            feedback: JSON.stringify({ summary: 'Cardiometabolic pattern.', risks: [] }),
        });

        const body = await call();

        // The analysis is returned rather than hidden...
        expect(body.interpretation.summary).toBe('Cardiometabolic pattern.');
        // ...attributed to the result it actually describes...
        expect(body.source.id).toBe(String(older._id));
        expect(body.source.testType).toBe('Lipid Panel');
        // ...while the newest result is what the Generate button will target.
        expect(body.latestResult.testType).toBe('Full Blood Count');
        // The flag that makes the client say so instead of implying it is current.
        expect(body.isForLatestResult).toBe(false);
    });

    it('marks the analysis current when it belongs to the newest result', async () => {
        await makeResult('Lipid Panel', '2026-06-09');
        const newest = await makeResult('Full Blood Count', '2026-08-24');

        await AIFeedback.create({
            userID: userId,
            testID: newest._id,
            feedback: JSON.stringify({ summary: 'All clear.', risks: [] }),
        });

        const body = await call();
        expect(body.isForLatestResult).toBe(true);
        expect(body.latestResult.id).toBe(String(newest._id));
    });

    it('picks the newest AIFeedback when several exist', async () => {
        const first = await makeResult('Lipid Panel', '2026-06-09');
        const second = await makeResult('Full Blood Count', '2026-08-24');

        await AIFeedback.create({
            userID: userId, testID: first._id,
            feedback: JSON.stringify({ summary: 'older' }),
            createdAt: new Date('2026-06-10'),
        });
        await AIFeedback.create({
            userID: userId, testID: second._id,
            feedback: JSON.stringify({ summary: 'newer' }),
            createdAt: new Date('2026-08-25'),
        });

        const body = await call();
        expect(body.interpretation.summary).toBe('newer');
    });

    it('never returns another user\'s analysis', async () => {
        const mine = await makeResult('Lipid Panel', '2026-06-09');
        await AIFeedback.create({
            userID: new mongoose.Types.ObjectId(),
            testID: mine._id,
            feedback: JSON.stringify({ summary: 'someone else' }),
        });

        const body = await call();
        expect(body.interpretation).toBeNull();
    });

    it('degrades to no analysis rather than 500 on an unparseable row', async () => {
        const r = await makeResult('Lipid Panel', '2026-06-09');
        await AIFeedback.create({ userID: userId, testID: r._id, feedback: 'not json{' });

        const res = mockRes();
        await getLatest({ auth: { userId: String(userId) } }, res);

        expect(res.status).not.toHaveBeenCalledWith(500);
        expect(res.json.mock.calls[0][0].interpretation).toBeNull();
        // The result itself still comes back, so the Generate button still appears.
        expect(res.json.mock.calls[0][0].latestResult.testType).toBe('Lipid Panel');
    });

    it('passes the lab\'s own wording through separately from the AI read', async () => {
        await makeResult('Lipid Panel', '2026-06-09', { interpretation: 'Lab says: borderline.' });
        const body = await call();
        expect(body.latestResult.labInterpretation).toBe('Lab says: borderline.');
        expect(body.interpretation).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Prompt context: dated history and continuity with the previous read
// ---------------------------------------------------------------------------

const Biomarker = require('../models/Biomarker');
const { buildContext } = require('../utils/interpretationEngine');
const { _gatherContext } = require('../controllers/interpretationController');

const addMeasurement = (name, value, measuredAt, unit = 'mmol/L') =>
    Biomarker.create({
        userId, name, displayName: name, value, unit,
        measuredAt: new Date(measuredAt), flag: 'normal',
    });

describe('gatherContext — history', () => {
    it('keeps every measurement with its date, not just the endpoints', async () => {
        await addMeasurement('triglycerides', 1.4, '2026-01-10');
        await addMeasurement('triglycerides', 1.7, '2026-03-10');
        await addMeasurement('triglycerides', 1.95, '2026-06-09');

        const ctx = await _gatherContext(userId);
        const points = ctx.series.triglycerides.points;

        expect(points).toHaveLength(3);
        // Chronological, so the model reads it as a history rather than a stack
        expect(points.map((p) => p.v)).toEqual([1.4, 1.7, 1.95]);
        expect(ctx.trends.triglycerides.direction).toBe('rising');
    });

    it('caps a long series and reports how many were dropped', async () => {
        for (let i = 0; i < 30; i++) {
            await addMeasurement('ferritin', 200 + i, `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, 'ng/mL');
        }
        const ctx = await _gatherContext(userId);
        expect(ctx.series.ferritin.points).toHaveLength(24);
        expect(ctx.series.ferritin.omitted).toBe(6);
    });

    it('carries the previous interpretation forward', async () => {
        const r = await makeResult('Lipid Panel', '2026-06-09');
        await AIFeedback.create({
            userID: userId, testID: r._id,
            feedback: JSON.stringify({
                summary: 'Earlier read.',
                risks: [{ condition: 'Prediabetes', level: 'moderate' }],
                biomarkers_of_concern: [{ name: 'Triglycerides' }],
            }),
        });

        const ctx = await _gatherContext(userId);
        expect(ctx.previous.summary).toBe('Earlier read.');
        expect(ctx.previous.risks[0].condition).toBe('Prediabetes');
        expect(ctx.previous.biomarkersOfConcern[0].name).toBe('Triglycerides');
    });

    it('treats an unparseable previous interpretation as none', async () => {
        const r = await makeResult('Lipid Panel', '2026-06-09');
        await AIFeedback.create({ userID: userId, testID: r._id, feedback: 'not json{' });

        const ctx = await _gatherContext(userId);
        expect(ctx.previous).toBeNull();
    });
});

describe('buildContext — rendering', () => {
    const baseUser = { dob: '1985-03-14', gender: 'male' };

    it('prints each measurement against its date', () => {
        const text = buildContext({
            user: baseUser,
            biomarkers: [{ name: 'triglycerides', displayName: 'Triglycerides', value: 1.95, unit: 'mmol/L', flag: 'high' }],
            trends: { triglycerides: { count: 3, first: 1.4, last: 1.95, direction: 'rising' } },
            series: {
                triglycerides: {
                    points: [
                        { v: 1.4, at: new Date('2026-01-10') },
                        { v: 1.7, at: new Date('2026-03-10') },
                        { v: 1.95, at: new Date('2026-06-09') },
                    ],
                    omitted: 0,
                },
            },
        });

        expect(text).toContain('2026-01-10: 1.4 mmol/L');
        expect(text).toContain('2026-06-09: 1.95 mmol/L');
    });

    it('says so when older measurements were left out', () => {
        const points = Array.from({ length: 24 }, (_, i) => ({ v: 5, at: new Date('2026-02-02') }));
        const text = buildContext({
            user: baseUser,
            biomarkers: [{ name: 'hba1c', value: 5.69, unit: '%', flag: 'normal' }],
            series: { hba1c: { points, omitted: 6 } },
        });
        expect(text).toContain('6 earlier omitted');
    });

    it('includes the previous interpretation and tells the model not to defer to it', () => {
        const text = buildContext({
            user: baseUser,
            previous: {
                generatedAt: new Date('2026-06-10'),
                summary: 'Earlier read.',
                risks: [{ condition: 'Prediabetes', level: 'moderate' }],
                biomarkersOfConcern: [{ name: 'Triglycerides' }],
            },
        });

        expect(text).toContain('previous interpretation (2026-06-10)');
        expect(text).toContain('Earlier read.');
        expect(text).toContain('Prediabetes — moderate');
        expect(text).toMatch(/not a conclusion to defer to/i);
    });

    it('omits the previous-interpretation section entirely on a first run', () => {
        const text = buildContext({ user: baseUser });
        expect(text).not.toContain('previous interpretation');
    });

    // buildContext runs outside interpret()'s try/catch, so a throw here is a 500 on the
    // Generate button rather than a handled error.
    it('does not throw on an undated report', () => {
        expect(() => buildContext({
            user: baseUser,
            testResults: [{ patient: { test_type: 'Lipid Panel', lab_name: 'Lab', date_of_test: undefined } }],
            dnaReports: [{ labName: 'Genetics Co', reportDate: 'nonsense', mutations: [] }],
        })).not.toThrow();

        const text = buildContext({
            user: baseUser,
            testResults: [{ patient: { test_type: 'Lipid Panel', lab_name: 'Lab' } }],
        });
        expect(text).toContain('undated');
    });
});
