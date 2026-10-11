const DailyMetrics = require('../models/DailyMetrics');
const SleepPlan = require('../models/SleepPlan');
const VitalAlert = require('../models/VitalAlert');
const { recomputeDay } = require('../utils/healthSync');
const { buildReadout, weekStartOf, reasonsFor, recoveryTrend, BASELINE_DAYS } = require('../utils/dailyReadout');

const DAY_MS = 86400000;

/** `YYYY-MM-DD` for an instant, `tzOffset` minutes west of UTC (`getTimezoneOffset()`). */
const localDay = (ms, tzOffset) => new Date(ms - tzOffset * 60000).toISOString().slice(0, 10);

/**
 * GET /api/readout?tzOffset= — the home screen's Sleep · Recovery · Effort readout.
 *
 * Database reads only, so the home screen can put it in its first-paint batch: one range of
 * `DailyMetrics` (29 days for the baselines), the sleep goal, and whether an urgent vital alert
 * is open. `utils/dailyReadout.js` decides what they mean.
 *
 * A day of this week rolled up before effort existed has no `activity.effortMin` key at all
 * (undefined, not null). Those days are recomputed here, once each, so the week's total is
 * right on the first open after the deploy rather than after a week of syncs.
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
        const stale = rows.filter((r) => r.day >= weekStart && r.activity?.effortMin === undefined);
        if (stale.length) {
            for (const r of stale) await recomputeDay(r.userId, r.day);
            rows = await read();
        }

        const [plan, urgent] = await Promise.all([
            SleepPlan.findOne({ userId }).select('goalMinutes').lean(),
            VitalAlert.exists({ userId, isOpen: true, level: 'urgent' }),
        ]);

        res.json(buildReadout({
            rows,
            today,
            hour,
            goalMinutes: plan?.goalMinutes ?? null,
            urgentAlert: Boolean(urgent),
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

        const [rows, urgent] = await Promise.all([
            DailyMetrics.find({ userId, day: { $gte: from } }).sort({ day: 1 }).lean(),
            VitalAlert.exists({ userId, isOpen: true, level: 'urgent' }),
        ]);
        const readout = buildReadout({ rows, today, hour: 8, urgentAlert: Boolean(urgent) });

        res.json({
            day: today,
            recovery: readout.recovery,
            reasons: reasonsFor(readout.recovery),
            trend: recoveryTrend(rows, today, 7),
            effortTarget: readout.effort.target,
            targetReason: readout.effort.targetReason,
        });
    } catch (err) {
        console.error('❌ Building recovery failed:', err);
        res.status(500).json({ message: 'Could not load recovery' });
    }
};
