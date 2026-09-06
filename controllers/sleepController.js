const SleepSession = require('../models/SleepSession');
const SleepPlan = require('../models/SleepPlan');
const SleepSchedule = require('../models/SleepSchedule');
const PlanItem = require('../models/PlanItem');
const User = require('../models/userModel');
const { recomputeDay, localDay, resolveDay } = require('../utils/healthSync');
const { scoreNight, bandFor, explain: explainScore, BANDS, WEIGHTS } = require('../utils/sleepScore');
const {
    computeGoal, deriveGuidance, bedtimeFor, explain: explainGoal, formatMinutes, CAPS,
} = require('../utils/sleepTargets');
const {
    stageBreakdown, stageRanges, byWeekday, consistency, comparePeriods,
    computeStreak, goalProgress, localMinutes, STAGES,
} = require('../utils/sleepInsight');
const scoreController = require('./scoreController');
const achievementController = require('./achievementController');

/**
 * The sleep tracker's read and write API — `Design/sleep.svg`.
 *
 * **Nothing on these screens is a model's opinion.** Every number comes off the person's own
 * `SleepSession` rows through `utils/sleepScore.js` and `utils/sleepInsight.js`, both of
 * which are deterministic and tested. The AI recommendation rail the design draws is the
 * resource library filtered to sleep, which is content somebody wrote, not a generated
 * paragraph about somebody's night.
 *
 * **Where the nights come from.** Nothing here ingests. `POST /api/wearables/sync` writes
 * `SleepSession` rows from Health Connect and HealthKit through `utils/healthSync.js`, the
 * same path that already brought the activity sessions in, and this controller reads what
 * that produced. The only rows it creates are the ones somebody types in by hand, which is
 * the fallback for a phone with no health store rather than the main path.
 *
 * **The goal is read before a night is scored, not after.** `scoreNight` takes
 * `goalMinutes`, so a change to the goal has to rescore the nights that were scored against
 * the old one — see `rescoreNights`. Leaving them would mean the history disagreed with the
 * dial that produced it, which is exactly the drift `DailyMetrics` is rebuilt to avoid.
 */

/** The dashboard's range tabs. `all` is capped for the reason `activityController` gives. */
const RANGES = { '1d': 1, '1w': 7, '1m': 30, '1y': 365, all: 730 };

/** How far back a goal change rescores. Two years, matching the widest range on offer. */
const RESCORE_DAYS = 730;

/** The last `n` local days, oldest first, as `YYYY-MM-DD`. */
const dayRange = (n, tzOffset = 0, endDay) => {
    const end = endDay ? new Date(`${endDay}T00:00:00Z`) : new Date(Date.now() - tzOffset * 60_000);
    const days = [];
    for (let i = n - 1; i >= 0; i -= 1) {
        days.push(new Date(end.getTime() - i * 86_400_000).toISOString().slice(0, 10));
    }
    return days;
};

/**
 * The night a day is represented by.
 *
 * A day can carry several rows — a watch splits a disturbed night, a nap syncs as its own
 * session — and the design shows one figure per day. The longest wins, which is the same
 * choice `healthSync.recomputeDay` makes when it fills `DailyMetrics.sleep`; making it
 * differently here would put a different number on the dashboard from the one in the trend
 * chart directly beneath it.
 */
const mainNight = (nights = []) =>
    nights.slice().sort((a, b) => (b.asleepMin || 0) - (a.asleepMin || 0))[0] || null;

/**
 * Rebuild the plan's sleep guidance and goal from the person's current PlanItems.
 *
 * Called on every read, like `activityController.syncGuidance` and
 * `nutritionController.syncGuidance`. Guidance is derived state — the health plan is the
 * source of truth — and recomputing it on read is what keeps the tracker in step with a
 * regenerated interpretation without a migration or a job.
 *
 * The goal only moves when the guidance actually changed, or when the person has never set
 * one. A nightly target that shifted every time the screen opened is a target nobody trusts;
 * the signature check is what stops that.
 */
const syncGuidance = async (userId, existing, user) => {
    const sleepItems = await PlanItem.find({
        userId,
        type: 'lifestyle',
        condition: 'sleep',
        status: { $nin: ['dismissed', 'completed'] },
    }).sort({ createdAt: 1 }).lean();

    const guidance = deriveGuidance(sleepItems);
    const signature = (g) => g.map((x) => `${x.key}:${x.directive}`).sort().join('|');

    let plan = existing;
    const unchanged = plan && signature(plan.guidance || []) === signature(guidance);

    const computed = computeGoal({
        user,
        sleepItems,
        reportedAverageHours: plan?.reportedAverageHours,
        // A goal the person set themselves survives every recalculation. It is theirs.
        override: plan?.goalSetByUser ? plan.goalMinutes : undefined,
    });

    if (!plan) {
        plan = await SleepPlan.create({
            userId,
            goalMinutes: computed.minutes,
            guidance,
            guidanceSyncedAt: new Date(),
        });
        return { plan, basis: computed.basis, sleepItems };
    }

    if (unchanged) return { plan, basis: computed.basis, sleepItems };

    plan.goalMinutes = computed.minutes;
    plan.guidance = guidance;
    plan.guidanceSyncedAt = new Date();
    await plan.save();

    return { plan, basis: computed.basis, sleepItems, goalMoved: true };
};

/**
 * Rescore every stored night against a new goal, and rebuild the days they belong to.
 *
 * Only the rows whose score actually changed are written, so a no-op goal change costs one
 * read and no writes — the same guard `recomputeDay` applies to `ActivitySession.scoreDelta`.
 *
 * Deliberately awaited by the caller rather than fired and forgotten: somebody who has just
 * moved their goal is looking at the trend chart, and a chart that updates a few seconds
 * later looks like a bug in the goal screen.
 */
const rescoreNights = async (userId, goalMinutes) => {
    const from = dayRange(RESCORE_DAYS)[0];
    const nights = await SleepSession.find({ userId, day: { $gte: from } })
        .select('asleepMin efficiency stages score day')
        .lean();

    const writes = [];
    const days = new Set();

    for (const night of nights) {
        const score = scoreNight({
            asleepMin: night.asleepMin,
            efficiency: night.efficiency,
            stages: night.stages,
            goalMinutes,
        });
        if (score === (night.score ?? null)) continue;
        writes.push({ updateOne: { filter: { _id: night._id }, update: { $set: { score } } } });
        days.add(night.day);
    }

    if (!writes.length) return { rescored: 0, days: [] };

    await SleepSession.bulkWrite(writes, { ordered: false });
    for (const day of days) await recomputeDay(userId, day);

    return { rescored: writes.length, days: [...days].sort() };
};

/** The shape every screen reads a night through. Keeps the wire format in one place. */
const nightView = (night, goalMinutes, tzOffset = 0) => {
    if (!night) return null;
    const band = bandFor(night.score);
    return {
        _id: night._id,
        day: night.day,
        startedAt: night.startedAt,
        endedAt: night.endedAt,
        bedtimeMin: localMinutes(night.startedAt, tzOffset),
        wakeMin: localMinutes(night.endedAt, tzOffset),
        asleepMin: night.asleepMin ?? null,
        inBedMin: night.inBedMin ?? null,
        stages: {
            deepMin: night.stages?.deepMin ?? null,
            remMin: night.stages?.remMin ?? null,
            lightMin: night.stages?.lightMin ?? null,
            awakeMin: night.stages?.awakeMin ?? null,
        },
        efficiency: night.efficiency ?? null,
        score: night.score ?? null,
        band: band ? { key: band.key, label: band.label } : null,
        goalProgress: goalProgress(night.asleepMin, goalMinutes),
        source: night.source,
        sourceDevice: night.sourceDevice || null,
        /** A row somebody typed can be corrected; one a watch measured cannot. */
        editable: night.source === 'manual',
        notes: night.notes || null,
    };
};

/** The hypnogram, only ever sent with a single night. Segments are large and nothing else
 *  draws them, so keeping them off the list responses is what makes history one small read. */
const segmentView = (night) => (night.segments || []).map((s) => ({
    stage: s.stage,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    minutes: Math.max(0, Math.round((new Date(s.endedAt) - new Date(s.startedAt)) / 60_000)),
}));

/* ------------------------------------------------------------------ plan */

/**
 * GET /api/sleep/plan
 *
 * Returns a plan rather than 404 when somebody has not set one up. "No plan yet" is the
 * normal state for everyone who has not had an interpretation with sleep advice in it, and
 * the guideline figure is a better starting point than an empty screen.
 */
exports.getPlan = async (req, res) => {
    try {
        const userId = req.user.id;
        const [existing, user] = await Promise.all([
            SleepPlan.findOne({ userId }),
            User.findById(userId).select('dob healthAssessment').lean(),
        ]);

        const { plan, basis } = await syncGuidance(userId, existing, user);

        res.json({
            plan,
            basis,
            explanation: explainGoal({ minutes: plan.goalMinutes, guidance: plan.guidance, basis }),
            bounds: CAPS,
        });
    } catch (err) {
        console.error('❌ Reading sleep plan failed:', err);
        res.status(500).json({ message: 'Could not load your sleep plan' });
    }
};

/**
 * PUT /api/sleep/plan
 *
 * Deliberately cannot write `guidance`. It is derived from the health plan, and letting a
 * client overwrite it would mean somebody could edit away their own clinical advice through
 * the goal screen — the line `nutritionController` and `activityController` both hold.
 *
 * A goal the person picks is clamped to the healthy adult range rather than rejected, and
 * `basis.clamped` says so: refusing the save would leave them stuck on a screen with no way
 * to tell them why, and silently storing four hours would make a four-hour night score 100.
 */
exports.updatePlan = async (req, res) => {
    try {
        const userId = req.user.id;
        const {
            goalMinutes, bedtimeWindow, wakeWindow, selfRatedDepth,
            reportedAverageHours, onboarded,
        } = req.body || {};

        const [existing, user] = await Promise.all([
            SleepPlan.findOne({ userId }),
            User.findById(userId).select('dob healthAssessment').lean(),
        ]);

        const { plan } = await syncGuidance(userId, existing, user);
        const previousGoal = plan.goalMinutes;

        const window = (value, current) => {
            if (value === undefined) return current;
            if (value === null) return { fromMin: null, toMin: null };
            const clamp = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1439, Math.round(v))) : null);
            return { fromMin: clamp(value.fromMin), toMin: clamp(value.toMin) };
        };

        plan.bedtimeWindow = window(bedtimeWindow, plan.bedtimeWindow);
        plan.wakeWindow = window(wakeWindow, plan.wakeWindow);

        if (selfRatedDepth !== undefined) {
            plan.selfRatedDepth = selfRatedDepth === null
                ? null
                : Math.max(1, Math.min(5, Math.round(Number(selfRatedDepth))));
        }
        if (reportedAverageHours !== undefined) {
            plan.reportedAverageHours = reportedAverageHours === null
                ? null
                : Math.max(1, Math.min(14, Number(reportedAverageHours)));
        }
        if (onboarded !== undefined) plan.onboarded = Boolean(onboarded);

        // Recomputed with the new inputs in play. `goalSetByUser` only flips when a number
        // actually arrives, so accepting the suggestion and then editing a window later does
        // not retroactively make the suggestion "theirs".
        const computed = computeGoal({
            user,
            sleepItems: await PlanItem.find({
                userId, type: 'lifestyle', condition: 'sleep',
                status: { $nin: ['dismissed', 'completed'] },
            }).sort({ createdAt: 1 }).lean(),
            reportedAverageHours: plan.reportedAverageHours,
            override: goalMinutes !== undefined && goalMinutes !== null
                ? Number(goalMinutes)
                : (plan.goalSetByUser ? plan.goalMinutes : undefined),
        });

        if (goalMinutes !== undefined && goalMinutes !== null) plan.goalSetByUser = true;
        plan.goalMinutes = computed.minutes;
        await plan.save();

        // Every stored night was scored against the old goal. Rescoring is what keeps the
        // history and the dial telling the same story — see the note on `rescoreNights`.
        const rescore = plan.goalMinutes !== previousGoal
            ? await rescoreNights(userId, plan.goalMinutes)
            : { rescored: 0, days: [] };

        // 'manual' rather than a sleep-specific string: `HealthScore.trigger` is an enum,
        // and an unrecognised value fails validation inside `touch`'s own try/catch — the
        // snapshot would silently never be written.
        if (rescore.rescored) scoreController.touch(userId, 'manual');

        console.log(
            `🌙 Sleep plan updated u=${userId} goal=${formatMinutes(plan.goalMinutes)}` +
            (rescore.rescored ? ` (${rescore.rescored} nights rescored)` : '')
        );

        res.json({
            plan,
            basis: computed.basis,
            explanation: explainGoal({
                minutes: plan.goalMinutes, guidance: plan.guidance, basis: computed.basis,
            }),
            bounds: CAPS,
            rescoredNights: rescore.rescored,
        });
    } catch (err) {
        console.error('❌ Updating sleep plan failed:', err);
        res.status(500).json({ message: 'Could not save your sleep plan' });
    }
};

/* ------------------------------------------------------- the dashboard */

/**
 * GET /api/sleep/overview?tzOffset=&range=
 *
 * Everything frame 7 draws above the fold, in one round trip: last night, its score and
 * band, the week strip, the goal ring, the trend series and the schedule the person keeps.
 *
 * The design's dashboard is the screen somebody opens at 7am, so it is one request rather
 * than five — a strip of spinners at breakfast is the failure `app/nutrition/index.tsx`
 * documents from the other direction.
 */
exports.getOverview = async (req, res) => {
    try {
        const userId = req.user.id;
        const tzOffset = Number(req.query.tzOffset) || 0;
        const range = RANGES[req.query.range] ? req.query.range : '1w';
        const days = dayRange(RANGES[range], tzOffset);
        const today = req.query.day && /^\d{4}-\d{2}-\d{2}$/.test(req.query.day)
            ? req.query.day
            : localDay(new Date(), tzOffset);

        const [existing, user] = await Promise.all([
            SleepPlan.findOne({ userId }),
            User.findById(userId).select('dob healthAssessment').lean(),
        ]);
        const { plan, basis } = await syncGuidance(userId, existing, user);

        const [nights, schedules] = await Promise.all([
            SleepSession.find({ userId, day: { $gte: days[0], $lte: days[days.length - 1] } })
                .select('-segments')
                .sort({ endedAt: 1 })
                .lean(),
            SleepSchedule.find({ userId }).sort({ bedtimeMin: 1 }).lean(),
        ]);

        // One night per day, chosen the same way the rollup chooses it.
        const byDay = new Map();
        for (const night of nights) {
            const current = byDay.get(night.day);
            if (!current || (night.asleepMin || 0) > (current.asleepMin || 0)) byDay.set(night.day, night);
        }

        const series = days.map((day) => {
            const night = byDay.get(day);
            return {
                day,
                asleepMin: night?.asleepMin ?? null,
                inBedMin: night?.inBedMin ?? null,
                score: night?.score ?? null,
                efficiency: night?.efficiency ?? null,
                deepMin: night?.stages?.deepMin ?? null,
                remMin: night?.stages?.remMin ?? null,
                lightMin: night?.stages?.lightMin ?? null,
                awakeMin: night?.stages?.awakeMin ?? null,
                bedtimeMin: night ? localMinutes(night.startedAt, tzOffset) : null,
                wakeMin: night ? localMinutes(night.endedAt, tzOffset) : null,
                goalProgress: goalProgress(night?.asleepMin, plan.goalMinutes),
            };
        });

        /**
         * Last night is the day's own row when there is one, and otherwise the most recent
         * night in the window.
         *
         * Falling back matters at the hour this screen is used: somebody who opens the app
         * at 7am before their watch has synced should see the night they actually had, not
         * an empty ring. `latest.day !== today` is on the response so the card can say which
         * night it is describing rather than implying it is this morning's.
         */
        const todayNight = byDay.get(today) || null;
        const latest = todayNight || [...byDay.values()].sort(
            (a, b) => new Date(b.endedAt) - new Date(a.endedAt)
        )[0] || null;

        const measured = series.filter((p) => Number.isFinite(p.asleepMin));
        const scored = series.filter((p) => Number.isFinite(p.score));

        res.json({
            today,
            range,
            days,
            series,
            /** Null, never zero: a window nobody slept through measured nothing, and an
             *  average of nothing is not an average of no sleep. */
            averages: {
                asleepMin: measured.length
                    ? Math.round(measured.reduce((s, p) => s + p.asleepMin, 0) / measured.length)
                    : null,
                score: scored.length
                    ? Math.round(scored.reduce((s, p) => s + p.score, 0) / scored.length)
                    : null,
                nights: measured.length,
            },
            latest: nightView(latest, plan.goalMinutes, tzOffset),
            isToday: Boolean(todayNight),
            streak: computeStreak(days, byDay),
            goal: {
                minutes: plan.goalMinutes,
                setByUser: Boolean(plan.goalSetByUser),
                progress: goalProgress(latest?.asleepMin, plan.goalMinutes),
                explanation: explainGoal({
                    minutes: plan.goalMinutes, guidance: plan.guidance, basis,
                }),
                /** The bedtime that lands them at their wake window having slept the goal.
                 *  Null when they have not told us when they get up — an invented bedtime
                 *  on a card headed "Optimal Sleep Duration" is a recommendation nobody made. */
                suggestedBedtimeMin: Number.isFinite(plan.wakeWindow?.fromMin)
                    ? bedtimeFor(plan.wakeWindow.fromMin, plan.goalMinutes)
                    : null,
                wakeMin: plan.wakeWindow?.fromMin ?? null,
            },
            schedules: schedules.map((s) => ({
                _id: s._id,
                name: s.name,
                bedtimeMin: s.bedtimeMin,
                wakeMin: s.wakeMin,
                days: s.days,
                enabled: s.enabled,
                remindMinutesBefore: s.remindMinutesBefore,
                durationMin: ((s.wakeMin - s.bedtimeMin) % 1440 + 1440) % 1440,
            })),
            onboarded: Boolean(plan.onboarded),
            guidance: (plan.guidance || []).map((g) => ({
                key: g.key, label: g.label, directive: g.directive, rationale: g.rationale,
            })),
            bands: BANDS.map((b) => ({ key: b.key, label: b.label, min: b.min, max: b.max })),
        });
    } catch (err) {
        console.error('❌ Sleep overview failed:', err);
        res.status(500).json({ message: 'Could not load your sleep' });
    }
};

/* -------------------------------------------------------------- nights */

/**
 * GET /api/sleep/nights
 *
 * History, search and the filter sheet (frames 9 and 11) in one endpoint, because those
 * three screens differ only by which filters are populated and splitting them would mean
 * three near-identical queries drifting apart. The same call `activityController.listSessions`
 * makes.
 *
 * `stage` filters to nights that actually reported that stage, not to nights where it was
 * the largest — the design's "Sleep Phase" control is about what a source recorded.
 */
exports.listNights = async (req, res) => {
    try {
        const userId = req.user.id;
        const {
            from, to, limit = 50, skip = 0, sort = 'recent',
            minMin, maxMin, minScore, maxScore, stage,
        } = req.query;
        const tzOffset = Number(req.query.tzOffset) || 0;

        const filter = { userId };
        if (from || to) {
            filter.day = {};
            if (from) filter.day.$gte = String(from);
            if (to) filter.day.$lte = String(to);
        }
        if (minMin || maxMin) {
            filter.asleepMin = {};
            if (minMin) filter.asleepMin.$gte = Number(minMin);
            if (maxMin) filter.asleepMin.$lte = Number(maxMin);
        }
        if (minScore || maxScore) {
            filter.score = {};
            if (minScore) filter.score.$gte = Number(minScore);
            if (maxScore) filter.score.$lte = Number(maxScore);
        }
        if (stage && STAGES.includes(String(stage))) {
            filter[`stages.${String(stage)}Min`] = { $ne: null, $gt: 0 };
        }

        const order = {
            recent: { endedAt: -1 },
            oldest: { endedAt: 1 },
            longest: { asleepMin: -1 },
            shortest: { asleepMin: 1 },
            best: { score: -1 },
        }[sort] || { endedAt: -1 };

        const capped = Math.min(Number(limit) || 50, 200);

        const [plan, nights, total] = await Promise.all([
            SleepPlan.findOne({ userId }).select('goalMinutes').lean(),
            SleepSession.find(filter).select('-segments').sort(order)
                .skip(Number(skip) || 0).limit(capped).lean(),
            SleepSession.countDocuments(filter),
        ]);

        res.json({
            nights: nights.map((n) => nightView(n, plan?.goalMinutes, tzOffset)),
            total,
            limit: capped,
            skip: Number(skip) || 0,
        });
    } catch (err) {
        console.error('❌ Listing nights failed:', err);
        res.status(500).json({ message: 'Could not list your sleep history' });
    }
};

/**
 * GET /api/sleep/nights/:id — frame 10, the night in full.
 *
 * The only response that carries `segments`, which is what the hypnogram is drawn from.
 * `explain` is the same arithmetic that produced the score, so the sheet under the number
 * cannot describe a calculation the number did not come from.
 */
exports.getNight = async (req, res) => {
    try {
        const userId = req.user.id;
        const tzOffset = Number(req.query.tzOffset) || 0;

        const [night, plan] = await Promise.all([
            SleepSession.findOne({ _id: req.params.id, userId }).lean(),
            SleepPlan.findOne({ userId }).select('goalMinutes guidance').lean(),
        ]);
        if (!night) return res.status(404).json({ message: 'Night not found' });

        const view = nightView(night, plan?.goalMinutes, tzOffset);
        const breakdown = stageBreakdown([night]);

        res.json({
            night: { ...view, segments: segmentView(night) },
            breakdown: breakdown.stages,
            goalMinutes: plan?.goalMinutes ?? null,
            explanation: explainScore({
                asleepMin: night.asleepMin,
                efficiency: night.efficiency,
                stages: night.stages,
                goalMinutes: plan?.goalMinutes,
            }),
            /**
             * What the score was built from, so the detail screen can show the components
             * rather than a bare number. Weights are the module's own, not restated here.
             */
            weights: WEIGHTS,
        });
    } catch (err) {
        console.error('❌ Reading night failed:', err);
        res.status(500).json({ message: 'Could not load that night' });
    }
};

/**
 * POST /api/sleep/nights — a night typed in by hand.
 *
 * `source: 'manual'` and no `externalId`, which keeps it out of the de-duplication index and
 * safe from being overwritten by a later sync. The same arrangement manual activities have.
 *
 * Stage minutes are accepted but never invented: a person entering "I slept seven hours" gets
 * a night with null stages and a score computed from duration alone, which is what
 * `scoreNight` already does for a watch that reports only a total.
 */
exports.createNight = async (req, res) => {
    try {
        const userId = req.user.id;
        const { startedAt, endedAt, asleepMin, stages, notes, tzOffset, day } = req.body || {};

        if (!startedAt || !endedAt) {
            return res.status(400).json({ message: 'startedAt and endedAt are required' });
        }

        const start = new Date(startedAt);
        const end = new Date(endedAt);
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
            return res.status(400).json({ message: 'startedAt or endedAt is not a valid date' });
        }
        if (end <= start) {
            return res.status(400).json({ message: 'A night has to end after it started' });
        }

        const inBedMin = Math.round((end - start) / 60_000);
        if (inBedMin > 24 * 60) {
            return res.status(400).json({ message: 'That is longer than a day' });
        }

        const asleep = Number.isFinite(asleepMin) ? Math.round(asleepMin) : inBedMin;
        if (asleep <= 0 || asleep > inBedMin) {
            return res.status(400).json({ message: 'Time asleep has to fit inside time in bed' });
        }

        // The wake day, not the day they went to bed. See the note on `SleepSession`.
        const resolvedDay = resolveDay(day, end, tzOffset);

        const plan = await SleepPlan.findOne({ userId }).select('goalMinutes').lean();

        const clean = (v) => (Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
        const stageTotals = {
            deepMin: clean(stages?.deepMin),
            remMin: clean(stages?.remMin),
            lightMin: clean(stages?.lightMin),
            awakeMin: clean(stages?.awakeMin),
        };

        /**
         * Efficiency only when the person actually told us how long they were awake.
         *
         * Deriving it from asleep-over-in-bed for a hand-typed night would report a tidy
         * 100% for everyone who entered one figure, which is the flattery `healthSync`
         * refuses for a source that reports no awake time.
         */
        const efficiency = Number.isFinite(stageTotals.awakeMin) && inBedMin > 0
            ? Math.min(100, Math.round((asleep / inBedMin) * 100))
            : null;

        const night = await SleepSession.create({
            userId,
            startedAt: start,
            endedAt: end,
            day: resolvedDay,
            asleepMin: asleep,
            inBedMin,
            stages: stageTotals,
            efficiency,
            score: scoreNight({
                asleepMin: asleep, efficiency, stages: stageTotals, goalMinutes: plan?.goalMinutes,
            }),
            source: 'manual',
            notes,
        });

        await recomputeDay(userId, resolvedDay);
        console.log(`🌙 Manual night u=${userId} d=${resolvedDay} ${formatMinutes(asleep)}`);

        // Not awaited, and they swallow their own failures: a scoring bug must never be able
        // to fail the write the person actually made.
        scoreController.touch(userId, 'log', { tzOffset: Number(tzOffset) || 0 });
        achievementController.touch(userId);

        res.status(201).json({
            night: nightView(night.toObject(), plan?.goalMinutes, Number(tzOffset) || 0),
        });
    } catch (err) {
        console.error('❌ Creating night failed:', err);
        res.status(500).json({ message: 'Could not save that night' });
    }
};

/**
 * PATCH /api/sleep/nights/:id
 *
 * Notes on any night; the measurements only on one somebody typed. An app that lets a person
 * rewrite what their watch recorded cannot then claim the number came from the watch — the
 * line `activityController.updateSession` holds, answered the same way with a 409 naming
 * what *is* editable.
 */
exports.updateNight = async (req, res) => {
    try {
        const userId = req.user.id;
        const night = await SleepSession.findOne({ _id: req.params.id, userId });
        if (!night) return res.status(404).json({ message: 'Night not found' });

        const { notes, asleepMin, stages } = req.body || {};
        if (notes !== undefined) night.notes = notes;

        const wantsMeasurements = asleepMin !== undefined || stages !== undefined;
        if (wantsMeasurements && night.source !== 'manual') {
            return res.status(409).json({
                message: 'Measured values on a synced night cannot be edited',
                editable: ['notes'],
            });
        }

        if (wantsMeasurements) {
            if (asleepMin !== undefined) {
                const value = Math.round(Number(asleepMin));
                if (!Number.isFinite(value) || value <= 0 || value > (night.inBedMin || 24 * 60)) {
                    return res.status(400).json({ message: 'Time asleep has to fit inside time in bed' });
                }
                night.asleepMin = value;
            }
            if (stages !== undefined) {
                const clean = (v) => (Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
                night.stages = {
                    deepMin: clean(stages?.deepMin),
                    remMin: clean(stages?.remMin),
                    lightMin: clean(stages?.lightMin),
                    awakeMin: clean(stages?.awakeMin),
                };
            }

            const plan = await SleepPlan.findOne({ userId }).select('goalMinutes').lean();
            night.score = scoreNight({
                asleepMin: night.asleepMin,
                efficiency: night.efficiency,
                stages: night.stages,
                goalMinutes: plan?.goalMinutes,
            });
        }

        await night.save();
        if (wantsMeasurements) await recomputeDay(userId, night.day);

        const plan = await SleepPlan.findOne({ userId }).select('goalMinutes').lean();
        res.json({ night: nightView(night.toObject(), plan?.goalMinutes, Number(req.query.tzOffset) || 0) });
    } catch (err) {
        console.error('❌ Updating night failed:', err);
        res.status(500).json({ message: 'Could not update that night' });
    }
};

/**
 * DELETE /api/sleep/nights/:id
 *
 * Deleting a synced night is a local decision: the row comes back on the next sync, because
 * the health store still holds it. Said plainly rather than letting it silently reappear —
 * the same answer `deleteSession` gives.
 */
exports.deleteNight = async (req, res) => {
    try {
        const userId = req.user.id;
        const night = await SleepSession.findOneAndDelete({ _id: req.params.id, userId });
        if (!night) return res.status(404).json({ message: 'Night not found' });

        await recomputeDay(userId, night.day);
        scoreController.touch(userId, 'log');

        res.json({ message: 'Night deleted', willResync: night.source !== 'manual' });
    } catch (err) {
        console.error('❌ Deleting night failed:', err);
        res.status(500).json({ message: 'Could not delete that night' });
    }
};

/* ------------------------------------------------------------- insight */

/**
 * GET /api/sleep/insight?range=&tzOffset= — frames 12 and 13.
 *
 * Every figure comes from `utils/sleepInsight.js`. The comparison window is read as its own
 * range rather than by widening the main query, so a night from before the window cannot
 * leak into the averages it is being compared against — the arrangement
 * `activityController.getSummary` documents.
 */
exports.getInsight = async (req, res) => {
    try {
        const userId = req.user.id;
        const tzOffset = Number(req.query.tzOffset) || 0;
        const range = RANGES[req.query.range] ? req.query.range : '1m';
        const days = dayRange(RANGES[range], tzOffset);
        const previousDays = dayRange(RANGES[range] + 1, tzOffset, days[0]).slice(0, -1);

        const [plan, nights, previousNights] = await Promise.all([
            SleepPlan.findOne({ userId }).select('goalMinutes guidance').lean(),
            SleepSession.find({ userId, day: { $gte: days[0], $lte: days[days.length - 1] } })
                .select('-segments').sort({ endedAt: 1 }).lean(),
            previousDays.length
                ? SleepSession.find({
                    userId,
                    day: { $gte: previousDays[0], $lte: previousDays[previousDays.length - 1] },
                }).select('asleepMin score day').lean()
                : [],
        ]);

        // One row per day, so a split night is not counted as two short ones in every average.
        const byDay = new Map();
        for (const night of nights) {
            const current = byDay.get(night.day);
            if (!current || (night.asleepMin || 0) > (current.asleepMin || 0)) byDay.set(night.day, night);
        }
        const perDay = [...byDay.values()];

        const previousByDay = new Map();
        for (const night of previousNights) {
            const current = previousByDay.get(night.day);
            if (!current || (night.asleepMin || 0) > (current.asleepMin || 0)) previousByDay.set(night.day, night);
        }

        const scores = perDay.map((n) => n.score).filter(Number.isFinite);

        res.json({
            range,
            days,
            nights: perDay.length,
            series: days.map((day) => {
                const night = byDay.get(day);
                return {
                    day,
                    asleepMin: night?.asleepMin ?? null,
                    score: night?.score ?? null,
                    efficiency: night?.efficiency ?? null,
                };
            }),
            score: {
                average: scores.length
                    ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10
                    : null,
                comparison: comparePeriods(perDay, [...previousByDay.values()], 'score'),
                band: scores.length
                    ? (() => {
                        const b = bandFor(Math.round(scores.reduce((a, x) => a + x, 0) / scores.length));
                        return b ? { key: b.key, label: b.label } : null;
                    })()
                    : null,
            },
            duration: {
                average: perDay.length
                    ? (() => {
                        const values = perDay.map((n) => n.asleepMin).filter(Number.isFinite);
                        return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null;
                    })()
                    : null,
                comparison: comparePeriods(perDay, [...previousByDay.values()], 'asleepMin'),
                goalMinutes: plan?.goalMinutes ?? null,
            },
            breakdown: stageBreakdown(perDay),
            ranges: stageRanges(perDay),
            weekday: byWeekday(perDay),
            consistency: consistency(perDay, tzOffset),
            previousNights: previousByDay.size,
            guidance: (plan?.guidance || []).map((g) => ({
                key: g.key, label: g.label, directive: g.directive, focus: g.focus,
            })),
        });
    } catch (err) {
        console.error('❌ Sleep insight failed:', err);
        res.status(500).json({ message: 'Could not load your sleep insight' });
    }
};

/**
 * GET /api/sleep/score?tzOffset= — frame 8, "Your Sleep Score".
 *
 * The bands come from `utils/sleepScore.js` rather than being restated here, so the ladder
 * the screen prints is the ladder the number was graded on. **The bottom band is "Needs
 * attention", not what the kit calls it** — see the note at the top of that module.
 */
exports.getScore = async (req, res) => {
    try {
        const userId = req.user.id;
        const tzOffset = Number(req.query.tzOffset) || 0;
        const days = dayRange(30, tzOffset);

        const [plan, nights] = await Promise.all([
            SleepPlan.findOne({ userId }).select('goalMinutes').lean(),
            SleepSession.find({ userId, day: { $gte: days[0], $lte: days[days.length - 1] } })
                .select('-segments').sort({ endedAt: -1 }).lean(),
        ]);

        const latest = nights[0] || null;
        const scored = nights.map((n) => n.score).filter(Number.isFinite);

        res.json({
            latest: nightView(latest, plan?.goalMinutes, tzOffset),
            explanation: latest
                ? explainScore({
                    asleepMin: latest.asleepMin,
                    efficiency: latest.efficiency,
                    stages: latest.stages,
                    goalMinutes: plan?.goalMinutes,
                })
                : null,
            average30: scored.length
                ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length)
                : null,
            nights: scored.length,
            weights: WEIGHTS,
            bands: BANDS.map((b) => ({ key: b.key, label: b.label, min: b.min, max: b.max })),
        });
    } catch (err) {
        console.error('❌ Sleep score failed:', err);
        res.status(500).json({ message: 'Could not load your sleep score' });
    }
};

/* ----------------------------------------------------------- schedules */

const scheduleFrom = (body = {}) => {
    const time = (v) => {
        const n = Math.round(Number(v));
        return Number.isFinite(n) && n >= 0 && n <= 1439 ? n : null;
    };
    return {
        name: typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 60) : undefined,
        bedtimeMin: time(body.bedtimeMin),
        wakeMin: time(body.wakeMin),
        days: Array.isArray(body.days)
            ? [...new Set(body.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))]
            : undefined,
        enabled: body.enabled === undefined ? undefined : Boolean(body.enabled),
        remindMinutesBefore: Number.isFinite(Number(body.remindMinutesBefore))
            ? Math.max(0, Math.min(180, Math.round(Number(body.remindMinutesBefore))))
            : undefined,
        tzOffset: Number.isFinite(Number(body.tzOffset)) ? Number(body.tzOffset) : undefined,
    };
};

/** GET /api/sleep/schedules — frame 14. */
exports.listSchedules = async (req, res) => {
    try {
        const schedules = await SleepSchedule.find({ userId: req.user.id })
            .sort({ bedtimeMin: 1 }).lean();
        res.json({ schedules });
    } catch (err) {
        console.error('❌ Listing sleep schedules failed:', err);
        res.status(500).json({ message: 'Could not list your sleep schedules' });
    }
};

/** POST /api/sleep/schedules — frames 16 and 17. */
exports.createSchedule = async (req, res) => {
    try {
        const fields = scheduleFrom(req.body);
        if (fields.bedtimeMin === null || fields.wakeMin === null) {
            return res.status(400).json({ message: 'A schedule needs a bedtime and a wake time' });
        }
        if (fields.bedtimeMin === fields.wakeMin) {
            return res.status(400).json({ message: 'Bedtime and wake time cannot be the same' });
        }

        const schedule = await SleepSchedule.create({
            userId: req.user.id,
            ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)),
        });

        console.log(`⏰ Sleep schedule created u=${req.user.id} ${schedule.name}`);
        res.status(201).json({ schedule });
    } catch (err) {
        console.error('❌ Creating sleep schedule failed:', err);
        res.status(500).json({ message: 'Could not save that schedule' });
    }
};

/** PUT /api/sleep/schedules/:id — a partial body, so the list's toggle can send `{enabled}`. */
exports.updateSchedule = async (req, res) => {
    try {
        const schedule = await SleepSchedule.findOne({ _id: req.params.id, userId: req.user.id });
        if (!schedule) return res.status(404).json({ message: 'Schedule not found' });

        const fields = scheduleFrom(req.body);
        for (const [key, value] of Object.entries(fields)) {
            if (value === undefined) continue;
            if ((key === 'bedtimeMin' || key === 'wakeMin') && value === null) {
                return res.status(400).json({ message: `${key} is not a valid time of day` });
            }
            schedule[key] = value;
        }

        // A changed time is a new night's worth of reminders, so the last one stops counting.
        if (fields.bedtimeMin !== undefined || fields.remindMinutesBefore !== undefined) {
            schedule.lastRemindedAt = null;
        }

        await schedule.save();
        res.json({ schedule });
    } catch (err) {
        console.error('❌ Updating sleep schedule failed:', err);
        res.status(500).json({ message: 'Could not update that schedule' });
    }
};

/** DELETE /api/sleep/schedules/:id */
exports.deleteSchedule = async (req, res) => {
    try {
        const schedule = await SleepSchedule.findOneAndDelete({
            _id: req.params.id, userId: req.user.id,
        });
        if (!schedule) return res.status(404).json({ message: 'Schedule not found' });
        res.json({ message: 'Schedule deleted' });
    } catch (err) {
        console.error('❌ Deleting sleep schedule failed:', err);
        res.status(500).json({ message: 'Could not delete that schedule' });
    }
};

exports._rescoreNights = rescoreNights;
exports._syncGuidance = syncGuidance;
exports._dayRange = dayRange;
exports._mainNight = mainNight;
exports._RANGES = RANGES;
