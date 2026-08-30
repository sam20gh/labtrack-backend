/**
 * The LabTrack score API.
 *
 * The score used to be computed in `lib/healthScore.ts` on the phone. It moved here for
 * three reasons, in order of how much they matter:
 *
 *   1. **It has to read data the client does not hold.** Activity, sleep, heart, meals and
 *      doses are thirty days of rows across five collections. Shipping all of that to the
 *      phone on every app open, to average it, would be a slow way to arrive at a number the
 *      server could have produced in one round trip.
 *   2. **A trend needs snapshots.** The design draws a score chart and a delta chip. Nothing
 *      was ever written down, so there was no history to draw.
 *   3. **Two phones must agree.** The same argument `activityScore.js` makes at the top of
 *      the file: a score computed on the client means a person's own number differs between
 *      their devices.
 */
const HealthScore = require('../models/HealthScore');
const PlanItem = require('../models/PlanItem');
const User = require('../models/userModel');
const observedProfile = require('../utils/observedProfile');
const { computeScore, diffScores, SCORE_DISCLAIMER, BANDS } = require('../utils/labtrackScore');
const biomarkerController = require('./biomarkerController');

/**
 * How fresh a snapshot has to be before a read reuses it rather than recomputing.
 *
 * Fifteen minutes. Short enough that "Last updated: 3s ago" is honest after someone logs
 * something — every write path calls `recompute()` directly — and long enough that opening
 * the app four times in an hour is four cheap reads rather than four full recomputations.
 */
const FRESH_MS = 15 * 60 * 1000;

/**
 * The minimum gap between two persisted snapshots.
 *
 * Recomputation is cheap; a row per app foreground is not, and it would also make the trend
 * chart a dense band of near-identical points rather than a line. Inside the gap the score is
 * recomputed and returned but the newest snapshot is updated in place instead of appended.
 */
const MIN_SNAPSHOT_GAP_MS = 6 * 60 * 60 * 1000;

/**
 * Assemble every input and score it.
 *
 * Exported because the interpretation engine and the plan generator both want the score
 * without going through HTTP, and because a second implementation of "what feeds the score"
 * is how the number on one screen starts disagreeing with the number on another.
 */
const recompute = async (userId, { trigger = 'read', windowDays, tzOffset = 0 } = {}) => {
    const gathered = await observedProfile.gather(userId, { windowDays, tzOffset });

    const [user, planItems, biomarkers] = await Promise.all([
        User.findById(userId).select('height weight observed healthAssessment').lean(),
        PlanItem.find({ userId }).select('status dueDate').lean(),
        biomarkerController.latestForUser(userId),
    ]);

    // Observed weight wins; the onboarding figure is the fallback and is labelled as one.
    const body = user?.observed?.weightKg
        ? {
            heightCm: user.height,
            weightKg: user.observed.weightKg,
            weightSource: 'observed',
            weightAt: user.observed.weightAt,
        }
        : {
            heightCm: user?.height,
            weightKg: user?.weight,
            weightSource: 'reported',
            weightAt: user?.healthAssessment?.completedAt || null,
        };

    const score = computeScore({
        ...gathered,
        biomarkers,
        planItems,
        body,
        assessment: user?.healthAssessment,
        moodHistory: user?.healthAssessment?.moodHistory || [],
    });

    await persist(userId, score, trigger);

    // Keeping the derived profile in step with the score it fed is what stops the
    // interpretation engine reading a fitness level the score has already moved past.
    await observedProfile.refresh(userId, { windowDays, tzOffset, gathered });

    return score;
};

/**
 * Write the snapshot, or fold it into the newest one.
 *
 * A null score is never persisted: "not enough data yet" is a state, not a data point, and
 * a trend chart that plots it draws a line to the floor on the day someone joined.
 */
const persist = async (userId, score, trigger) => {
    if (score.value === null) return null;

    const newest = await HealthScore.findOne({ userId }).sort({ computedAt: -1 });
    const doc = {
        value: score.value,
        band: score.band,
        headline: score.headline,
        pillars: score.pillars.map((p) => ({
            key: p.key, label: p.label, value: p.value, band: p.band,
            detail: p.detail, source: p.source,
            meta: stripPillarMeta(p),
        })),
        coverage: score.coverage,
        windowDays: score.windowDays,
        computedAt: score.computedAt,
        trigger,
    };

    if (newest && Date.now() - new Date(newest.computedAt).getTime() < MIN_SNAPSHOT_GAP_MS) {
        Object.assign(newest, doc);
        return newest.save();
    }
    return HealthScore.create({ userId, ...doc });
};

/** Everything on a pillar that is not one of the persisted top-level fields. */
const stripPillarMeta = ({ key, label, value, band, detail, source, ...meta }) =>
    Object.keys(meta).length ? meta : undefined;

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

/**
 * `GET /api/score`
 *
 * The current score, its pillars, and how it moved. Reuses a snapshot younger than
 * `FRESH_MS` unless `?refresh=1`, so the common case is one indexed read.
 */
exports.getScore = async (req, res) => {
    try {
        const userId = req.auth.userId;
        const tzOffset = Number(req.query.tzOffset) || 0;
        const windowDays = Number(req.query.windowDays) || undefined;

        const newest = await HealthScore.findOne({ userId }).sort({ computedAt: -1 }).lean();
        const stale = !newest || Date.now() - new Date(newest.computedAt).getTime() > FRESH_MS;

        const score = (stale || req.query.refresh === '1')
            ? await recompute(userId, { trigger: 'read', windowDays, tzOffset })
            : fromSnapshot(newest);

        // The comparison point is the newest snapshot from before this window, so the delta
        // chip reads "since last week" rather than "since you opened the app".
        const previous = await HealthScore.findOne({
            userId,
            computedAt: { $lt: new Date(Date.now() - MIN_SNAPSHOT_GAP_MS) },
        }).sort({ computedAt: -1 }).lean();

        console.log(`📊 Score for ${userId}: ${score.value ?? 'n/a'} (${score.coverage.observed} observed pillars)`);

        res.json({
            ...score,
            change: previous ? diffScores(score, fromSnapshot(previous)) : null,
            disclaimer: SCORE_DISCLAIMER,
            bands: BANDS,
        });
    } catch (err) {
        console.error('❌ getScore failed:', err);
        res.status(500).json({ message: 'Could not calculate your score', error: err.message });
    }
};

/** A stored snapshot, in the shape `computeScore` returns. */
const fromSnapshot = (row) => ({
    value: row.value,
    band: row.band,
    bandLabel: BANDS.find((b) => b.key === row.band)?.label ?? null,
    headline: row.headline,
    pillars: row.pillars.map((p) => ({ ...p, ...(p.meta || {}), meta: undefined })),
    coverage: row.coverage,
    windowDays: row.windowDays,
    computedAt: row.computedAt,
});

/**
 * `POST /api/score/recompute`
 *
 * Forces a fresh calculation. Called by the client after a sync completes, and available on
 * the breakdown screen's pull-to-refresh.
 */
exports.recomputeScore = async (req, res) => {
    try {
        const score = await recompute(req.auth.userId, {
            trigger: req.body?.trigger === 'sync' ? 'sync' : 'manual',
            tzOffset: Number(req.body?.tzOffset) || 0,
        });
        res.json({ ...score, disclaimer: SCORE_DISCLAIMER, bands: BANDS });
    } catch (err) {
        console.error('❌ recomputeScore failed:', err);
        res.status(500).json({ message: 'Could not recalculate your score', error: err.message });
    }
};

/**
 * `GET /api/score/trend?range=1w|1m|1y|all`
 *
 * The series behind the design's Health Score Trend chart. Returns snapshots, not a
 * resampled daily series: a gap in the line is a period the person was not using the app,
 * and interpolating across it would draw a score for days nobody measured.
 */
const RANGE_DAYS = { '1w': 7, '1m': 30, '1y': 365, all: null };

exports.getTrend = async (req, res) => {
    try {
        const days = RANGE_DAYS[req.query.range] ?? 30;
        const filter = { userId: req.auth.userId };
        if (days) filter.computedAt = { $gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) };

        const rows = await HealthScore.find(filter)
            .sort({ computedAt: 1 })
            .select('value band computedAt pillars.key pillars.value trigger')
            .lean();

        const points = rows.map((r) => ({
            at: r.computedAt,
            value: r.value,
            band: r.band,
            trigger: r.trigger,
            pillars: Object.fromEntries(r.pillars.map((p) => [p.key, p.value])),
        }));

        const values = points.map((p) => p.value).filter(Number.isFinite);

        res.json({
            range: req.query.range || '1m',
            points,
            // Percent change across the window, which is what the design's chip shows.
            change: values.length > 1 && values[0] > 0
                ? Math.round(((values[values.length - 1] - values[0]) / values[0]) * 1000) / 10
                : null,
            best: values.length ? Math.max(...values) : null,
            mean: values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null,
        });
    } catch (err) {
        console.error('❌ getTrend failed:', err);
        res.status(500).json({ message: 'Could not load your score history', error: err.message });
    }
};

exports.recompute = recompute;
exports._persist = persist;
exports.FRESH_MS = FRESH_MS;
exports.MIN_SNAPSHOT_GAP_MS = MIN_SNAPSHOT_GAP_MS;

/**
 * Recompute in the background after something was logged.
 *
 * Every write path that changes an input calls this — a device sync, a logged meal, a
 * recorded dose, a finished session. It is deliberately **not awaited** by its callers and
 * swallows its own failures: a person who has just logged a meal must get their 201 whether
 * or not the score recalculated, and a scoring bug must never be able to fail a write.
 *
 * The next read then finds a fresh snapshot instead of recomputing inline, which is what
 * makes the design's "Last updated: 3s ago" true rather than decorative.
 */
const touch = (userId, trigger = 'log', { tzOffset = 0 } = {}) => {
    setImmediate(async () => {
        try {
            await recompute(userId, { trigger, tzOffset });
        } catch (err) {
            console.error(`⚠️ Background score recompute failed for ${userId}:`, err.message);
        }
    });
};

exports.touch = touch;
