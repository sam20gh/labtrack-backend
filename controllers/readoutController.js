const DailyMetrics = require('../models/DailyMetrics');
const SleepPlan = require('../models/SleepPlan');
const VitalAlert = require('../models/VitalAlert');
const NutritionPlan = require('../models/NutritionPlan');
const MealLog = require('../models/MealLog');
const SleepSession = require('../models/SleepSession');
const User = require('../models/userModel');
const { recomputeDay } = require('../utils/healthSync');
const { EFFORT_VERSION } = require('../utils/effort');
const {
    buildReadout, weekStartOf, reasonsFor, recoveryTrend, lateMealFor, BASELINE_DAYS,
} = require('../utils/dailyReadout');

const DAY_MS = 86400000;

/** `YYYY-MM-DD` for an instant, `tzOffset` minutes west of UTC (`getTimezoneOffset()`). */
const localDay = (ms, tzOffset) => new Date(ms - tzOffset * 60000).toISOString().slice(0, 10);

/**
 * GET /api/readout?tzOffset= — the home screen's Sleep · Recovery · Effort readout, with Fuel.
 *
 * Database reads only, so the home screen can put it in its first-paint batch: one range of
 * `DailyMetrics` (29 days for the baselines), the sleep goal, whether an urgent vital alert is
 * open, the nutrition plan as last synced, today's meals and a weight. `utils/dailyReadout.js`
 * decides what they mean. The plan's guidance is not re-synced here: the home screen's own
 * nutrition read does that, and a model-free read must stay cheap.
 *
 * A day of this week rolled up before effort existed, or under older rules, carries no
 * `activity.effortVersion` or an older one. Those days are recomputed here, once each, so the
 * week's total is right on the first open after a deploy rather than after a week of syncs.
 */
exports.getReadout = async (req, res) => {
    try {
        const userId = req.auth.userId;
        const tzOffset = Number(req.query.tzOffset) || 0;
        const now = Date.now();
        const today = localDay(now, tzOffset);
        const hour = new Date(now - tzOffset * 60000).getUTCHours();
        const from = localDay(now - (BASELINE_DAYS + 1) * DAY_MS, tzOffset);
        const weekStart = weekStartOf(today);

        const read = () => DailyMetrics.find({ userId, day: { $gte: from } })
            .sort({ day: 1 }).lean();

        let rows = await read();
        // Days of this week rolled up before effort existed, or under older effort rules.
        const stale = rows.filter((r) => r.day >= weekStart && r.activity?.effortVersion !== EFFORT_VERSION);
        if (stale.length) {
            for (const r of stale) await recomputeDay(r.userId, r.day);
            rows = await read();
        }

        const [plan, urgent, nutritionPlan, meals, user] = await Promise.all([
            SleepPlan.findOne({ userId }).select('goalMinutes').lean(),
            VitalAlert.exists({ userId, isOpen: true, level: 'urgent' }),
            NutritionPlan.findOne({ userId }).select('targets guidance mealsPerDay').lean(),
            MealLog.find({ userId, day: today }).select('calories protein carbs fat analysis.alignment eatenAt').lean(),
            User.findById(userId).select('weight observed.weightKg').lean(),
        ]);

        res.json(buildReadout({
            rows,
            today,
            hour,
            goalMinutes: plan?.goalMinutes ?? null,
            urgentAlert: Boolean(urgent),
            meals,
            nutritionPlan,
            // What the trackers measured first, the onboarding answer second.
            weightKg: user?.observed?.weightKg ?? (Number(user?.weight) || null),
        }));
    } catch (err) {
        console.error('❌ Building the readout failed:', err);
        res.status(500).json({ message: 'Could not load today' });
    }
};

/**
 * GET /api/readout/recovery?tzOffset= — the Recovery screen.
 *
 * Today's recovery with its signals, the plain reasons behind it, and the last seven days,
 * each judged against its own preceding 28 — so this reads 35 days rather than 29.
 */
exports.getRecovery = async (req, res) => {
    try {
        const userId = req.auth.userId;
        const tzOffset = Number(req.query.tzOffset) || 0;
        const now = Date.now();
        const today = localDay(now, tzOffset);
        const from = localDay(now - (BASELINE_DAYS + 7) * DAY_MS, tzOffset);

        const yesterday = localDay(now - DAY_MS, tzOffset);
        const [rows, urgent, night, meals] = await Promise.all([
            DailyMetrics.find({ userId, day: { $gte: from } }).sort({ day: 1 }).lean(),
            VitalAlert.exists({ userId, isOpen: true, level: 'urgent' }),
            // Last night: the longest sleep filed under today, the wake day.
            SleepSession.findOne({ userId, day: today }).sort({ asleepMin: -1 }).select('startedAt').lean(),
            MealLog.find({ userId, day: { $in: [yesterday, today] } }).select('eatenAt').lean(),
        ]);
        const readout = buildReadout({ rows, today, hour: 8, urgentAlert: Boolean(urgent) });
        const lateMeal = night ? lateMealFor(meals, new Date(night.startedAt).getTime(), tzOffset) : null;

        res.json({
            day: today,
            recovery: readout.recovery,
            reasons: reasonsFor(readout.recovery, { lateMeal }),
            trend: recoveryTrend(rows, today, 7),
            effortTarget: readout.effort.target,
            targetReason: readout.effort.targetReason,
        });
    } catch (err) {
        console.error('❌ Building recovery failed:', err);
        res.status(500).json({ message: 'Could not load recovery' });
    }
};
