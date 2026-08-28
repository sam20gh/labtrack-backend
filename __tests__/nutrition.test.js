/**
 * Nutrition tracker ↔ health plan.
 *
 * The tracker's reason to exist is that it pushes people towards the dietary advice on
 * their plan. These lock in the link: guidance is derived from PlanItems on every read, a
 * regenerated interpretation moves the targets with it, and a person with no dietary advice
 * is never shown a failing adherence score for advice that was never given.
 */
const mongoose = require('mongoose');
const NutritionPlan = require('../models/NutritionPlan');
const MealLog = require('../models/MealLog');
const PlanItem = require('../models/PlanItem');
const User = require('../models/userModel');
const { _syncGuidance, _summarise, _localDay } = require('../controllers/nutritionController');
const { buildGuidanceBlock } = require('../utils/nutritionEngine');

const makeUser = () => User.create({
    username: `u${new mongoose.Types.ObjectId()}`,
    email: `${new mongoose.Types.ObjectId()}@example.com`,
    supabaseId: String(new mongoose.Types.ObjectId()),
    dob: new Date(new Date().getFullYear() - 40, 0, 15).toISOString(),
    gender: 'Female',
    height: 165,
    weight: 68,
    healthAssessment: {
        lifestyle: { exerciseFrequency: 'Light' },
        allergies: [{ allergen: 'Peanuts', severity: 'Severe' }],
    },
});

const dietItem = (userId, title, extra = {}) => PlanItem.create({
    userId,
    type: 'lifestyle',
    condition: 'diet',
    title,
    description: 'Because of your results.',
    dueDate: new Date(),
    ...extra,
});

describe('syncGuidance — the plan drives the tracker', () => {
    it('creates a plan from the diet advice on the health plan', async () => {
        const user = await makeUser();
        await dietItem(user._id, 'Shift towards a Mediterranean-style eating pattern');
        await dietItem(user._id, 'Cut back on refined carbohydrates');

        const plan = await _syncGuidance(user._id, null, user.toObject());

        expect(plan).not.toBeNull();
        expect(plan.guidance.map((g) => g.key).sort()).toEqual(['mediterranean', 'refined_carbs']);
        expect(plan.targets.calories).toBeGreaterThan(1000);
        // The advice has to move something the user can see, or it is decoration
        expect(plan.split.carbs).toBeLessThan(0.5);
    });

    it('snapshots food allergies so a swap can never suggest one', async () => {
        const user = await makeUser();
        await dietItem(user._id, 'Move to a Mediterranean pattern');

        const plan = await _syncGuidance(user._id, null, user.toObject());

        expect(plan.allergies.join(' ')).toMatch(/Peanuts/);
        expect(buildGuidanceBlock(plan.toObject())).toMatch(/Peanuts/);
    });

    it('picks up new advice when the interpretation is regenerated', async () => {
        const user = await makeUser();
        await dietItem(user._id, 'Cut back on refined carbohydrates');

        let plan = await _syncGuidance(user._id, null, user.toObject());
        const carbsBefore = plan.targets.carbs;

        // A fresh interpretation adds a directive
        await dietItem(user._id, 'Adopt a low-carbohydrate pattern');
        plan = await _syncGuidance(user._id, await NutritionPlan.findOne({ userId: user._id }), user.toObject());

        expect(plan.guidance.map((g) => g.key)).toContain('low_carb');
        expect(plan.targets.carbs).toBeLessThan(carbsBefore);
    });

    it('drops guidance when the person dismisses the plan item behind it', async () => {
        const user = await makeUser();
        const item = await dietItem(user._id, 'Cut back on refined carbohydrates');

        await _syncGuidance(user._id, null, user.toObject());
        await PlanItem.findByIdAndUpdate(item._id, { status: 'dismissed' });

        const plan = await _syncGuidance(user._id, await NutritionPlan.findOne({ userId: user._id }), user.toObject());
        expect(plan.guidance).toHaveLength(0);
    });

    it('keeps a calorie target the person set when guidance changes', async () => {
        const user = await makeUser();
        await dietItem(user._id, 'Cut back on refined carbohydrates');

        const plan = await _syncGuidance(user._id, null, user.toObject());
        plan.calorieOverride = 1800;
        plan.targets.calories = 1800;
        await plan.save();

        await dietItem(user._id, 'Adopt a Mediterranean pattern');
        const updated = await _syncGuidance(user._id, await NutritionPlan.findOne({ userId: user._id }), user.toObject());

        expect(updated.targets.calories).toBe(1800);
        expect(updated.guidance.map((g) => g.key)).toContain('mediterranean');
    });

    it('does not invent a plan for someone with no advice and no profile', async () => {
        const user = await User.create({
            username: `u${new mongoose.Types.ObjectId()}`,
            email: `${new mongoose.Types.ObjectId()}@example.com`,
            supabaseId: String(new mongoose.Types.ObjectId()),
        });

        expect(await _syncGuidance(user._id, null, user.toObject())).toBeNull();
        expect(await NutritionPlan.findOne({ userId: user._id })).toBeNull();
    });

    it('does not rewrite targets when nothing about the advice changed', async () => {
        const user = await makeUser();
        await dietItem(user._id, 'Cut back on refined carbohydrates');

        const first = await _syncGuidance(user._id, null, user.toObject());
        const stamp = first.guidanceSyncedAt;

        const second = await _syncGuidance(user._id, await NutritionPlan.findOne({ userId: user._id }), user.toObject());

        // A target that moved every time the screen opened would be a target nobody trusts
        expect(second.guidanceSyncedAt).toEqual(stamp);
        expect(second.targets.calories).toBe(first.targets.calories);
    });
});

describe('summarise — daily totals and adherence', () => {
    const plan = { targets: { calories: 2000, protein: 100, carbs: 225, fat: 70 } };
    const meal = (calories, alignment) => ({
        calories, protein: 10, carbs: 20, fat: 5,
        analysis: alignment ? { alignment } : undefined,
    });

    it('adds up the day and says what is left', () => {
        const s = _summarise([meal(600, 'aligned'), meal(700, 'partial')], plan);
        expect(s.totals.calories).toBe(1300);
        expect(s.remaining).toBe(700);
        expect(s.overBy).toBe(0);
    });

    it('reports how far over rather than a negative remainder', () => {
        const s = _summarise([meal(1400, 'aligned'), meal(900, 'off_plan')], plan);
        expect(s.remaining).toBe(0);
        expect(s.overBy).toBe(300);
    });

    it('scores adherence by counting meals, not averaging a percentage', () => {
        const s = _summarise([
            meal(400, 'aligned'), meal(400, 'aligned'),
            meal(400, 'partial'), meal(400, 'off_plan'),
        ], plan);
        expect(s.adherence.assessed).toBe(4);
        expect(s.adherence.aligned).toBe(2);
        expect(s.adherence.score).toBe(63); // (2 + 0.5) / 4
    });

    it('scores null, not zero, when there was no guidance to be measured against', () => {
        // Someone whose plan says nothing about diet has not failed at anything, and a
        // 0% on their dashboard would say they had.
        const s = _summarise([meal(500, 'unassessed'), meal(500)], plan);
        expect(s.adherence.assessed).toBe(0);
        expect(s.adherence.score).toBeNull();
    });

    it('handles a day with nothing logged', () => {
        const s = _summarise([], plan);
        expect(s.totals.calories).toBe(0);
        expect(s.remaining).toBe(2000);
        expect(s.adherence.score).toBeNull();
    });
});

describe('localDay — meals land on the right calendar day', () => {
    it('files an evening meal in the Americas under that evening, not the next day', () => {
        // 8pm in Los Angeles on 1 March is 4am UTC on 2 March. Grouping by UTC would put
        // it on the wrong day of the one screen this feature is built around.
        const eightPmPst = new Date('2026-03-02T04:00:00Z');
        expect(_localDay(eightPmPst, 480)).toBe('2026-03-01');
    });

    it('files a morning meal east of UTC under that morning', () => {
        const nineAmGulf = new Date('2026-03-01T05:00:00Z');
        expect(_localDay(nineAmGulf, -240)).toBe('2026-03-01');
    });
});

describe('MealLog', () => {
    it('requires a calendar day so the dashboard query can never miss a meal', async () => {
        const user = await makeUser();
        await expect(MealLog.create({
            userId: user._id, eatenAt: new Date(), name: 'Toast', calories: 200,
        })).rejects.toThrow(/day/);
    });
});
