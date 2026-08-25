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
