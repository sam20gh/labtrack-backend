/**
 * Health metrics: weight, hydration, blood pressure.
 *
 * The three things in the design's metric list that no device currently reports into LabTrack,
 * so **entry is by hand and that is the source of truth for now**. When `healthSync` learns to
 * read body mass and blood pressure from HealthKit and Health Connect, those rows land in the
 * same `MetricLog` collection with a `source` and an `externalId`, the rollup does not change,
 * and a manually logged weight simply stops being the newest one.
 *
 * Two rules carried over from the trackers that came before:
 *
 * - **A reading is written once and is never silently reinterpreted.** A blood-pressure entry
 *   stores the category it was classified as at the time. See the note on `MetricLog.category`.
 * - **Deleting means deleting.** The history screens offer a swipe-to-delete on a mistyped
 *   reading, and it removes the row and rebuilds the day, rather than adjusting a total.
 */
const MetricLog = require('../models/MetricLog');
const DailyMetrics = require('../models/DailyMetrics');
const User = require('../models/userModel');
const bp = require('../utils/bloodPressure');
const hydration = require('../utils/hydrationTargets');
const { recomputeMetricDay } = require('../utils/metricRollup');
const scoreController = require('./scoreController');

const DAY_MS = 24 * 60 * 60 * 1000;

/** Local `YYYY-MM-DD` for an instant, given the client's `getTimezoneOffset()`. */
const localDay = (date, tzOffsetMinutes = 0) =>
    new Date(new Date(date).getTime() - tzOffsetMinutes * 60_000).toISOString().slice(0, 10);

const isDayString = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/**
 * The calendar day a row belongs to.
 *
 * The client knows its own calendar and may send `day` outright; `tzOffset` is the fallback.
 * Defaulting to UTC files an evening reading in the Americas under the following day — the
 * rule every tracker in this codebase follows, and the one screen each is built around.
 */
const resolveDay = (day, instant, tzOffset) =>
    (isDayString(day) ? day : localDay(instant, Number(tzOffset) || 0));

const dayRange = (days, tzOffset = 0) => {
    const out = [];
    for (let i = days - 1; i >= 0; i--) out.push(localDay(Date.now() - i * DAY_MS, tzOffset));
    return out;
};

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

/**
 * `POST /api/metrics/weight`  `{ weightKg, bodyFatPct?, measuredAt?, day?, tzOffset?, note? }`
 *
 * **This is where a weight comes from until a health store is wired.** `User.weight` is the
 * onboarding answer and stays exactly where it is — the score reads a logged weight as
 * `observed` and falls back to that figure as `reported`, which is the whole provenance rule
 * in `labtrackScore.js` applied to one field.
 */
exports.logWeight = async (req, res) => {
    try {
        const userId = req.auth.userId;
        const weightKg = Number(req.body?.weightKg);

        // Wide enough for any real person, narrow enough to catch a pounds-for-kilos slip
        // or a stray digit before it lands in the record and drags the BMI pillar with it.
        if (!Number.isFinite(weightKg) || weightKg < 20 || weightKg > 500) {
            return res.status(400).json({ message: 'Enter a weight between 20 and 500 kg' });
        }

        const bodyFatPct = Number(req.body?.bodyFatPct);
        const measuredAt = req.body?.measuredAt ? new Date(req.body.measuredAt) : new Date();
        if (Number.isNaN(measuredAt.getTime())) {
            return res.status(400).json({ message: 'That date could not be read' });
        }
        const day = resolveDay(req.body?.day, measuredAt, req.body?.tzOffset);

        const log = await MetricLog.create({
            userId,
            kind: 'weight',
            day,
            measuredAt,
            weightKg: Math.round(weightKg * 10) / 10,
            bodyFatPct: Number.isFinite(bodyFatPct) ? bodyFatPct : null,
            source: 'manual',
            note: req.body?.note || null,
        });

        await recomputeMetricDay(userId, day);
        console.log(`⚖️  Weight ${log.weightKg}kg u=${userId} d=${day}`);

        // The body pillar reads the newest measured weight, so this moves the score.
        scoreController.touch(userId, 'log', { tzOffset: Number(req.body?.tzOffset) || 0 });

        res.status(201).json({ log, ...(await weightContext(userId, log)) });
    } catch (err) {
        console.error('❌ Logging weight failed:', err);
        res.status(500).json({ message: 'Could not save that weight' });
    }
};

/**
 * What to say back after a weigh-in.
 *
 * The change since the previous entry, and the BMI the new weight produces. Returned from the
 * write so the confirmation screen does not have to make a second round trip to tell someone
 * what just happened.
 */
const weightContext = async (userId, log) => {
    const [previous, user] = await Promise.all([
        MetricLog.findOne({
            userId, kind: 'weight', _id: { $ne: log._id }, measuredAt: { $lte: log.measuredAt },
        }).sort({ measuredAt: -1 }).lean(),
        User.findById(userId).select('height').lean(),
    ]);

    const bmi = user?.height ? log.weightKg / (user.height / 100) ** 2 : null;
    return {
        changeKg: previous ? Math.round((log.weightKg - previous.weightKg) * 10) / 10 : null,
        since: previous?.measuredAt ?? null,
        bmi: bmi ? Math.round(bmi * 10) / 10 : null,
    };
};

/**
 * `POST /api/metrics/water`  `{ ml | container, drinkType?, measuredAt?, day?, tzOffset? }`
 */
exports.logWater = async (req, res) => {
    try {
        const userId = req.auth.userId;

        // A container preset or an explicit amount. The design's log screen offers both.
        const preset = hydration.CONTAINERS.find((c) => c.key === req.body?.container);
        const ml = Number(req.body?.ml ?? preset?.ml);

        const [min, max] = hydration.LOG_LIMITS.ml;
        if (!Number.isFinite(ml) || ml < min || ml > max) {
            return res.status(400).json({ message: `Enter an amount between ${min} and ${max} ml` });
        }

        const drinkType = hydration.DRINK_TYPES.find((d) => d.key === req.body?.drinkType)?.key || 'water';
        const measuredAt = req.body?.measuredAt ? new Date(req.body.measuredAt) : new Date();
        if (Number.isNaN(measuredAt.getTime())) {
            return res.status(400).json({ message: 'That time could not be read' });
        }
        const day = resolveDay(req.body?.day, measuredAt, req.body?.tzOffset);

        const log = await MetricLog.create({
            userId, kind: 'water', day, measuredAt,
            ml: Math.round(ml), drinkType, container: preset?.key || null, source: 'manual',
        });

        const rollup = await recomputeMetricDay(userId, day);
        scoreController.touch(userId, 'log', { tzOffset: Number(req.body?.tzOffset) || 0 });

        res.status(201).json({
            log,
            day: hydrationDay(rollup),
        });
    } catch (err) {
        console.error('❌ Logging water failed:', err);
        res.status(500).json({ message: 'Could not save that drink' });
    }
};

/**
 * `POST /api/metrics/blood-pressure`  `{ systolic, diastolic, pulse?, measuredAt?, day?, note? }`
 *
 * The reading is classified on the way in and the category is stored with it. A reading the
 * table refuses — a transposed pair, a stray digit — is a 400 rather than a row: a
 * blood-pressure record is read by clinicians, and a nonsense entry in it is worse than a
 * rejected one.
 */
exports.logBloodPressure = async (req, res) => {
    try {
        const userId = req.auth.userId;
        const systolic = Number(req.body?.systolic);
        const diastolic = Number(req.body?.diastolic);

        const category = bp.classify(systolic, diastolic);
        if (!category) {
            return res.status(400).json({
                message: 'That reading could not be read. Systolic is the higher number, '
                    + `and readings must fall between ${bp.LIMITS.systolic.join('–')} over `
                    + `${bp.LIMITS.diastolic.join('–')} mmHg.`,
            });
        }

        const pulse = Number(req.body?.pulse);
        const measuredAt = req.body?.measuredAt ? new Date(req.body.measuredAt) : new Date();
        if (Number.isNaN(measuredAt.getTime())) {
            return res.status(400).json({ message: 'That time could not be read' });
        }
        const day = resolveDay(req.body?.day, measuredAt, req.body?.tzOffset);

        const log = await MetricLog.create({
            userId, kind: 'blood_pressure', day, measuredAt,
            systolic: Math.round(systolic),
            diastolic: Math.round(diastolic),
            pulse: Number.isFinite(pulse) && pulse >= 25 && pulse <= 250 ? Math.round(pulse) : null,
            category: category.key,
            source: 'manual',
            note: req.body?.note || null,
        });

        await recomputeMetricDay(userId, day);
        scoreController.touch(userId, 'log', { tzOffset: Number(req.body?.tzOffset) || 0 });

        console.log(`🩺 BP ${log.systolic}/${log.diastolic} (${category.key}) u=${userId}`);

        res.status(201).json({
            log,
            category,
            /*
             * A crisis reading returns its escalation text with the write, so the screen that
             * shows the result cannot render it as one more coloured chip. This is the one
             * value in the whole metrics feature that needs an action rather than a trend.
             */
            urgentNote: category.isCrisis ? bp.CRISIS_NOTE : null,
            note: bp.SAFETY_NOTE,
        });
    } catch (err) {
        console.error('❌ Logging blood pressure failed:', err);
        res.status(500).json({ message: 'Could not save that reading' });
    }
};

/**
 * `DELETE /api/metrics/logs/:id`
 *
 * Removes the row and rebuilds the day. A real delete, not a flag: the history list is what
 * the person is looking at, and an entry that stays visible after they swiped it away is a
 * bug they will report as data loss going the other way.
 */
exports.deleteLog = async (req, res) => {
    try {
        const userId = req.auth.userId;
        const log = await MetricLog.findOneAndDelete({ _id: req.params.id, userId });
        if (!log) return res.status(404).json({ message: 'That entry no longer exists' });

        await recomputeMetricDay(userId, log.day);
        scoreController.touch(userId, 'log');

        res.json({ message: 'Entry removed', day: log.day });
    } catch (err) {
        console.error('❌ Deleting metric log failed:', err);
        res.status(500).json({ message: 'Could not remove that entry' });
    }
};

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

const hydrationDay = (rollup) => {
    const h = rollup?.hydration;
    const level = h?.logs
        ? hydration.levelFor(h.consumedMl ?? 0, h.targetMl, { logs: h.logs })
        : null;
    return {
        consumedMl: h?.consumedMl ?? null,
        targetMl: h?.targetMl ?? null,
        logs: h?.logs ?? 0,
        level,
        remainingMl: h?.targetMl ? Math.max(0, h.targetMl - (h.consumedMl ?? 0)) : null,
    };
};

/**
 * `GET /api/metrics/overview?days=7`
 *
 * Everything the design's **Health Metrics** list needs in one call: for each metric, today's
 * value, a one-line status, and a short series for the sparkline.
 *
 * One endpoint rather than seven because that screen renders them together. Seven round trips
 * to draw one list is how a screen ends up with seven independent spinners and a layout that
 * reflows six times.
 *
 * A metric with nothing recorded is **returned with a null value**, not omitted. The list is
 * also how someone discovers a metric exists, and a card that appears only once you have
 * already used it cannot be the thing that prompts you to.
 */
exports.getOverview = async (req, res) => {
    try {
        const userId = req.auth.userId;
        const tzOffset = Number(req.query.tzOffset) || 0;
        const days = Math.min(90, Math.max(7, Number(req.query.days) || 7));
        const range = dayRange(days, tzOffset);

        const [rows, user] = await Promise.all([
            DailyMetrics.find({ userId, day: { $gte: range[0] } }).sort({ day: 1 }).lean(),
            User.findById(userId).select('height weight observed').lean(),
        ]);

        const byDay = new Map(rows.map((r) => [r.day, r]));
        const series = (pick) => range.map((day) => ({ day, value: pick(byDay.get(day)) ?? null }));
        const newest = (pick) => {
            for (let i = range.length - 1; i >= 0; i--) {
                const v = pick(byDay.get(range[i]));
                if (v !== null && v !== undefined) return { value: v, day: range[i] };
            }
            return { value: null, day: null };
        };

        const today = byDay.get(range[range.length - 1]);

        res.json({
            days,
            metrics: [
                weightCard(newest, series, user),
                bloodPressureCard(newest, series, byDay, range),
                heartRateCard(newest, series),
                sleepCard(newest, series),
                hydrationCard(today, series),
                activityCard(newest, series),
            ],
        });
    } catch (err) {
        console.error('❌ getOverview failed:', err);
        res.status(500).json({ message: 'Could not load your metrics' });
    }
};

const weightCard = (newest, series, user) => {
    const latest = newest((r) => r?.body?.weightKg);
    const height = user?.height;
    const bmi = latest.value && height ? latest.value / (height / 100) ** 2 : null;

    return {
        key: 'weight',
        label: 'Weight',
        unit: 'kg',
        value: latest.value,
        at: latest.day,
        // The onboarding figure is shown as a fallback and labelled, never as a measurement.
        fallback: latest.value === null && user?.weight ? { value: user.weight, source: 'reported' } : null,
        status: latest.value === null
            ? 'Not logged yet'
            : bmi ? `BMI ${bmi.toFixed(1)} — ${bmiLabel(bmi)}` : 'Logged',
        series: series((r) => r?.body?.weightKg),
        loggable: true,
    };
};

const bmiLabel = (bmi) =>
    bmi < 18.5 ? 'underweight' : bmi < 25 ? 'within optimal range' : bmi < 30 ? 'overweight' : 'obese';

const bloodPressureCard = (newest, series, byDay, range) => {
    const latest = newest((r) => (r?.bloodPressure?.readings ? r.bloodPressure : null));
    const value = latest.value;
    const category = value?.category ? bp.CATEGORIES.find((c) => c.key === value.category) : null;

    // A crisis anywhere in the window is surfaced on the card itself. A person does not have
    // to have opened the blood-pressure screen for that to be worth telling them.
    const hadCrisis = range.some((d) => byDay.get(d)?.bloodPressure?.worstCategory === 'crisis');

    return {
        key: 'blood_pressure',
        label: 'Blood Pressure',
        unit: 'mmHg',
        value: value ? `${value.systolic}/${value.diastolic}` : null,
        at: latest.day,
        status: category ? category.label : 'Not logged yet',
        statusColour: category?.colour ?? null,
        urgent: hadCrisis,
        series: series((r) => r?.bloodPressure?.systolic),
        secondarySeries: series((r) => r?.bloodPressure?.diastolic),
        loggable: true,
    };
};

const heartRateCard = (newest, series) => {
    const latest = newest((r) => r?.heart?.restingBpm);
    return {
        key: 'heart_rate',
        label: 'Heart Rate',
        unit: 'bpm',
        value: latest.value,
        at: latest.day,
        status: latest.value === null
            ? 'Connect a device'
            : latest.value >= 50 && latest.value <= 70 ? 'Normal resting range'
                : latest.value < 50 ? 'Lower than typical' : 'Higher than typical',
        series: series((r) => r?.heart?.restingBpm),
        loggable: false,
    };
};

const sleepCard = (newest, series) => {
    const latest = newest((r) => r?.sleep?.asleepMin);
    return {
        key: 'sleep',
        label: 'Sleep',
        unit: 'h',
        value: latest.value === null ? null : Math.round((latest.value / 60) * 10) / 10,
        at: latest.day,
        status: latest.value === null ? 'Connect a device'
            : latest.value >= 420 ? 'Within your goal' : 'Below your goal',
        series: series((r) => (r?.sleep?.asleepMin ? Math.round((r.sleep.asleepMin / 60) * 10) / 10 : null)),
        loggable: false,
    };
};

const hydrationCard = (today, series) => {
    const h = today?.hydration;
    const level = h?.logs ? hydration.levelFor(h.consumedMl ?? 0, h.targetMl, { logs: h.logs }) : null;
    return {
        key: 'hydration',
        label: 'Hydration',
        unit: 'ml',
        value: h?.logs ? h.consumedMl : null,
        target: h?.targetMl ?? null,
        at: today?.day ?? null,
        status: level ? level.label : 'Nothing logged today',
        series: series((r) => (r?.hydration?.logs ? r.hydration.consumedMl : null)),
        loggable: true,
    };
};

const activityCard = (newest, series) => {
    const latest = newest((r) => r?.activity?.steps);
    return {
        key: 'steps',
        label: 'Steps',
        unit: 'steps',
        value: latest.value,
        at: latest.day,
        status: latest.value === null ? 'Connect a device' : `${latest.value.toLocaleString()} today`,
        series: series((r) => r?.activity?.steps),
        loggable: false,
    };
};

/**
 * `GET /api/metrics/:kind/history?days=30`
 *
 * The per-metric history screen: the individual entries, newest first, plus the day series
 * behind the chart. Entries and rollups together, because the design's history screen shows
 * both and they must agree.
 */
const KINDS = { weight: 'weight', water: 'water', 'blood-pressure': 'blood_pressure' };

exports.getHistory = async (req, res) => {
    try {
        const userId = req.auth.userId;
        const kind = KINDS[req.params.kind];
        if (!kind) return res.status(404).json({ message: 'Unknown metric' });

        const tzOffset = Number(req.query.tzOffset) || 0;
        const days = Math.min(365, Math.max(7, Number(req.query.days) || 30));
        const range = dayRange(days, tzOffset);

        const [logs, rows] = await Promise.all([
            MetricLog.find({ userId, kind, day: { $gte: range[0] } })
                .sort({ measuredAt: -1 }).limit(300).lean(),
            DailyMetrics.find({ userId, day: { $gte: range[0] } }).sort({ day: 1 }).lean(),
        ]);

        const byDay = new Map(rows.map((r) => [r.day, r]));
        const series = range.map((day) => {
            const r = byDay.get(day);
            if (kind === 'weight') return { day, value: r?.body?.weightKg ?? null };
            if (kind === 'water') return { day, value: r?.hydration?.logs ? r.hydration.consumedMl : null, target: r?.hydration?.targetMl ?? null };
            return {
                day,
                value: r?.bloodPressure?.systolic ?? null,
                secondary: r?.bloodPressure?.diastolic ?? null,
                category: r?.bloodPressure?.category ?? null,
            };
        });

        res.json({
            kind,
            days,
            series,
            logs: logs.map((l) => ({
                ...l,
                // Re-attached for display, but read from the stored key so a guideline change
                // never restages a reading someone was already shown. See `MetricLog.category`.
                category: l.category ? bp.CATEGORIES.find((c) => c.key === l.category) ?? null : null,
            })),
            summary: kind === 'blood_pressure' ? bp.summarise(logs) : null,
            note: kind === 'blood_pressure' ? bp.SAFETY_NOTE : null,
        });
    } catch (err) {
        console.error('❌ getHistory failed:', err);
        res.status(500).json({ message: 'Could not load that history' });
    }
};

/**
 * `GET /api/metrics/hydration/today`
 *
 * The hydration dashboard's own read. Recomputes the day first so the target reflects any
 * activity synced since the last drink was logged.
 */
exports.getHydrationToday = async (req, res) => {
    try {
        const userId = req.auth.userId;
        const tzOffset = Number(req.query.tzOffset) || 0;
        const day = localDay(Date.now(), tzOffset);

        const rollup = await recomputeMetricDay(userId, day);
        const logs = await MetricLog.find({ userId, kind: 'water', day }).sort({ measuredAt: -1 }).lean();
        const target = await require('../utils/metricRollup')._targetForDay(userId, day, rollup);

        res.json({
            day,
            ...hydrationDay(rollup),
            basis: target.basis,
            note: target.note,
            logs,
            containers: hydration.CONTAINERS,
            drinkTypes: hydration.DRINK_TYPES,
            levels: hydration.LEVELS,
        });
    } catch (err) {
        console.error('❌ getHydrationToday failed:', err);
        res.status(500).json({ message: 'Could not load your hydration' });
    }
};

/** `GET /api/metrics/reference` — the tables the log screens render. */
exports.getReference = (req, res) => {
    res.json({
        bloodPressure: {
            categories: bp.CATEGORIES.map(({ key, label, systolic, diastolic, match, colour }) =>
                ({ key, label, systolic, diastolic, match, colour })),
            limits: bp.LIMITS,
            note: bp.SAFETY_NOTE,
            crisisNote: bp.CRISIS_NOTE,
        },
        hydration: {
            containers: hydration.CONTAINERS,
            drinkTypes: hydration.DRINK_TYPES,
            levels: hydration.LEVELS,
            limits: hydration.LOG_LIMITS,
            note: hydration.GUIDE_NOTE,
        },
    });
};

exports._hydrationDay = hydrationDay;
exports._resolveDay = resolveDay;
