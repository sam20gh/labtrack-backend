/**
 * One interpretation generation per person at a time.
 *
 * The home screen asks for a generation from `useFocusEffect`, and a model call takes
 * seconds, so a second request routinely arrived while the first was still running. Both
 * ran: two model calls, two snapshots, and two copies of the plan in slightly different
 * words — which the nutrition tracker drew as the same diet advice twice.
 */
jest.mock('../utils/interpretationEngine', () => {
    const actual = jest.requireActual('../utils/interpretationEngine');
    return { ...actual, isConfigured: () => true, interpret: jest.fn() };
});
jest.mock('../utils/regenerationGuard', () => ({
    assessRegeneration: jest.fn(async () => ({ allowed: true })),
}));

const mongoose = require('mongoose');
const User = require('../models/userModel');
const Biomarker = require('../models/Biomarker');
const Interpretation = require('../models/Interpretation');
const PlanItem = require('../models/PlanItem');
const { interpret } = require('../utils/interpretationEngine');
const { generateInterpretation } = require('../controllers/interpretationController');

const userId = new mongoose.Types.ObjectId();

const post = (body = {}) => new Promise((resolve) => {
    const res = {
        statusCode: 200,
        set() { return this; },
        status(code) { this.statusCode = code; return this; },
        json(payload) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    generateInterpretation({ auth: { userId: String(userId) }, body }, res);
});

const CONTENT = {
    summary: 'Cholesterol is raised.',
    recommended_screenings: [],
    specialist_consultations: [],
    lifestyle_recommendations: [
        { area: 'diet', recommendation: 'Adopt a Mediterranean diet', rationale: 'LDL is raised.' },
    ],
};

beforeEach(async () => {
    interpret.mockReset();
    await User.create({ _id: userId, username: `u-${userId}`, email: `${userId}@example.com`, password: 'x' });
    await Biomarker.create({
        userId, name: 'ldl', displayName: 'LDL', value: 4.2, unit: 'mmol/L',
        measuredAt: new Date('2026-09-01'), flag: 'high',
    });
});

describe('generateInterpretation — overlapping requests', () => {
    it('runs the model once and gives both requests the same answer', async () => {
        let finish;
        interpret.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));

        const first = post({ force: true });
        const second = post({ force: true });

        // Hold the model until it has been asked, so the second request lands mid-run.
        while (!finish) await new Promise((r) => setTimeout(r, 10));
        await new Promise((r) => setTimeout(r, 20));
        finish({ ok: true, data: CONTENT, usage: {} });

        const [a, b] = await Promise.all([first, second]);

        expect(interpret).toHaveBeenCalledTimes(1);
        expect(a.status).toBe(201);
        expect(b.status).toBe(201);
        expect(b.body.joined).toBe(true);
        expect(await Interpretation.countDocuments({ userId })).toBe(1);
        expect(await PlanItem.countDocuments({ userId, condition: 'diet' })).toBe(1);
    });

    it('lets the next request run once the first has finished', async () => {
        interpret.mockResolvedValue({ ok: true, data: CONTENT, usage: {} });

        await post({ force: true });
        const again = await post({ force: true });

        expect(interpret).toHaveBeenCalledTimes(2);
        expect(again.body.joined).toBeUndefined();
        // Two generations in sequence still leave one plan.
        expect(await PlanItem.countDocuments({ userId, condition: 'diet' })).toBe(1);
    });

    it('releases the guard when a run fails, so the person is not stuck', async () => {
        interpret.mockRejectedValueOnce(new Error('model down'));
        const failed = await post({ force: true });
        expect(failed.status).toBe(500);

        interpret.mockResolvedValueOnce({ ok: true, data: CONTENT, usage: {} });
        const retried = await post({ force: true });
        expect(retried.status).toBe(201);
    });
});
