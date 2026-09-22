/**
 * The Miovix Age API.
 *
 * Server-side for the three reasons `scoreController` gives — it reads data the client does
 * not hold, a trend needs snapshots, and two phones must agree — plus a fourth that is
 * specific to this feature: the guards are the feature. Every refusal in
 * `utils/biologicalAge.js` (an acute-phase CRP, an under-age person, a mis-parsed panel) has
 * to be impossible to route around, and a client that computed its own age could simply not
 * implement them.
 *
 * **The mortality score never reaches this file.** `biologicalAge.phenoAge` returns a number
 * of years and nothing else; there is no field here to leak and no code path that could.
 */
const BiologicalAge = require('../models/BiologicalAge');
const ageProfile = require('../utils/ageProfile');
const biologicalAge = require('../utils/biologicalAge');
const lifestyleTable = require('../utils/lifestyleAge');
const { lifestyleAge } = lifestyleTable;
const { forecast } = require('../utils/predictionForecast');

/**
 * How fresh a snapshot has to be before a read reuses it rather than recomputing.
 *
 * Six hours. The inputs are a six-month window and a blood panel; nothing a person does
 * between breakfast and lunch moves either. Opening the app four times in a day is four
 * cheap reads.
 */
const FRESH_MS = 6 * 60 * 60 * 1000;

/**
 * The minimum gap between two persisted snapshots.
 *
 * A day, where the score uses six hours. A denser series would not be a more detailed trend,
 * it would be the same trend drawn with more points — and the pace regression reads this
 * collection, so over-sampling a flat period would make the fit look more confident than the
 * evidence is. Inside the gap the newest row is updated in place rather than appended.
 */
const MIN_SNAPSHOT_GAP_MS = 24 * 60 * 60 * 1000;

/**
 * Assemble both halves and blend them.
 *
 * Exported because the interpretation engine will want the age without going through HTTP,
 * and because a second implementation of "what feeds the age" is how the number on one
 * screen starts disagreeing with the number on another.
 */
const recompute = async (userId, { trigger = 'read', windowDays, tzOffset = 0 } = {}) => {
    const profile = await ageProfile.gather(userId, { windowDays, tzOffset });
    const { chronologicalAge, sex } = profile;

    const lab = biologicalAge.labAge({
        chronologicalAge,
        sex,
        measurements: profile.biomarkers,
    });

    const lifestyle = lifestyleAge({
        chronologicalAge, sex, inputs: profile.inputs, windowDays: profile.windowDays,
    });

    const result = biologicalAge.blend({ lab, lifestyle, chronologicalAge });

    await persist(userId, result, { trigger, windowDays: profile.windowDays });

    // The raw inputs travel back with the result but are stripped before it reaches a
    // response: the lever counterfactuals need to re-run both halves, and a second gather to
    // get them would read six months across five collections all over again.
    return Object.defineProperty(result, '_profile', {
        value: profile, enumerable: false, writable: false,
    });
};

/**
 * The panel `labAge` actually used, rebuilt for the lever counterfactuals.
 *
 * Re-derived from the same rows rather than returned by `labAge`, because a half that
 * refused has no panel and the caller must not be handed a half-populated one that looks
 * usable.
 */
const panelFor = (lab) => {
    if (!lab?.ok || !Array.isArray(lab.contributions)) return null;
    return Object.fromEntries(lab.contributions.map((c) => [c.key, c.value]));
};

/**
 * Pace of aging.
 *
 * Measured from the snapshot series where there is enough of one, and falling back to the
 * thirty-day comparison where there is not. The two answer different questions and carry
 * different `state` values so a screen cannot present them as the same claim.
 *
 * **Never 1.0x as a stand-in.** A pace of "1.0x — aging normally" shown to somebody about
 * whom nothing is known reads as a reassurance, which makes it worse than the usual
 * null-for-zero failure rather than merely an instance of it.
 */
const paceFor = async (userId, { tzOffset = 0, profile = null } = {}) => {
    // `halves` is selected because `paceFrom` prefers the behavioural delta: the blended one
    // steps on the day a blood panel lands, and a step is not a rate. See `paceFrom`.
    const snapshots = await BiologicalAge.find({ userId })
        .select('delta halves computedAt').sort({ computedAt: 1 }).lean();

    const measured = biologicalAge.paceFrom(snapshots, { forecast });
    if (measured.ok) return measured;

    // The fallback needs a second, shorter gather. Only reached before the snapshot series
    // is long enough, so it is not on the steady-state path.
    const base = profile ?? await ageProfile.gather(userId, { tzOffset });
    if (!Number.isFinite(base.chronologicalAge)) return measured;

    const recentProfile = await ageProfile.gather(userId, { windowDays: 30, tzOffset });

    const provisional = biologicalAge.provisionalPace({
        recent: lifestyleAge({
            chronologicalAge: recentProfile.chronologicalAge,
            sex: recentProfile.sex,
            inputs: recentProfile.inputs,
            windowDays: recentProfile.windowDays,
        }),
        window: lifestyleAge({
            chronologicalAge: base.chronologicalAge,
            sex: base.sex,
            inputs: base.inputs,
            windowDays: base.windowDays,
        }),
    });

    // A provisional pace that cannot be computed falls back to the measured refusal, which
    // says how much more history is needed — the more useful of the two messages.
    return provisional.ok ? { ...provisional, windows: { recent: 30, window: base.windowDays } }
        : measured;
};

/** Both halves, in the shape the snapshot stores them, refusals included. */
const halvesOf = (result) => [result.lab, result.lifestyle]
    .filter(Boolean)
    .map((half) => ({
        source: half.source ?? (half === result.lab ? 'lab' : 'lifestyle'),
        ok: Boolean(half.ok),
        value: half.ok ? half.value : null,
        delta: half.ok ? half.delta : null,
        reason: half.ok ? null : half.reason,
        method: half.method ?? null,
        clamped: Boolean(half.clamped),
        measuredAt: half.measuredAt ?? null,
        contributions: half.contributions,
        meta: half.ok ? { coverage: half.coverage, freshness: half.freshness } : undefined,
    }));

/**
 * Write the snapshot, or fold it into the newest one.
 *
 * A refusal is never persisted. "We cannot say yet" is a state, not a data point, and a pace
 * regression that read one would be fitting a line through an absence.
 */
const persist = async (userId, result, { trigger, windowDays }) => {
    if (!result.ok) return null;

    const doc = {
        value: result.value,
        chronologicalAge: result.chronologicalAge,
        delta: result.delta,
        band: result.band,
        source: result.source,
        halves: halvesOf(result),
        weights: result.weights,
        windowDays,
        computedAt: new Date(),
        trigger,
    };

    const newest = await BiologicalAge.findOne({ userId }).sort({ computedAt: -1 });
    if (newest && Date.now() - new Date(newest.computedAt).getTime() < MIN_SNAPSHOT_GAP_MS) {
        Object.assign(newest, doc);
        return newest.save();
    }
    return BiologicalAge.create({ userId, ...doc });
};

/**
 * Recompute in the background, swallowing failures.
 *
 * The contract `scoreController.touch` has, with one difference that matters: this is **not**
 * called from every write path. It reads six months across five collections and produces a
 * figure that cannot move between two app opens, so the only things that call it are a
 * confirmed blood report — which genuinely can move it by years in one step — and an explicit
 * recompute. Everything else waits for the next read.
 */
const touch = (userId, opts = {}) => {
    recompute(userId, opts).catch((err) => {
        console.log('🕰️ age touch failed', err?.message);
    });
};

const getAge = async (req, res) => {
    try {
        const userId = req.auth.userId;
        const tzOffset = Number(req.query.tzOffset) || 0;

        const newest = await BiologicalAge.findOne({ userId }).sort({ computedAt: -1 }).lean();
        const fresh = newest && Date.now() - new Date(newest.computedAt).getTime() < FRESH_MS;

        const result = fresh && req.query.refresh !== 'true'
            ? fromSnapshot(newest)
            : await recompute(userId, { trigger: 'read', tzOffset });

        const [change, pace] = await Promise.all([
            changeSince(userId, result),
            paceFor(userId, { tzOffset, profile: result._profile ?? null }),
        ]);

        res.json({ ...result, change, pace });
    } catch (err) {
        console.log('❌ getAge failed', err.message);
        res.status(500).json({ message: 'Could not work out your Miovix Age' });
    }
};

/**
 * Rehydrate a stored snapshot into the response shape.
 *
 * Deliberately not the full recompute output: a stored row holds what was true when it was
 * written, and reconstructing the live refusal messages onto it would put today's wording on
 * yesterday's facts.
 */
const fromSnapshot = (row) => {
    /**
     * Derived from the stored delta when the row carries no band.
     *
     * `BiologicalAge` is append-only, so rows written before a field existed are never
     * rewritten — the reason `Interpretation.plain_summary` is optional on the client. A band
     * is a pure function of a delta, so recovering it costs nothing and is strictly better
     * than rendering a blank where a label belongs.
     */
    const band = row.band ?? biologicalAge.bandFor(row.delta)?.key ?? null;

    return {
        ok: true,
        value: row.value,
        chronologicalAge: row.chronologicalAge,
        delta: row.delta,
        band,
        bandLabel: biologicalAge.DELTA_BANDS.find((b) => b.key === band)?.label ?? null,
        source: row.source,
        lab: (row.halves || []).find((h) => h.source === 'lab') ?? null,
        lifestyle: (row.halves || []).find((h) => h.source === 'lifestyle') ?? null,
        weights: row.weights,
        computedAt: row.computedAt,
        cached: true,
        disclaimer: biologicalAge.disclaimerFor(row.source),
    };
};

/**
 * How the number has moved since the last snapshot that is not this one.
 *
 * Null, never zero, when there is nothing to compare against — the distinction
 * `HealthScore.change` already makes, and it matters more here: a delta of "0.0 years" on
 * somebody's first ever reading reads as "you have not aged", which is a claim about a period
 * nothing was measured over.
 */
const changeSince = async (userId, current) => {
    if (!current.ok) return null;
    const rows = await BiologicalAge.find({ userId }).sort({ computedAt: -1 }).limit(2)
        .select('value delta computedAt').lean();
    const previous = rows[1];
    if (!previous) return null;
    return {
        delta: Number((current.value - previous.value).toFixed(1)),
        deltaGap: Number((current.delta - previous.delta).toFixed(1)),
        since: previous.computedAt,
    };
};

/** The snapshot series, which is what a trend chart and the pace regression both read. */
const getTrend = async (req, res) => {
    try {
        const days = Math.min(Number(req.query.days) || 365, 1825);
        const rows = await BiologicalAge.find({
            userId: req.auth.userId,
            computedAt: { $gte: new Date(Date.now() - days * 86400000) },
        }).select('value chronologicalAge delta band source computedAt')
            .sort({ computedAt: 1 }).lean();

        res.json({ days, points: rows, disclaimer: biologicalAge.AGE_DISCLAIMER });
    } catch (err) {
        console.log('❌ getTrend failed', err.message);
        res.status(500).json({ message: 'Could not load your Miovix Age history' });
    }
};

/**
 * What would move the number, ranked.
 *
 * Its own route rather than a field on `GET /`, because it re-runs both halves once per
 * contributor. That is cheap arithmetic on data already in memory, but it is work nobody
 * asked for on a screen that only wants to print an age — the same split
 * `/predictions/overview` makes against running a forecast.
 */
const getLevers = async (req, res) => {
    try {
        const userId = req.auth.userId;
        const tzOffset = Number(req.query.tzOffset) || 0;
        const result = await recompute(userId, { trigger: 'read', tzOffset });

        if (!result.ok) {
            return res.status(422).json({
                ok: false,
                reason: result.reason,
                message: result.message,
                levers: [],
            });
        }

        const profile = result._profile;
        return res.json({
            ok: true,
            value: result.value,
            delta: result.delta,
            source: result.source,
            levers: biologicalAge.levers({
                chronologicalAge: result.chronologicalAge,
                sex: profile.sex,
                markers: panelFor(result.lab),
                inputs: profile.inputs,
                lab: result.lab,
                lifestyle: result.lifestyle,
                weights: result.weights,
                lifestyleFn: lifestyleTable,
            }),
            disclaimer: biologicalAge.disclaimerFor(result.source),
        });
    } catch (err) {
        console.log('❌ getLevers failed', err.message);
        return res.status(500).json({ message: 'Could not work out what would move your Miovix Age' });
    }
};

const recomputeAge = async (req, res) => {
    try {
        const result = await recompute(req.auth.userId, {
            trigger: 'manual',
            tzOffset: Number(req.body?.tzOffset) || 0,
        });
        res.json(result);
    } catch (err) {
        console.log('❌ recomputeAge failed', err.message);
        res.status(500).json({ message: 'Could not work out your Miovix Age' });
    }
};

module.exports = {
    getAge,
    getTrend,
    getLevers,
    paceFor,
    recomputeAge,
    recompute,
    touch,
    FRESH_MS,
    MIN_SNAPSHOT_GAP_MS,
    _persist: persist,
    _halvesOf: halvesOf,
    _fromSnapshot: fromSnapshot,
};
