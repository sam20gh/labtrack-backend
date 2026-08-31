const fs = require('fs');
const NutritionPlan = require('../models/NutritionPlan');
const MealLog = require('../models/MealLog');
const PlanItem = require('../models/PlanItem');
const User = require('../models/userModel');
const scoreController = require('./scoreController');
const {
    computeTargets, deriveGuidance, explain,
} = require('../utils/nutritionTargets');
const {
    analysePhoto, analyseDescription, toMealDraft,
    isConfigured, CONFIDENCE_THRESHOLD, ACCEPTED_MEDIA, MODEL,
} = require('../utils/nutritionEngine');
const imageStore = require('../utils/imageStore');

const MAX_BYTES = 10 * 1024 * 1024;

/** `YYYY-MM-DD` for a date in a given timezone offset (minutes, as `getTimezoneOffset()`). */
const localDay = (date, tzOffsetMinutes = 0) => {
    const shifted = new Date(new Date(date).getTime() - tzOffsetMinutes * 60_000);
    return shifted.toISOString().slice(0, 10);
};

const isDayString = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/**
 * Resolve the calendar day a meal belongs to.
 *
 * The client knows its own calendar and sends `day` outright; `tzOffset` is the fallback
 * for callers that only send a timestamp. Defaulting to UTC would file an evening meal in
 * the Americas under the following day, which is wrong on the one screen — today's totals —
 * that the whole feature is built around.
 */
const resolveDay = ({ day, eatenAt, tzOffset }) => {
    if (isDayString(day)) return day;
    return localDay(eatenAt || new Date(), Number(tzOffset) || 0);
};

/**
 * Accept a stored photo URL, or nothing.
 *
 * `createMeal` spreads the request body, so without this the gallery would render whatever
 * string a client put in `imageUrl` — including an `http://` or `javascript:` one. The only
 * URLs this app ever produces come from `imageStore`, which returns an https Cloudflare
 * delivery URL, so anything else is either a mistake or an injection and is dropped rather
 * than stored.
 */
const safeImageUrl = (value) => {
    if (typeof value !== 'string' || !value) return null;
    try {
        return new URL(value).protocol === 'https:' ? value : null;
    } catch {
        return null;
    }
};

/** Food-relevant allergens from the health assessment, for the analyser's hard constraints. */
const allergySnapshot = (user) =>
    (user?.healthAssessment?.allergies || [])
        .map((a) => (a.severity && a.severity !== 'Mild' ? `${a.allergen} (${a.severity.toLowerCase()})` : a.allergen))
        .filter(Boolean);

/**
 * Rebuild a plan's dietary guidance from the person's current PlanItems.
 *
 * Called on every read of the nutrition plan. Guidance is derived state — the health plan
 * is the source of truth — and recomputing it on read is what keeps the tracker in step
 * with a regenerated interpretation without a migration or a job. It is two cheap queries
 * and pure functions.
 *
 * Targets are only recalculated when the guidance actually changed. A target that moved
 * every time someone opened the screen would be unusable.
 */
const syncGuidance = async (userId, plan, user) => {
    const dietItems = await PlanItem.find({
        userId,
        type: 'lifestyle',
        condition: 'diet',
        status: { $nin: ['dismissed', 'completed'] },
    }).sort({ createdAt: 1 }).lean();

    const guidance = deriveGuidance(dietItems);
    const signature = (g) => g.map((x) => `${x.key}:${x.directive}`).sort().join('|');

    if (plan && signature(plan.guidance || []) === signature(guidance)) return plan;

    const computed = computeTargets({
        user,
        dietItems,
        calorieOverride: plan?.calorieOverride ?? undefined,
    });

    // Without height/weight/dob and without a target of their own, there is nothing to
    // compute. An existing plan keeps the numbers it has; a new one is not invented.
    if (!computed) {
        if (!plan) return null;
        plan.guidance = guidance;
        plan.guidanceSyncedAt = new Date();
        await plan.save();
        return plan;
    }

    if (!plan) {
        return NutritionPlan.create({
            userId,
            targets: computed.targets,
            split: computed.split,
            basis: computed.basis,
            guidance,
            allergies: allergySnapshot(user),
            guidanceSyncedAt: new Date(),
        });
    }

    plan.targets = { ...plan.targets.toObject?.() ?? plan.targets, ...computed.targets };
    plan.split = computed.split;
    plan.basis = computed.basis;
    plan.guidance = guidance;
    plan.allergies = allergySnapshot(user);
    plan.guidanceSyncedAt = new Date();
    await plan.save();
    return plan;
};

/**
 * GET /api/nutrition/plan — the person's targets and the plan advice behind them.
 *
 * Returns `plan: null` rather than 404 when they have not set one up: "no plan yet" is the
 * setup screen's normal starting state, not an error, and a 404 would have every client
 * distinguishing it from a genuine failure.
 */
exports.getNutritionPlan = async (req, res) => {
    try {
        const userId = req.auth.userId;
        const [existing, user] = await Promise.all([
            NutritionPlan.findOne({ userId }),
            User.findById(userId).select('dob gender height weight healthAssessment').lean(),
        ]);

        const plan = await syncGuidance(userId, existing, user);

        res.json({
            plan: plan ? plan.toObject() : null,
            explanation: explain(plan?.basis),
            /** What the setup screen needs before it can compute anything. */
            missingProfile: [
                !user?.height && 'height',
                !user?.weight && 'weight',
                !user?.dob && 'date of birth',
            ].filter(Boolean),
        });
    } catch (error) {
        console.error('❌ Error fetching nutrition plan:', error);
        res.status(500).json({ message: 'Error fetching nutrition plan', error: error.message });
    }
};

/**
 * PUT /api/nutrition/plan — the setup flow.
 *
 * The person controls their calorie target, how often they eat, their preferences and their
 * notes. They do not control the guidance: that comes from their health plan, and letting
 * the tracker's copy be edited here would let it drift from the advice it is meant to
 * enforce. Change the plan to change the guidance.
 */
exports.upsertNutritionPlan = async (req, res) => {
    try {
        const userId = req.auth.userId;
        const { calorieTarget, mealsPerDay, dietaryPreferences, notes } = req.body;

        const user = await User.findById(userId).select('dob gender height weight healthAssessment').lean();

        const dietItems = await PlanItem.find({
            userId, type: 'lifestyle', condition: 'diet',
            status: { $nin: ['dismissed', 'completed'] },
        }).lean();

        const override = calorieTarget === null ? undefined : Number(calorieTarget);
        if (calorieTarget != null && (!Number.isFinite(override) || override < 800 || override > 6000)) {
            return res.status(400).json({ message: 'calorieTarget must be between 800 and 6000 kcal' });
        }

        const computed = computeTargets({ user, dietItems, calorieOverride: override });
        if (!computed) {
            return res.status(400).json({
                message: 'Set a calorie target, or add your height, weight and date of birth to your profile so one can be estimated.',
                missingProfile: [
                    !user?.height && 'height',
                    !user?.weight && 'weight',
                    !user?.dob && 'date of birth',
                ].filter(Boolean),
            });
        }

        const update = {
            targets: computed.targets,
            split: computed.split,
            basis: computed.basis,
            guidance: computed.guidance,
            allergies: allergySnapshot(user),
            calorieOverride: calorieTarget == null ? null : override,
            guidanceSyncedAt: new Date(),
        };
        if (mealsPerDay != null) update.mealsPerDay = Number(mealsPerDay);
        if (dietaryPreferences != null) update.dietaryPreferences = dietaryPreferences;
        if (notes != null) update.notes = String(notes).slice(0, 2000);

        const plan = await NutritionPlan.findOneAndUpdate(
            { userId },
            { $set: update },
            { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
        );

        res.json({ message: 'Nutrition plan saved', plan, explanation: explain(plan.basis) });
    } catch (error) {
        console.error('❌ Error saving nutrition plan:', error);
        res.status(400).json({ message: 'Error saving nutrition plan', error: error.message });
    }
};

/** Totals and per-guidance adherence for a set of meals. */
const summarise = (meals, plan) => {
    const totals = meals.reduce((acc, m) => ({
        calories: acc.calories + (m.calories || 0),
        protein: acc.protein + (m.protein || 0),
        carbs: acc.carbs + (m.carbs || 0),
        fat: acc.fat + (m.fat || 0),
    }), { calories: 0, protein: 0, carbs: 0, fat: 0 });

    const targets = plan?.targets || {};
    const remaining = targets.calories != null
        ? Math.max(0, Math.round(targets.calories - totals.calories))
        : null;

    // Counted, not averaged: "4 of 5 meals aligned" is something a person can act on, where
    // a 78% score is not. `unassessed` meals are excluded so someone with no dietary
    // guidance is never shown a zero as though they had failed at something.
    const assessed = meals.filter((m) => m.analysis && m.analysis.alignment !== 'unassessed');
    const aligned = assessed.filter((m) => m.analysis.alignment === 'aligned').length;
    const partial = assessed.filter((m) => m.analysis.alignment === 'partial').length;
    const offPlan = assessed.filter((m) => m.analysis.alignment === 'off_plan').length;

    return {
        totals,
        targets,
        remaining,
        overBy: targets.calories != null && totals.calories > targets.calories
            ? Math.round(totals.calories - targets.calories)
            : 0,
        adherence: {
            assessed: assessed.length,
            aligned,
            partial,
            offPlan,
            /** Null rather than 0 when nothing was assessed — see above. */
            score: assessed.length ? Math.round(((aligned + partial * 0.5) / assessed.length) * 100) : null,
        },
    };
};

/** GET /api/nutrition/day?date=YYYY-MM-DD — the dashboard. */
exports.getDay = async (req, res) => {
    try {
        const userId = req.auth.userId;
        const day = isDayString(req.query.date)
            ? req.query.date
            : localDay(new Date(), Number(req.query.tzOffset) || 0);

        const [existing, user] = await Promise.all([
            NutritionPlan.findOne({ userId }),
            User.findById(userId).select('dob gender height weight healthAssessment').lean(),
        ]);
        const plan = await syncGuidance(userId, existing, user);

        const meals = await MealLog.find({ userId, day }).sort({ eatenAt: 1 }).lean();

        res.json({
            day,
            plan: plan ? plan.toObject() : null,
            meals,
            ...summarise(meals, plan),
        });
    } catch (error) {
        console.error('❌ Error fetching nutrition day:', error);
        res.status(500).json({ message: 'Error fetching day', error: error.message });
    }
};

/**
 * GET /api/nutrition/history?days=14 — daily totals for the insights screen.
 * Returns one row per day *with meals*; days with nothing logged are absent rather than
 * zero, because a blank day and a zero-calorie day are not the same claim.
 */
exports.getHistory = async (req, res) => {
    try {
        const userId = req.auth.userId;
        const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
        const tzOffset = Number(req.query.tzOffset) || 0;

        const from = new Date();
        from.setDate(from.getDate() - days);
        const fromDay = localDay(from, tzOffset);

        const [plan, meals] = await Promise.all([
            NutritionPlan.findOne({ userId }).lean(),
            MealLog.find({ userId, day: { $gte: fromDay } }).sort({ eatenAt: 1 }).lean(),
        ]);

        const byDay = new Map();
        for (const m of meals) {
            if (!byDay.has(m.day)) byDay.set(m.day, []);
            byDay.get(m.day).push(m);
        }

        const history = [...byDay.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([day, dayMeals]) => ({
                day,
                mealCount: dayMeals.length,
                ...summarise(dayMeals, plan),
            }));

        res.json({ from: fromDay, days, targets: plan?.targets || null, history });
    } catch (error) {
        console.error('❌ Error fetching nutrition history:', error);
        res.status(500).json({ message: 'Error fetching history', error: error.message });
    }
};

/**
 * POST /api/nutrition/analyse — photograph a meal.
 *
 * Saves nothing, exactly as `POST /api/reports/parse` saves nothing. It returns a draft the
 * person reviews and confirms with `POST /api/nutrition/meals`. Writing an estimate straight
 * into their record removes the only point at which a wrong portion can still be corrected.
 */
exports.analyseMealPhoto = async (req, res) => {
    let tempPath;
    try {
        if (!isConfigured()) {
            return res.status(503).json({
                message: 'Photo analysis is unavailable. Please enter the meal manually.',
                manualEntryAvailable: true,
            });
        }
        if (!req.file) return res.status(400).json({ message: 'No image uploaded' });

        tempPath = req.file.path;

        if (!ACCEPTED_MEDIA.includes(req.file.mimetype)) {
            return res.status(400).json({ message: `Unsupported image type: ${req.file.mimetype}` });
        }
        if (req.file.size > MAX_BYTES) {
            return res.status(400).json({ message: 'Image exceeds the 10MB limit' });
        }

        const plan = await NutritionPlan.findOne({ userId: req.auth.userId }).lean();
        const result = await analysePhoto(
            fs.readFileSync(tempPath),
            req.file.mimetype,
            plan,
            req.body?.note
        );

        if (!result.ok) {
            return res.status(502).json({ message: result.error, manualEntryAvailable: true });
        }
        if (!result.data.detected) {
            return res.status(422).json({
                message: "We couldn't detect food in that photo. Try again in better light, or enter the meal manually.",
                manualEntryAvailable: true,
            });
        }

        /*
          Only now is the picture kept.
          
          It is uploaded *after* detection succeeded, so a photograph of a wall never
          reaches permanent storage, and it is best-effort in exactly the sense
          `imageStore.uploadImageOrNull` documents for the assistant: a Cloudflare outage
          must cost the person a thumbnail, never the estimate they were waiting for.
          
          The URL is returned rather than written. Analysis still saves nothing — the
          review screen carries it into `POST /meals` along with the numbers the person
          confirmed, so abandoning the review leaves an orphaned Cloudflare image and no
          record, which is the right way round.
        */
        const imageUrl = await imageStore.uploadImageOrNull(tempPath);

        res.json({
            draft: toMealDraft(result.data, { source: 'photo', model: result.model }),
            imageUrl,
            needsConfirmation: (result.data.confidence ?? 0) < CONFIDENCE_THRESHOLD,
            uncertainties: result.data.uncertainties || [],
        });
    } catch (error) {
        console.error('❌ Error analysing meal photo:', error);
        res.status(500).json({ message: 'Error analysing photo', error: error.message });
    } finally {
        // Match reportIngestionController: the temp file goes whatever happened above
        if (tempPath) fs.unlink(tempPath, () => { });
    }
};

/** POST /api/nutrition/estimate — describe a meal in words. Also saves nothing. */
exports.estimateFromDescription = async (req, res) => {
    try {
        if (!isConfigured()) {
            return res.status(503).json({
                message: 'Estimation is unavailable. Please enter the meal manually.',
                manualEntryAvailable: true,
            });
        }

        const description = String(req.body?.description || '').trim();
        if (description.length < 3) {
            return res.status(400).json({ message: 'Describe what you ate, e.g. "grilled salmon with new potatoes"' });
        }

        const plan = await NutritionPlan.findOne({ userId: req.auth.userId }).lean();
        const result = await analyseDescription(description.slice(0, 500), plan);

        if (!result.ok) {
            return res.status(502).json({ message: result.error, manualEntryAvailable: true });
        }
        if (!result.data.detected) {
            return res.status(422).json({
                message: "That doesn't look like a meal. Try describing the food and roughly how much.",
                manualEntryAvailable: true,
            });
        }

        res.json({
            draft: toMealDraft(result.data, { source: 'description', model: result.model }),
            needsConfirmation: (result.data.confidence ?? 0) < CONFIDENCE_THRESHOLD,
            uncertainties: result.data.uncertainties || [],
        });
    } catch (error) {
        console.error('❌ Error estimating meal:', error);
        res.status(500).json({ message: 'Error estimating meal', error: error.message });
    }
};

/** POST /api/nutrition/meals — save a meal, whether typed or confirmed from a draft. */
exports.createMeal = async (req, res) => {
    try {
        const { name, calories } = req.body;
        if (!name || calories == null) {
            return res.status(400).json({ message: 'name and calories are required' });
        }

        const eatenAt = req.body.eatenAt ? new Date(req.body.eatenAt) : new Date();
        if (Number.isNaN(eatenAt.getTime())) {
            return res.status(400).json({ message: 'eatenAt is not a valid date' });
        }

        const meal = await MealLog.create({
            ...req.body,
            userId: req.auth.userId,
            eatenAt,
            day: resolveDay({ day: req.body.day, eatenAt, tzOffset: req.body.tzOffset }),
            imageUrl: safeImageUrl(req.body.imageUrl),
        });

        // Recomputed in the background so the score reflects this the next time the home
        // screen asks, rather than fifteen minutes later. Never awaited: a scoring failure
        // must not be able to fail the write the person actually made.
        scoreController.touch(req.auth.userId, 'log');

        res.status(201).json({ message: 'Meal logged', meal });
    } catch (error) {
        console.error('❌ Error logging meal:', error);
        res.status(400).json({ message: 'Error logging meal', error: error.message });
    }
};

/**
 * PATCH /api/nutrition/meals/:id — correct a meal.
 *
 * `analysis` is not editable. It records what the person was shown at the time; rewriting
 * it when they adjust a portion would leave coaching text attached to numbers it never
 * described.
 */
const EDITABLE = ['name', 'mealType', 'servings', 'calories', 'protein', 'carbs', 'fat', 'fibre', 'sodium', 'items', 'eatenAt'];

exports.updateMeal = async (req, res) => {
    try {
        const updates = {};
        for (const field of EDITABLE) {
            if (req.body[field] !== undefined) updates[field] = req.body[field];
        }
        if (updates.eatenAt) {
            const eatenAt = new Date(updates.eatenAt);
            if (Number.isNaN(eatenAt.getTime())) {
                return res.status(400).json({ message: 'eatenAt is not a valid date' });
            }
            updates.eatenAt = eatenAt;
            updates.day = resolveDay({ day: req.body.day, eatenAt, tzOffset: req.body.tzOffset });
        }

        const meal = await MealLog.findOneAndUpdate(
            { _id: req.params.id, userId: req.auth.userId },
            { $set: updates },
            { new: true, runValidators: true }
        );
        if (!meal) return res.status(404).json({ message: 'Meal not found' });

        res.json({ message: 'Meal updated', meal });
    } catch (error) {
        res.status(400).json({ message: 'Error updating meal', error: error.message });
    }
};

/** DELETE /api/nutrition/meals/:id */
exports.deleteMeal = async (req, res) => {
    try {
        const deleted = await MealLog.findOneAndDelete({ _id: req.params.id, userId: req.auth.userId });
        if (!deleted) return res.status(404).json({ message: 'Meal not found' });
        res.json({ message: 'Meal deleted' });
    } catch (error) {
        res.status(500).json({ message: 'Error deleting meal', error: error.message });
    }
};

/**
 * GET /api/nutrition/gallery?limit=&before= — every meal the person photographed.
 *
 * The photographs are the one part of this record a person recognises at a glance. A row
 * reading "Roasted caramel bread, 258 kcal" is a fact about a day they cannot picture; the
 * picture is the day. So the gallery is a read across the whole history rather than a
 * per-meal detail — "what have I been eating" is a question about the run of days, not
 * about lunch on Tuesday.
 *
 * Only meals with a stored photo appear. A placeholder tile for a typed meal would pad the
 * grid with squares that say nothing, and the count under the rail has to mean photographs
 * or it means nothing.
 *
 * Cursored on `eatenAt` rather than paged by offset: meals are logged while someone is
 * scrolling, and an offset page would then repeat or skip a tile.
 */
exports.getGallery = async (req, res) => {
    try {
        const userId = req.auth.userId;
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));

        const query = { userId, imageUrl: { $nin: [null, ''] } };

        // `before` is the previous page's last `eatenAt`, so the next page starts strictly
        // after it. An equal timestamp would re-serve that tile.
        if (req.query.before) {
            const before = new Date(req.query.before);
            if (Number.isNaN(before.getTime())) {
                return res.status(400).json({ message: 'before is not a valid date' });
            }
            query.eatenAt = { $lt: before };
        }

        // One extra row decides whether there is another page, without a second count query
        // over the same filter.
        const rows = await MealLog.find(query)
            .sort({ eatenAt: -1 })
            .limit(limit + 1)
            .select('imageUrl name mealType calories protein carbs fat day eatenAt source analysis.alignment')
            .lean();

        const hasMore = rows.length > limit;
        const items = (hasMore ? rows.slice(0, limit) : rows).map((m) => ({
            _id: m._id,
            imageUrl: m.imageUrl,
            name: m.name,
            mealType: m.mealType,
            calories: m.calories,
            protein: m.protein,
            carbs: m.carbs,
            fat: m.fat,
            day: m.day,
            eatenAt: m.eatenAt,
            source: m.source,
            alignment: m.analysis?.alignment || 'unassessed',
        }));

        res.json({
            items,
            /** Total photographs, so the rail can say "18 photos" without fetching them all. */
            total: await MealLog.countDocuments({ userId, imageUrl: { $nin: [null, ''] } }),
            nextCursor: hasMore ? items[items.length - 1].eatenAt : null,
        });
    } catch (error) {
        console.error('❌ Error fetching nutrition gallery:', error);
        res.status(500).json({ message: 'Error fetching gallery', error: error.message });
    }
};

/** GET /api/nutrition/status — whether AI logging is available, for the log-method sheet. */
exports.getStatus = (req, res) => {
    res.json({
        photoAnalysis: isConfigured(),
        descriptionAnalysis: isConfigured(),
        manualEntry: true,
        model: isConfigured() ? MODEL : null,
        acceptedTypes: ACCEPTED_MEDIA,
        maxBytes: MAX_BYTES,
    });
};

// Reused by the interpretation and assistant context builders
exports._summarise = summarise;
exports._syncGuidance = syncGuidance;
exports._localDay = localDay;
