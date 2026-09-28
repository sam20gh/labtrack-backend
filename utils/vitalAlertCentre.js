/**
 * Out-of-range vital signs: onto the patient's record, and in front of the patient.
 *
 * Every path that writes a blood pressure, an SpO2 or a heart rate calls `recordReadings()`
 * with what it wrote: the bracelet and health-store sync, and the manual blood-pressure log.
 * `utils/vitalAlerts.js` decides what is out of range; this file does two writes with it:
 *
 *   1. **The record.** A `VitalAlert` episode per person per metric, which a clinician sees
 *      in the portal and closes with an outcome. Written for every breach, fresh or not.
 *   2. **The patient's card.** Through `notificationCentre.publish`, once per metric per
 *      local day per level, and only for readings from the last `FRESH_HOURS`.
 *
 * Four rules:
 *
 * - **It never throws at the caller.** Same contract as `notificationCentre.publish` and
 *   `scoreController.touch`: a sync that has stored a month of readings must answer 200
 *   whether or not an alert could be written.
 * - **Re-sending is harmless.** Every sync re-sends readings the server already has.
 *   Readings are keyed, so a repeat changes nothing, and cards are deduped per day so a
 *   repeat does not notify again.
 * - **A card only moves when the news gets worse.** The card for a day shows that day's
 *   worst fresh reading at that level, taken from the whole episode rather than from this
 *   batch. Otherwise a second, milder reading would rewrite the card to something less
 *   alarming and push it again.
 * - **Urgent supersedes attention on the same day.** Once somebody has been told their
 *   oxygen is very low, a second card saying it is a bit low is noise.
 */
const User = require('../models/userModel');
const Notification = require('../models/Notification');
const VitalAlert = require('../models/VitalAlert');
const { publish } = require('./notificationCentre');
const {
    evaluate, evaluateOne, isFresh, higherLevel, valueLabel, copyFor,
    LEVEL_RANK, METRIC_LABEL, METRIC_ROUTE, CATEGORY_FOR_LEVEL,
} = require('./vitalAlerts');

const { MAX_READINGS } = VitalAlert;

const localDay = (instant, tzOffsetMinutes = 0) =>
    new Date(new Date(instant).getTime() - (Number(tzOffsetMinutes) || 0) * 60_000)
        .toISOString().slice(0, 10);

/**
 * The identity of a reading. A store UUID where there is one, the log row for a manual
 * entry, and otherwise the moment plus the value.
 */
const keyFor = (r) => {
    if (r.externalId) return `ext:${r.source || 'device'}:${r.externalId}`;
    if (r.logId) return `log:${r.logId}`;
    return `at:${new Date(r.measuredAt).toISOString()}:${valueLabel(r)}`;
};

const toStored = (breach, tzOffset) => ({
    measuredAt: breach.measuredAt,
    day: breach.day || localDay(breach.measuredAt, tzOffset),
    level: breach.level,
    rule: breach.rule,
    systolic: breach.metric === 'blood_pressure' ? Math.round(breach.systolic) : null,
    diastolic: breach.metric === 'blood_pressure' ? Math.round(breach.diastolic) : null,
    category: breach.category ?? null,
    spo2: breach.metric === 'spo2' ? Math.round(breach.spo2) : null,
    bpm: breach.metric === 'heart_rate' ? Math.round(breach.bpm) : null,
    context: breach.metric === 'heart_rate' ? breach.context : null,
    source: breach.source || null,
    method: breach.method || null,
    key: keyFor(breach),
    logId: breach.logId || null,
    externalId: breach.externalId || null,
    withdrawnAt: null,
});

const plain = (r) => (typeof r?.toObject === 'function' ? r.toObject() : r);

const severityOf = (metric, r) => evaluateOne({ metric, ...plain(r) })?.severity ?? 0;

/**
 * Fold one batch of breaching readings into an episode. Mutates `alert`.
 *
 * The cap keeps the newest `MAX_READINGS` readings. A reading older than the oldest one
 * kept, arriving once the array is full, is assumed already seen and skipped. Without that
 * rule, every re-sync of a long backfill would count the same old readings again.
 */
const mergeReadings = (alert, breaches, tzOffset) => {
    const seen = new Set(alert.readings.map((r) => r.key));
    let added = 0;

    for (const b of breaches) {
        const stored = toStored(b, tzOffset);
        if (seen.has(stored.key)) continue;
        if (alert.readings.length >= MAX_READINGS
            && stored.measuredAt < alert.readings[0].measuredAt) continue;

        seen.add(stored.key);
        alert.readings.push(stored);
        added += 1;
    }
    if (!added) return 0;

    alert.readings.sort((a, b) => new Date(a.measuredAt) - new Date(b.measuredAt));
    if (alert.readings.length > MAX_READINGS) {
        alert.readings.splice(0, alert.readings.length - MAX_READINGS);
    }
    alert.readingCount = (alert.readingCount || 0) + added;
    summarise(alert);
    return added;
};

/**
 * Recompute level, worst, latest and the time span from the readings that still stand.
 * A withdrawn reading no longer counts towards any of them, but it stays in the list.
 */
const summarise = (alert) => {
    const live = alert.readings.filter((r) => !r.withdrawnAt);
    if (!live.length) return;

    const first = live[0];
    const last = live[live.length - 1];
    // Once the cap has dropped early readings, the first one kept is not the first one seen.
    const truncated = (alert.readingCount || 0) > alert.readings.length;
    alert.firstAt = truncated && alert.firstAt ? alert.firstAt : first.measuredAt;
    alert.lastAt = last.measuredAt;
    alert.latest = plain(last);

    let worst = live[0];
    for (const r of live) if (severityOf(alert.metric, r) > severityOf(alert.metric, worst)) worst = r;
    alert.worst = plain(worst);

    alert.level = live.reduce((acc, r) => higherLevel(acc, r.level), 'attention');
    alert.hasEstimate = live.some((r) => r.method === 'optical_estimate');
};

/**
 * The open episode for this person and metric, creating it if there is none.
 *
 * The partial unique index allows only one open episode. If two syncs race to create it,
 * the loser gets E11000 and reads the winner's row instead.
 */
const openAlertFor = async (userId, metric, seed) => {
    const existing = await VitalAlert.findOne({ userId, metric, isOpen: true });
    if (existing) return existing;
    try {
        return await VitalAlert.create({
            userId,
            metric,
            level: seed.level,
            firstAt: seed.measuredAt,
            lastAt: seed.measuredAt,
            readingCount: 0,
        });
    } catch (error) {
        if (error?.code !== 11000) throw error;
        return VitalAlert.findOne({ userId, metric, isOpen: true });
    }
};

/**
 * Tell the patient about the days in this batch that had a fresh breach.
 *
 * @returns {Promise<number>} how many cards were written or moved
 */
const notifyPatient = async (alert, freshDays, { user, tzOffset, now }) => {
    let written = 0;

    for (const day of freshDays) {
        const ofDay = alert.readings.filter((r) =>
            r.day === day && !r.withdrawnAt && isFresh(r.measuredAt, now));
        if (!ofDay.length) continue;

        const level = ofDay.reduce((acc, r) => higherLevel(acc, r.level), 'attention');
        const atLevel = ofDay.filter((r) => r.level === level);
        const worst = atLevel.reduce((a, r) =>
            (severityOf(alert.metric, r) > severityOf(alert.metric, a) ? r : a), atLevel[0]);

        if (level === 'attention') {
            const alreadyUrgent = await Notification.exists({
                userId: alert.userId,
                dedupeKey: `vitals:${alert.metric}:${day}:urgent`,
            });
            if (alreadyUrgent) continue;
        }

        const copy = copyFor({ metric: alert.metric, ...plain(worst) }, level);
        if (!copy) continue;

        const route = METRIC_ROUTE[alert.metric];
        const actions = [{ label: 'View readings', route, tone: 'primary' }];
        // An urgent card's advice is emergency care, and a "book a consult" button beside
        // it would contradict that.
        if (level === 'attention') {
            actions.push({ label: 'Talk to a clinician', route: '/professionals', tone: 'secondary' });
        }

        const { notification, pushed } = await publish(alert.userId, {
            category: CATEGORY_FOR_LEVEL[level],
            title: copy.title,
            body: copy.body,
            route,
            chip: { label: copy.chip, icon: 'pulse-outline' },
            actions,
            data: { alertId: String(alert._id), metric: alert.metric, level },
            dedupeKey: `vitals:${alert.metric}:${day}:${level}`,
            source: 'vital_alerts',
        }, { user, tzOffsetMinutes: tzOffset });

        if (notification) {
            alert.notified.push({
                notificationId: notification._id,
                level,
                at: now,
                pushed: pushed > 0,
            });
            written += 1;
        }
    }

    // A long-lived episode keeps its last twenty notices; that is the history a clinician needs.
    if (alert.notified.length > 20) alert.notified.splice(0, alert.notified.length - 20);
    return written;
};

/**
 * Evaluate readings a write path has just stored, and record any that are out of range.
 *
 * @param {string} userId
 * @param {object[]} readings  `{ metric, measuredAt, systolic?, diastolic?, spo2?, bpm?,
 *                              context?, source?, method?, externalId?, logId?, day? }`
 * @param {object} [options]
 * @param {number} [options.tzOffset]  the client's `getTimezoneOffset()`
 * @param {Date}   [options.now]
 * @returns {Promise<{alerts: object[], notified: number}>} never rejects
 */
const recordReadings = async (userId, readings, options = {}) => {
    try {
        const breaches = evaluate(readings);
        if (!breaches.length) return { alerts: [], notified: 0 };

        const tzOffset = Number(options.tzOffset) || 0;
        const now = options.now instanceof Date ? options.now : new Date();

        const byMetric = new Map();
        for (const b of breaches) {
            if (!byMetric.has(b.metric)) byMetric.set(b.metric, []);
            byMetric.get(b.metric).push(b);
        }

        let user = null;
        const alerts = [];
        let notified = 0;

        for (const [metric, list] of byMetric) {
            const seed = list.reduce((a, b) => (b.severity > a.severity ? b : a), list[0]);
            const alert = await openAlertFor(userId, metric, seed);
            const added = mergeReadings(alert, list, tzOffset);
            if (!added) continue;

            await alert.save();
            alerts.push(alert);

            const freshDays = new Set(list
                .filter((b) => isFresh(b.measuredAt, now))
                .map((b) => b.day || localDay(b.measuredAt, tzOffset)));
            if (!freshDays.size) continue;

            user = user ?? await User.findById(userId).select('pushTokens notificationPreferences').lean();
            const written = await notifyPatient(alert, freshDays, { user, tzOffset, now });
            if (written) {
                notified += written;
                await alert.save();
            }

            console.log(`🚨 Vital alert ${metric} ${alert.level} u=${userId} +${added} (total ${alert.readingCount})`);
        }

        return { alerts, notified };
    } catch (error) {
        console.error('❌ Recording vital alerts failed:', error.message);
        return { alerts: [], notified: 0 };
    }
};

/**
 * The patient deleted an entry, e.g. a mistyped 250/150.
 *
 * Open episodes mark the reading withdrawn and recompute around it. When nothing is left,
 * the episode closes as `withdrawn`, so the worklist does not ask a clinician to review a
 * typo. A reviewed episode is not touched. Its review was made against the readings it
 * showed at the time, and changing those afterwards would make the review say something
 * it did not.
 */
const withdrawReading = async (userId, { logId = null, externalId = null } = {}) => {
    try {
        if (!logId && !externalId) return 0;
        const match = [];
        if (logId) match.push({ 'readings.logId': logId });
        if (externalId) match.push({ 'readings.externalId': externalId });
        const open = await VitalAlert.find({ userId, isOpen: true, $or: match });

        for (const alert of open) {
            const now = new Date();
            for (const r of alert.readings) {
                if ((logId && String(r.logId) === String(logId))
                    || (externalId && r.externalId === externalId)) {
                    r.withdrawnAt = r.withdrawnAt || now;
                }
            }
            if (alert.readings.every((r) => r.withdrawnAt)) {
                alert.status = 'withdrawn';
                alert.isOpen = false;
            } else {
                summarise(alert);
            }
            await alert.save();
        }
        return open.length;
    } catch (error) {
        console.error('❌ Withdrawing a vital reading failed:', error.message);
        return 0;
    }
};

/**
 * The shape the portal reads. Values are labelled here so the worklist and the patient
 * record print a reading identically, e.g. `152/94 mmHg` on both.
 */
const readingView = (metric, r) => (r ? {
    ...plain(r),
    value: valueLabel({ metric, ...plain(r) }),
} : null);

const toView = (alert) => {
    const a = plain(alert);
    return {
        _id: a._id,
        userId: a.userId && a.userId._id ? String(a.userId._id) : String(a.userId),
        patient: a.userId && a.userId._id ? {
            _id: a.userId._id,
            firstName: a.userId.firstName,
            lastName: a.userId.lastName,
            dob: a.userId.dob,
            gender: a.userId.gender,
        } : undefined,
        metric: a.metric,
        metricLabel: METRIC_LABEL[a.metric],
        level: a.level,
        status: a.status,
        firstAt: a.firstAt,
        lastAt: a.lastAt,
        readingCount: a.readingCount,
        worst: readingView(a.metric, a.worst),
        latest: readingView(a.metric, a.latest),
        readings: (a.readings || []).slice().reverse().map((r) => readingView(a.metric, r)),
        /** Any optical estimate in the episode. The portal flags the row with it. */
        hasEstimate: Boolean(a.hasEstimate),
        notified: a.notified || [],
        review: a.review?.at ? a.review : null,
        createdAt: a.createdAt,
    };
};

/** Worklist order: open before closed, urgent before attention, newest reading first. */
const worklistOrder = (a, b) =>
    (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1)
    || (LEVEL_RANK[b.level] || 0) - (LEVEL_RANK[a.level] || 0)
    || new Date(b.lastAt) - new Date(a.lastAt);

module.exports = {
    recordReadings,
    withdrawReading,
    toView,
    worklistOrder,
    keyFor,
    localDay,
};
