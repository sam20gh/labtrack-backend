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
const controller = require('../controllers/nutritionController');
const { _syncGuidance, _summarise, _localDay } = controller;
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

/** Minimal req/res doubles, matching how the other controller tests drive handlers. */
const mockRes = () => {
    const res = { statusCode: 200, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    return res;
};

const photoMeal = (userId, over = {}) => MealLog.create({
    userId,
    eatenAt: new Date('2026-08-30T12:00:00Z'),
    day: '2026-08-30',
    name: 'Omelette and greens',
    calories: 420,
    protein: 28,
    carbs: 12,
    fat: 26,
    source: 'photo',
    imageUrl: 'https://imagedelivery.net/hash/id/public',
    ...over,
});

describe('the gallery — the photographs, across the whole history', () => {
    const getGallery = async (userId, query = {}) => {
        const res = mockRes();
        await controller.getGallery({ auth: { userId }, query }, res);
        return res;
    };

    it('lists only meals that actually have a photograph', async () => {
        const user = await makeUser();
        await photoMeal(user._id);
        // A typed meal. A placeholder tile for this would pad the grid with squares that
        // say nothing, and would make the count under the rail mean something other than
        // photographs.
        await photoMeal(user._id, { name: 'Toast', source: 'manual', imageUrl: null });
        await photoMeal(user._id, { name: 'Apple', source: 'manual', imageUrl: '' });

        const res = await getGallery(user._id);

        expect(res.body.items).toHaveLength(1);
        expect(res.body.total).toBe(1);
        expect(res.body.items[0].name).toBe('Omelette and greens');
    });

    it('never returns another person\'s photographs', async () => {
        const [mine, theirs] = [await makeUser(), await makeUser()];
        await photoMeal(mine._id, { name: 'Mine' });
        await photoMeal(theirs._id, { name: 'Theirs' });

        const res = await getGallery(mine._id);

        expect(res.body.items.map((i) => i.name)).toEqual(['Mine']);
        expect(res.body.total).toBe(1);
    });

    it('pages newest-first on a cursor, without repeating or skipping a tile', async () => {
        const user = await makeUser();
        for (let i = 0; i < 5; i += 1) {
            await photoMeal(user._id, {
                name: `Meal ${i}`,
                eatenAt: new Date(Date.UTC(2026, 7, 30, 8 + i)),
            });
        }

        const first = await getGallery(user._id, { limit: '2' });
        expect(first.body.items.map((i) => i.name)).toEqual(['Meal 4', 'Meal 3']);
        expect(first.body.nextCursor).toBeTruthy();
        // The count is of everything on record, not of this page — it captions the rail.
        expect(first.body.total).toBe(5);

        const second = await getGallery(user._id, { limit: '2', before: first.body.nextCursor });
        expect(second.body.items.map((i) => i.name)).toEqual(['Meal 2', 'Meal 1']);

        const third = await getGallery(user._id, { limit: '2', before: second.body.nextCursor });
        expect(third.body.items.map((i) => i.name)).toEqual(['Meal 0']);
        // Last page: nothing more to fetch, so the button that would fetch it is not drawn.
        expect(third.body.nextCursor).toBeNull();
    });

    it('carries the alignment verdict, flattened, so a tile can render it', async () => {
        const user = await makeUser();
        await photoMeal(user._id, { analysis: { alignment: 'aligned', rationale: 'Fits your plan.' } });

        const res = await getGallery(user._id);

        expect(res.body.items[0].alignment).toBe('aligned');
    });

    it('reports unassessed rather than nothing when a meal had no guidance to be judged against', async () => {
        const user = await makeUser();
        await photoMeal(user._id);

        const res = await getGallery(user._id);

        // Same distinction the adherence score makes: nobody has failed at something
        // nobody asked of them, so the field is never left undefined for a tile to guess at.
        expect(res.body.items[0].alignment).toBe('unassessed');
    });

    it('rejects an unreadable cursor rather than silently serving the first page again', async () => {
        const user = await makeUser();
        const res = await getGallery(user._id, { before: 'not-a-date' });
        expect(res.statusCode).toBe(400);
    });
});

describe('safeImageUrl — what may reach a gallery tile', () => {
    const create = async (userId, imageUrl) => {
        const res = mockRes();
        await controller.createMeal({
            auth: { userId },
            body: { name: 'Lunch', calories: 300, day: '2026-08-30', imageUrl },
        }, res);
        return res;
    };

    it('stores an https delivery URL', async () => {
        const user = await makeUser();
        const res = await create(user._id, 'https://imagedelivery.net/hash/id/public');
        expect(res.body.meal.imageUrl).toBe('https://imagedelivery.net/hash/id/public');
    });

    it.each([
        ['javascript:alert(1)'],
        ['http://example.com/x.jpg'],
        ['file:///var/tmp/photo.jpg'],
        ['not a url'],
    ])('drops %s', async (value) => {
        const user = await makeUser();
        const res = await create(user._id, value);
        // `createMeal` spreads the request body, so without the guard the gallery would
        // render whatever string a client put here.
        expect(res.body.meal.imageUrl).toBeNull();
    });
});
