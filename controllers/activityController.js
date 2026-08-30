const ActivitySession = require('../models/ActivitySession');
const ActivityPlan = require('../models/ActivityPlan');
const DailyMetrics = require('../models/DailyMetrics');
const PlanItem = require('../models/PlanItem');
const User = require('../models/userModel');
const { recomputeDay, localDay, resolveDay, normaliseType } = require('../utils/healthSync');
const { computeTargets, deriveGuidance, explain } = require('../utils/activityTargets');
const { scoreSession, scoreWindow, bandFor } = require('../utils/activityScore');
const scoreController = require('./scoreController');

/**
 * The dashboard's range tabs. `all` is capped rather than unbounded — a chart of every day
 * since signup is unreadable long before it is slow, and the design's "All" tab is a
 * lifetime summary, not a lifetime plot.
 */
const RANGES = { '1d': 1, '1w': 7, '1m': 30, '1y': 365, all: 730 };

/** The last `n` local days, oldest first, as `YYYY-MM-DD`. */
const dayRange = (n, tzOffset = 0, endDay) => {
    const end = endDay ? new Date(`${endDay}T00:00:00Z`) : new Date(Date.now() - tzOffset * 60_000);
    const days = [];
    for (let i = n - 1; i >= 0; i -= 1) {
        const d = new Date(end.getTime() - i * 86_400_000);
        days.push(d.toISOString().slice(0, 10));
    }
    return days;
};

/**
 * Consecutive days ending today that carry at least one session.
 *
 * Counted from the rollups rather than the sessions so it is one read. Today not having a
 * session yet does not break a streak — it is not over until the day is. Anything else
 * shows someone a broken streak at breakfast.
 */
const computeStreak = (days, byDay) => {
    let streak = 0;
    for (let i = days.length - 1; i >= 0; i -= 1) {
        const row = byDay.get(days[i]);
        const active = (row?.activity?.sessions || 0) > 0;
        if (active) { streak += 1; continue; }
        if (i === days.length - 1) continue; // today is still in play
        break;
    }
    return streak;
};

/**
 * Rebuild a plan's exercise guidance from the person's current PlanItems.
 *
 * Called on every read of the activity plan and the summary. Guidance is derived state —
 * the health plan is the source of truth — and recomputing it on read is what keeps the
 * tracker in step with a regenerated interpretation without a migration or a job. It is two
 * cheap queries and pure functions.
 *
 * Targets are only recalculated when the guidance actually changed. A weekly goal that
 * moved every time someone opened the screen would be unusable, and the signature check is
 * what stops that. The same guard `nutritionController.syncGuidance` uses.
 */
const syncGuidance = async (userId, plan, user) => {
    const exerciseItems = await PlanItem.find({
        userId,
        type: 'lifestyle',
        condition: 'exercise',
        status: { $nin: ['dismissed', 'completed'] },
    }).sort({ createdAt: 1 }).lean();

    const guidance = deriveGuidance(exerciseItems);
    const signature = (g) => g.map((x) => `${x.key}:${x.directive}`).sort().join('|');

    // Overrides are the person's own numbers and must survive a recalculation, so they are
    // part of what makes the result current, not something recomputed around.
    if (plan && signature(plan.guidance || []) === signature(guidance)) return plan;

    const computed = computeTargets({
        user,
        exerciseItems,
        selfRatedLevel: plan?.preferences?.selfRatedLevel,
        overrides: plan?.overrides,
    });

    if (!plan) {
        return ActivityPlan.create({
            userId,
            targets: computed.targets,
            basis: computed.basis,
            guidance,
            guidanceSyncedAt: new Date(),
        });
    }

    plan.targets = computed.targets;
    plan.basis = computed.basis;
    plan.guidance = guidance;
    plan.guidanceSyncedAt = new Date();
    await plan.save();
    return plan;
};

/**
 * GET /api/activity/plan — the person's weekly targets and the advice behind them.
 *
 * Returns a plan rather than 404 when they have not set one up: general guideline targets
 * are a better starting point than an empty screen, and "no plan yet" is the normal state
 * for everyone who has not had an interpretation with exercise advice in it.
 */
exports.getPlan = async (req, res) => {
    try {
        const userId = req.user.id;
        const [existing, user] = await Promise.all([
            ActivityPlan.findOne({ userId }),
            User.findById(userId).select('healthAssessment').lean(),
        ]);

        const plan = await syncGuidance(userId, existing, user);

        res.json({
            plan,
            explanation: explain({
                targets: plan.targets,
                guidance: plan.guidance,
                basis: plan.basis,
            }),
        });
    } catch (err) {
        console.error('❌ Reading activity plan failed:', err);
        res.status(500).json({ message: 'Could not load your activity plan' });
    }
};

/**
 * PUT /api/activity/plan — the person's own targets and preferences.
 *
 * Deliberately cannot write `guidance` or `targets` directly. Guidance is derived from the
 * health plan, and letting a client overwrite it would mean someone could edit away their
 * own clinical advice through the goal screen. What they can set is an override per target,
 * which is recorded as theirs and preserved through every later recalculation.
 */
exports.updatePlan = async (req, res) => {
    try {
        const userId = req.user.id;
        const { overrides, preferences, onboarded } = req.body || {};

        const [existing, user] = await Promise.all([
            ActivityPlan.findOne({ userId }),
            User.findById(userId).select('healthAssessment').lean(),
        ]);

        let plan = existing || await syncGuidance(userId, null, user);

        if (preferences) {
            plan.preferences = { ...plan.preferences?.toObject?.() ?? plan.preferences, ...preferences };
        }
        if (overrides) {
            // null clears an override and returns that target to the plan-derived figure
            plan.overrides = { ...plan.overrides?.toObject?.() ?? plan.overrides, ...overrides };
        }
        if (onboarded !== undefined) plan.onboarded = Boolean(onboarded);

        // Recompute with the new overrides and self-rating in play. Done here rather than in
        // syncGuidance because the guidance signature has not changed — the inputs have.
        const exerciseItems = await PlanItem.find({
            userId,
            type: 'lifestyle',
            condition: 'exercise',
            status: { $nin: ['dismissed', 'completed'] },
        }).sort({ createdAt: 1 }).lean();

        const computed = computeTargets({
            user,
            exerciseItems,
            selfRatedLevel: plan.preferences?.selfRatedLevel,
            overrides: plan.overrides,
        });

        plan.targets = computed.targets;
        plan.basis = computed.basis;
        plan.guidance = computed.guidance;
        plan.guidanceSyncedAt = new Date();
        await plan.save();

        console.log(`🎯 Activity plan updated u=${userId} ${plan.targets.sessions}x/${plan.targets.minutes}min`);

        res.json({
            plan,
            explanation: explain({
                targets: plan.targets,
                guidance: plan.guidance,
                basis: plan.basis,
            }),
        });
    } catch (err) {
        console.error('❌ Updating activity plan failed:', err);
        res.status(500).json({ message: 'Could not save your activity plan' });
    }
};

/**
 * GET /api/activity/summary?range=&tzOffset=
 *
 * Everything the dashboard draws above the fold: the chart series, the streak, the
 * highlight figures and the totals. One indexed read over `DailyMetrics` rather than an
 * aggregation over sessions — which is the reason that collection exists.
 */
exports.getSummary = async (req, res) => {
    try {
        const userId = req.user.id;
        const range = RANGES[req.query.range] ? req.query.range : '1w';
        const tzOffset = Number(req.query.tzOffset) || 0;
        const days = dayRange(RANGES[range], tzOffset);

        const [rows, existingPlan, user] = await Promise.all([
            DailyMetrics.find({
                userId,
                day: { $gte: days[0], $lte: days[days.length - 1] },
            }).lean(),
            ActivityPlan.findOne({ userId }),
            User.findById(userId).select('healthAssessment').lean(),
        ]);

        // Derived on read, like the nutrition plan's guidance: a regenerated interpretation
        // has to move the goal card without anybody running a job.
        const plan = await syncGuidance(userId, existingPlan, user);

        const byDay = new Map(rows.map((r) => [r.day, r]));

        /**
         * Every figure the rollup holds, not just the ones the first chart drew.
         *
         * A day a watch was not worn and a day of no steps are different facts, so every
         * metric is `null` rather than `0` when nothing reported it — the chart draws that
         * as a gap and the stat grid hides the tile. Summing them as zero would tell
         * someone they walked nowhere on a day nobody measured.
         */
        const series = days.map((day) => {
            const r = byDay.get(day);
            return {
                day,
                sessions: r?.activity?.sessions || 0,
                exerciseMin: r?.activity?.exerciseMin ?? null,
                activeKcal: r?.activity?.activeKcal ?? null,
                restingKcal: r?.activity?.restingKcal ?? null,
                steps: r?.activity?.steps ?? null,
                distanceM: r?.activity?.distanceM ?? null,
                floors: r?.activity?.floors ?? null,
                restingBpm: r?.heart?.restingBpm ?? null,
                avgBpm: r?.heart?.avgBpm ?? null,
                minBpm: r?.heart?.minBpm ?? null,
                maxBpm: r?.heart?.maxBpm ?? null,
                hrvMs: r?.heart?.hrvMs ?? null,
                score: r?.activity?.score ?? null,
            };
        });

        const reported = (key) => series
            .map((p) => p[key])
            .filter((v) => Number.isFinite(v));

        /** Summed over the range; null when the range holds no reading at all. */
        const sum = (key) => {
            const values = reported(key);
            return values.length ? Math.round(values.reduce((a, b) => a + b, 0)) : null;
        };

        /**
         * Averaged over the days that reported, never over the range.
         *
         * Dividing by days a watch was not worn understates the figure and then calls it an
         * average — which is why `days` travels alongside it and the client says "across N
         * days with data" rather than presenting it as the whole period.
         */
        const mean = (key) => {
            const values = reported(key);
            if (!values.length) return null;
            const value = values.reduce((a, b) => a + b, 0) / values.length;
            return { value: Math.round(value * 10) / 10, days: values.length };
        };

        const withKcal = series.filter((p) => Number.isFinite(p.activeKcal));
        const totals = {
            sessions: series.reduce((s, p) => s + p.sessions, 0),
            exerciseMin: series.reduce((s, p) => s + (p.exerciseMin || 0), 0),
            activeKcal: series.reduce((s, p) => s + (p.activeKcal || 0), 0),
            distanceM: series.reduce((s, p) => s + (p.distanceM || 0), 0),
            steps: sum('steps'),
            floors: sum('floors'),
            restingKcal: sum('restingKcal'),
        };

        // One entry per metric the dashboard can chart or tile, so a screen never has to
        // decide whether a number is missing or merely zero.
        const averages = {
            exerciseMin: mean('exerciseMin'),
            activeKcal: mean('activeKcal'),
            restingKcal: mean('restingKcal'),
            steps: mean('steps'),
            distanceM: mean('distanceM'),
            floors: mean('floors'),
            restingBpm: mean('restingBpm'),
            avgBpm: mean('avgBpm'),
            minBpm: mean('minBpm'),
            maxBpm: mean('maxBpm'),
            hrvMs: mean('hrvMs'),
        };

        const scored = scoreWindow({ series, targets: plan?.targets, days: days.length });
        const band = bandFor(scored.value);

        res.json({
            range,
            days,
            series,
            totals,
            averages,
            streak: computeStreak(days, byDay),
            highlight: {
                // Averaged over the days that reported, not over the range: dividing by
                // days a watch was not worn understates the figure and calls it an average.
                avgKcal: withKcal.length
                    ? Math.round(withKcal.reduce((s, p) => s + p.activeKcal, 0) / withKcal.length)
                    : null,
                daysReported: withKcal.length,
            },
            /**
             * Null when there is no plan to measure against, never zero. Nobody has failed
             * at a target nobody set — the same call `MealLog`'s `unassessed` alignment
             * makes, and the dashboard hides the section rather than rendering 0%.
             */
            score: scored.value,
            band: band ? { key: band.key, label: band.label } : null,
            goal: scored.progress,
            targets: plan?.targets || null,
            guidance: (plan?.guidance || []).map((g) => ({
                key: g.key,
                kind: g.kind,
                label: g.label,
                directive: g.directive,
            })),
        });
    } catch (err) {
        console.error('❌ Activity summary failed:', err);
        res.status(500).json({ message: 'Could not load activity summary' });
    }
};

/**
 * GET /api/activity/calendar?month=YYYY-MM&tzOffset=
 *
 * The month grid on the dashboard — `Design/activity.svg` frames 7 and 20, where every date
 * carries a ring showing how much of that day was done.
 *
 * Its own endpoint rather than a wider `/summary`, because it answers a different question:
 * `/summary` is "the last N days" and a calendar is "this named month", and the two disagree
 * about their edges on every screen that draws both. One indexed read over `DailyMetrics`.
 *
 * `progress` is the fraction of a day's share of the weekly minutes target. **Null when
 * there is no target**, never zero — a ring at zero on a plan nobody set says the person
 * failed at something nobody asked of them, the same call `/summary`'s score makes. The
 * client draws a plain marker for those days instead of an empty ring.
 */
exports.getCalendar = async (req, res) => {
    try {
        const userId = req.user.id;
        const tzOffset = Number(req.query.tzOffset) || 0;

        const raw = String(req.query.month || '');
        const month = /^\d{4}-\d{2}$/.test(raw)
            ? raw
            : localDay(new Date(), tzOffset).slice(0, 7);

        const [year, mon] = month.split('-').map(Number);
        // Day 0 of the following month is the last day of this one.
        const length = new Date(Date.UTC(year, mon, 0)).getUTCDate();
        const pad = (n) => String(n).padStart(2, '0');

        const [rows, plan] = await Promise.all([
            DailyMetrics.find({
                userId,
                day: { $gte: `${month}-01`, $lte: `${month}-${pad(length)}` },
            }).lean(),
            ActivityPlan.findOne({ userId }).select('targets').lean(),
        ]);

        // A day's share of the weekly target. The plan is weekly because that is how the
        // guidance is worded; the grid is daily because that is what a calendar is.
        const dailyMinutes = plan?.targets?.minutes > 0 ? plan.targets.minutes / 7 : null;

        const byDay = new Map(rows.map((r) => [r.day, r]));
        const days = [];

        for (let d = 1; d <= length; d += 1) {
            const day = `${month}-${pad(d)}`;
            const r = byDay.get(day);
            const exerciseMin = r?.activity?.exerciseMin ?? null;

            days.push({
                day,
                sessions: r?.activity?.sessions || 0,
                exerciseMin,
                activeKcal: r?.activity?.activeKcal ?? null,
                steps: r?.activity?.steps ?? null,
                score: r?.activity?.score ?? null,
                progress: dailyMinutes && Number.isFinite(exerciseMin)
                    ? Math.round(Math.min(1, exerciseMin / dailyMinutes) * 100) / 100
                    : null,
            });
        }

        res.json({ month, days, hasTarget: Boolean(dailyMinutes) });
    } catch (err) {
        console.error('❌ Activity calendar failed:', err);
        res.status(500).json({ message: 'Could not load your activity calendar' });
    }
};

/** GET /api/activity/day?date=&tzOffset= — one day's sessions plus its rollup. */
exports.getDay = async (req, res) => {
    try {
        const userId = req.user.id;
        const tzOffset = Number(req.query.tzOffset) || 0;
        const day = resolveDay(req.query.date, new Date(), tzOffset);

        const [sessions, metrics] = await Promise.all([
            ActivitySession.find({ userId, day }).sort({ startedAt: -1 }).lean(),
            DailyMetrics.findOne({ userId, day }).lean(),
        ]);

        res.json({ day, sessions, metrics: metrics || null });
    } catch (err) {
        console.error('❌ Activity day failed:', err);
        res.status(500).json({ message: 'Could not load the day' });
    }
};

/**
 * GET /api/activity/sessions — history, search and the filter sheet.
 *
 * One endpoint for all three because the design's three screens differ only by which
 * filters are populated, and splitting them would mean three near-identical queries drifting
 * apart.
 */
exports.listSessions = async (req, res) => {
    try {
        const userId = req.user.id;
        const {
            from, to, type, q, sort = 'recent', limit = 50, skip = 0,
            minKcal, maxKcal,
        } = req.query;

        const filter = { userId };
        if (from || to) {
            filter.startedAt = {};
            if (from) filter.startedAt.$gte = new Date(from);
            if (to) filter.startedAt.$lte = new Date(to);
        }
        if (type) filter.type = { $in: String(type).split(',').map(normaliseType) };
        if (minKcal || maxKcal) {
            filter.activeKcal = {};
            if (minKcal) filter.activeKcal.$gte = Number(minKcal);
            if (maxKcal) filter.activeKcal.$lte = Number(maxKcal);
        }
        // Type and notes only. A regex over a free-text field is the whole of search here —
        // there is no text index, and adding one for a list this size would be premature.
        if (q) {
            const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            filter.$or = [{ type: rx }, { notes: rx }];
        }

        const order = {
            recent: { startedAt: -1 },
            oldest: { startedAt: 1 },
            longest: { durationSec: -1 },
            distance: { distanceM: -1 },
        }[sort] || { startedAt: -1 };

        const capped = Math.min(Number(limit) || 50, 200);

        const [sessions, total] = await Promise.all([
            ActivitySession.find(filter).sort(order).skip(Number(skip) || 0).limit(capped).lean(),
            ActivitySession.countDocuments(filter),
        ]);

        res.json({ sessions, total, limit: capped, skip: Number(skip) || 0 });
    } catch (err) {
        console.error('❌ Listing sessions failed:', err);
        res.status(500).json({ message: 'Could not list activities' });
    }
};

/** GET /api/activity/sessions/:id */
exports.getSession = async (req, res) => {
    try {
        const session = await ActivitySession.findOne({
            _id: req.params.id,
            userId: req.user.id,
        }).lean();

        if (!session) return res.status(404).json({ message: 'Activity not found' });
        res.json({ session });
    } catch (err) {
        console.error('❌ Reading session failed:', err);
        res.status(500).json({ message: 'Could not load the activity' });
    }
};

/**
 * POST /api/activity/sessions — a manually logged activity.
 *
 * `source: 'manual'` and no `externalId`, which is what keeps it out of the de-duplication
 * index and safe from being overwritten by a later sync.
 */
exports.createSession = async (req, res) => {
    try {
        const userId = req.user.id;
        const {
            type, startedAt, endedAt, durationSec, distanceM, activeKcal,
            effort, notes, tzOffset, day,
        } = req.body || {};

        if (!type || !startedAt) {
            return res.status(400).json({ message: 'type and startedAt are required' });
        }

        const start = new Date(startedAt);
        if (Number.isNaN(start.getTime())) {
            return res.status(400).json({ message: 'startedAt is not a valid date' });
        }

        const end = endedAt ? new Date(endedAt) : null;
        const duration = Number.isFinite(durationSec)
            ? Math.round(durationSec)
            : (end ? Math.round((end - start) / 1000) : 0);

        if (duration <= 0) {
            return res.status(400).json({ message: 'An activity needs a duration' });
        }

        const resolvedDay = resolveDay(day, start, tzOffset);

        const session = await ActivitySession.create({
            userId,
            type: normaliseType(type),
            startedAt: start,
            endedAt: end,
            day: resolvedDay,
            durationSec: duration,
            distanceM,
            activeKcal,
            effort,
            notes,
            source: 'manual',
        });

        await recomputeDay(userId, resolvedDay);
        console.log(`🏃 Manual activity ${session.type} u=${userId} d=${resolvedDay}`);

        // Recomputed in the background so the score reflects this the next time the home
        // screen asks, rather than fifteen minutes later. Never awaited: a scoring failure
        // must not be able to fail the write the person actually made.
        scoreController.touch(userId, 'log');

        res.status(201).json({ session });
    } catch (err) {
        console.error('❌ Creating session failed:', err);
        res.status(500).json({ message: 'Could not save the activity' });
    }
};

/**
 * PATCH /api/activity/sessions/:id
 *
 * Only the fields a person owns. The measurements a watch recorded are not editable — an
 * app that lets someone rewrite what their device measured cannot claim the number came
 * from the device. Manual sessions are the exception: nothing measured them.
 */
exports.updateSession = async (req, res) => {
    try {
        const userId = req.user.id;
        const session = await ActivitySession.findOne({ _id: req.params.id, userId });
        if (!session) return res.status(404).json({ message: 'Activity not found' });

        const { effort, notes, type, distanceM, activeKcal, durationSec } = req.body || {};

        if (effort !== undefined) session.effort = effort;
        if (notes !== undefined) session.notes = notes;

        if (session.source === 'manual') {
            if (type !== undefined) session.type = normaliseType(type);
            if (distanceM !== undefined) session.distanceM = distanceM;
            if (activeKcal !== undefined) session.activeKcal = activeKcal;
            if (durationSec !== undefined) session.durationSec = Math.max(0, Math.round(durationSec));
        } else if (type !== undefined || distanceM !== undefined || activeKcal !== undefined) {
            return res.status(409).json({
                message: 'Measured values on a synced activity cannot be edited',
                editable: ['effort', 'notes'],
            });
        }

        await session.save();
        await recomputeDay(userId, session.day);

        res.json({ session });
    } catch (err) {
        console.error('❌ Updating session failed:', err);
        res.status(500).json({ message: 'Could not update the activity' });
    }
};

/**
 * DELETE /api/activity/sessions/:id
 *
 * Deleting a synced session is a local decision: the row comes back on the next sync,
 * because the health store still holds it. Say so rather than letting it silently reappear.
 */
exports.deleteSession = async (req, res) => {
    try {
        const userId = req.user.id;
        const session = await ActivitySession.findOneAndDelete({ _id: req.params.id, userId });
        if (!session) return res.status(404).json({ message: 'Activity not found' });

        await recomputeDay(userId, session.day);

        res.json({
            message: 'Activity deleted',
            willResync: session.source !== 'manual' && session.source !== 'live',
        });
    } catch (err) {
        console.error('❌ Deleting session failed:', err);
        res.status(500).json({ message: 'Could not delete the activity' });
    }
};

exports._dayRange = dayRange;
exports._computeStreak = computeStreak;
exports._syncGuidance = syncGuidance;
exports._RANGES = RANGES;
exports._localDay = localDay;
