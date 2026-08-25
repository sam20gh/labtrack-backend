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

const Interpretation = require('../models/Interpretation');

const snapshotFor = (overrides = {}) => Interpretation.create({
    userId,
    generatedAt: new Date('2026-08-25'),
    content: { summary: 'A read.' },
    covers: [],
    review: { status: 'pending' },
    ...overrides,
});

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
        await snapshotFor({
            content: { summary: 'Cardiometabolic pattern.' },
            covers: [{ kind: 'test_result', id: older._id, date: new Date('2026-06-09') }],
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

    it('marks the analysis current when it covers the newest result', async () => {
        await makeResult('Lipid Panel', '2026-06-09');
        const newest = await makeResult('Full Blood Count', '2026-08-24');
        await snapshotFor({
            covers: [{ kind: 'test_result', id: newest._id, date: new Date('2026-08-24') }],
        });

        const body = await call();
        expect(body.isForLatestResult).toBe(true);
        expect(body.latestResult.id).toBe(String(newest._id));
    });

    it('picks the newest snapshot when several exist', async () => {
        await snapshotFor({ content: { summary: 'older' }, generatedAt: new Date('2026-06-10') });
        await snapshotFor({ content: { summary: 'newer' }, generatedAt: new Date('2026-08-25') });

        const body = await call();
        expect(body.interpretation.summary).toBe('newer');
    });

    it('never returns another user\'s analysis', async () => {
        await Interpretation.create({
            userId: new mongoose.Types.ObjectId(),
            content: { summary: 'someone else' },
            covers: [],
        });

        const body = await call();
        expect(body.interpretation).toBeNull();
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
        await snapshotFor({
            content: {
                summary: 'Earlier read.',
                risks: [{ condition: 'Prediabetes', level: 'moderate' }],
                biomarkers_of_concern: [{ name: 'Triglycerides' }],
            },
        });

        const ctx = await _gatherContext(userId);
        expect(ctx.previous.summary).toBe('Earlier read.');
        expect(ctx.previous.risks[0].condition).toBe('Prediabetes');
        expect(ctx.previous.biomarkersOfConcern[0].name).toBe('Triglycerides');
        expect(ctx.previous.reviewed).toBe(false);
    });

    it('carries the clinician-amended version, not the superseded AI text', async () => {
        await snapshotFor({
            content: { summary: 'What the model said.' },
            amended: { content: { summary: 'What the clinician said.' }, at: new Date() },
            review: { status: 'amended' },
        });

        const ctx = await _gatherContext(userId);
        // Writing a delta against text the patient never saw would describe a change that
        // did not happen to them.
        expect(ctx.previous.summary).toBe('What the clinician said.');
        expect(ctx.previous.reviewed).toBe(true);
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

// ---------------------------------------------------------------------------
// Phase 4: reads come from Interpretation
// ---------------------------------------------------------------------------

const { getInterpretation } = require('../controllers/interpretationController');
// DnaReport is used by the source-resolution test below; the backfill suite requires it
// separately, so it is not already in scope here.
const DnaReportModel = require('../models/DnaReport');

const snapshot = (overrides = {}) => Interpretation.create({
    userId,
    generatedAt: new Date('2026-08-25'),
    content: { summary: 'From the snapshot.' },
    covers: [],
    review: { status: 'pending' },
    ...overrides,
});

describe('getLatest — reading the snapshot', () => {
    it('reads isForLatestResult from covers, so a multi-source read counts', async () => {
        const older = await makeResult('Lipid Panel', '2026-06-09');
        const newest = await makeResult('Full Blood Count', '2026-08-24');

        // One whole-person interpretation that read both documents.
        await snapshot({
            covers: [
                { kind: 'test_result', id: older._id, date: new Date('2026-06-09') },
                { kind: 'test_result', id: newest._id, date: new Date('2026-08-24') },
            ],
        });

        const body = await call();
        expect(body.isForLatestResult).toBe(true);
        // `source` names the leading edge of what it read.
        expect(body.source.testType).toBe('Full Blood Count');
    });

    it('still flags an interpretation that predates the newest result', async () => {
        const older = await makeResult('Lipid Panel', '2026-06-09');
        await makeResult('Full Blood Count', '2026-08-24');
        await snapshot({ covers: [{ kind: 'test_result', id: older._id, date: new Date('2026-06-09') }] });

        const body = await call();
        expect(body.isForLatestResult).toBe(false);
        expect(body.source.testType).toBe('Lipid Panel');
    });

    it('serves a clinician amendment instead of the AI text', async () => {
        const r = await makeResult('Lipid Panel', '2026-06-09');
        await snapshot({
            covers: [{ kind: 'test_result', id: r._id, date: new Date('2026-06-09') }],
            content: { summary: 'AI said moderate.' },
            amended: { content: { summary: 'Clinician corrected to low.' }, at: new Date('2026-08-26') },
            review: { status: 'amended', reviewedAt: new Date('2026-08-26') },
        });

        const body = await call();
        // The defect this migration exists to fix.
        expect(body.interpretation.summary).toBe('Clinician corrected to low.');
        expect(body.verification.status).toBe('amended');
        expect(body.verification.reviewRequired).toBe(false);
    });

    it('reports the pending verification state for an unreviewed snapshot', async () => {
        await snapshot();
        const body = await call();
        expect(body.verification.status).toBe('unverified');
        expect(body.verification.withheld).toBe(false);
        expect(body.verification.reviewRequired).toBe(true);
    });

    it('resolves a DNA report source without probing the wrong collection', async () => {
        const dna = await DnaReportModel.create({ userId, labName: 'Genetics Co', mutations: [], reportDate: new Date('2026-05-01') });
        await snapshot({ covers: [{ kind: 'dna_report', id: dna._id, date: new Date('2026-05-01') }] });

        const body = await call();
        expect(body.source.kind).toBe('dna_report');
        expect(body.source.labName).toBe('Genetics Co');
    });
});

describe('getInterpretation — by source', () => {
    const callFor = async (sourceId) => {
        const res = mockRes();
        await getInterpretation({ auth: { userId: String(userId) }, params: { sourceId: String(sourceId) } }, res);
        return res;
    };

    it('answers with a later interpretation that read this document', async () => {
        const older = await makeResult('Lipid Panel', '2026-06-09');
        const newest = await makeResult('Full Blood Count', '2026-08-24');
        // Generated for the newest result, but it read the older one too.
        await snapshot({
            covers: [
                { kind: 'test_result', id: older._id, date: new Date('2026-06-09') },
                { kind: 'test_result', id: newest._id, date: new Date('2026-08-24') },
            ],
        });

        const res = await callFor(older._id);
        expect(res.status).not.toHaveBeenCalledWith(404);
        expect(res.json.mock.calls[0][0].interpretation.summary).toBe('From the snapshot.');
    });

    it('404s for a document nothing has read', async () => {
        await snapshot();
        const res = await callFor(new mongoose.Types.ObjectId());
        expect(res.status).toHaveBeenCalledWith(404);
    });
});
