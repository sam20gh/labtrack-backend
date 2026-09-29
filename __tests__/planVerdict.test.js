/**
 * A meal's plan verdict, and the dismissed advice that silently switched it off.
 *
 * On 2026-09-29 one tap on "Dismiss" under the only diet item on a plan emptied the
 * nutrition guidance, and every meal after it came back `unassessed` — the review screen
 * hid its verdict card and nothing said why. Dismissing could not be undone, and the
 * analyser read whatever guidance the last dashboard visit had left behind. These hold the
 * three fixes: a dismissed item can be restored, the analyser syncs before it judges, and
 * the response says why a draft carries no verdict.
 */
jest.mock('../utils/nutritionEngine', () => {
    const actual = jest.requireActual('../utils/nutritionEngine');
    return { ...actual, isConfigured: () => true, analyseDescription: jest.fn() };
});

const mongoose = require('mongoose');
const PlanItem = require('../models/PlanItem');
const NutritionPlan = require('../models/NutritionPlan');
const User = require('../models/userModel');
const { analyseDescription } = require('../utils/nutritionEngine');
const nutrition = require('../controllers/nutritionController');
const planItems = require('../controllers/planItemController');

const mockRes = () => {
    const res = {};
    res.status = jest.fn(() => res);
    res.json = jest.fn((body) => { res.body = body; return res; });
    return res;
};

const makeUser = () => User.create({
    username: `u${new mongoose.Types.ObjectId()}`,
    email: `${new mongoose.Types.ObjectId()}@example.com`,
    supabaseId: String(new mongoose.Types.ObjectId()),
    dob: new Date(new Date().getFullYear() - 40, 0, 15).toISOString(),
    gender: 'Male',
    height: 178,
    weight: 80,
});

const modelSays = (alignment) => analyseDescription.mockResolvedValue({
    ok: true,
    model: 'test',
    data: {
        detected: true, name: 'Toast', calories: 300, protein: 8, carbs: 50, fat: 6,
        confidence: 0.9, alignment, alignment_rationale: alignment === 'unassessed' ? null : 'Because.',
        guidance_keys: [], items: [], uncertainties: [],
    },
});

const estimate = async (userId) => {
    const res = mockRes();
    await nutrition.estimateFromDescription({ auth: { userId }, body: { description: 'two slices of toast' } }, res);
    return res;
};

const setStatus = async (userId, id, status) => {
    const res = mockRes();
    await planItems.updateStatus({ auth: { userId }, params: { id }, body: { status } }, res);
    return res;
};

beforeEach(() => analyseDescription.mockReset());

describe('restoring a dismissed plan item', () => {
    it('puts dismissed advice back as ongoing, never as overdue', async () => {
        const userId = new mongoose.Types.ObjectId();
        const item = await PlanItem.create({
            userId, type: 'lifestyle', condition: 'diet', title: 'Cut out sugary drinks',
            dueDate: new Date(Date.now() - 7 * 86400000), status: 'dismissed',
        });

        const res = await setStatus(userId, item._id, 'restore');

        expect(res.status).not.toHaveBeenCalled();
        expect((await PlanItem.findById(item._id).lean()).status).toBe('upcoming');
    });

    it('gives dated work the status its due date says today', async () => {
        const userId = new mongoose.Types.ObjectId();
        const item = await PlanItem.create({
            userId, type: 'test', title: 'Lipid panel',
            dueDate: new Date(Date.now() - 7 * 86400000), status: 'dismissed',
        });

        await setStatus(userId, item._id, 'restore');

        expect((await PlanItem.findById(item._id).lean()).status).toBe('urgent');
    });

    it('refuses anything not dismissed, so it cannot reopen a finished or booked item', async () => {
        const userId = new mongoose.Types.ObjectId();
        const item = await PlanItem.create({
            userId, type: 'test', title: 'Lipid panel', dueDate: new Date(), status: 'completed',
        });

        const res = await setStatus(userId, item._id, 'restore');

        expect(res.status).toHaveBeenCalledWith(409);
        expect((await PlanItem.findById(item._id).lean()).status).toBe('completed');
    });

    it("answers 404 for somebody else's item", async () => {
        const item = await PlanItem.create({
            userId: new mongoose.Types.ObjectId(), type: 'lifestyle', condition: 'diet',
            title: 'Not yours', dueDate: new Date(), status: 'dismissed',
        });

        const res = await setStatus(new mongoose.Types.ObjectId(), item._id, 'restore');

        expect(res.status).toHaveBeenCalledWith(404);
        expect((await PlanItem.findById(item._id).lean()).status).toBe('dismissed');
    });
});

describe('the analyser judges against the plan as it is now', () => {
    it('syncs the guidance first, so restored advice reaches the very next meal', async () => {
        const user = await makeUser();
        // The state the dashboard left behind after the dismissal: no guidance at all
        await NutritionPlan.create({
            userId: user._id, targets: { calories: 2300, protein: 120, carbs: 250, fat: 90 },
            guidance: [], guidanceSyncedAt: new Date(),
        });
        await PlanItem.create({
            userId: user._id, type: 'lifestyle', condition: 'diet',
            title: 'Cut back on refined carbohydrates', dueDate: new Date(), status: 'upcoming',
        });
        modelSays('partial');

        const res = await estimate(user._id);

        const planSeen = analyseDescription.mock.calls[0][1];
        expect(planSeen.guidance.map((g) => g.key)).toEqual(['refined_carbs']);
        expect(res.body.verdict).toBe('judged');
    });

    it('says the plan has no diet advice when that is why there is no verdict', async () => {
        const user = await makeUser();
        await PlanItem.create({
            userId: user._id, type: 'lifestyle', condition: 'diet',
            title: 'Cut back on refined carbohydrates', dueDate: new Date(), status: 'dismissed',
        });
        modelSays('unassessed');

        const res = await estimate(user._id);

        expect(res.body.verdict).toBe('no_guidance');
    });

    it('tells a declined verdict apart from a missing plan', async () => {
        const user = await makeUser();
        await PlanItem.create({
            userId: user._id, type: 'lifestyle', condition: 'diet',
            title: 'Cut back on refined carbohydrates', dueDate: new Date(), status: 'upcoming',
        });
        modelSays('unassessed');

        const res = await estimate(user._id);

        expect(res.body.verdict).toBe('not_judged');
    });
});
