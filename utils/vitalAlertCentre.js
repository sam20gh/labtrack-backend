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
const VitalTarget = require('../models/VitalTarget');
const MetricLog = require('../models/MetricLog');
const { publish } = require('./notificationCentre');
const {
    evaluate, evaluateOne, severity, isFresh, higherLevel, valueLabel, copyFor, reviewCopyFor,
    needsConfirmation, confirmedSpo2, SPO2_CONFIRM_WINDOW_MIN,
    LEVEL_RANK, METRIC_LABEL, METRIC_ROUTE, CATEGORY_FOR_LEVEL, DEFAULT_TARGETS,
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

/**
 * Ranked on the level stored with the reading, never on a re-evaluation. The patient's
 * targets may have changed since, and the level they were told at the time is the one
 * that counts.
 */
const severityOf = (metric, r) => severity(metric, plain(r), r.level);

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

        const copy = copyFor({ metric: alert.metric, ...plain(worst) });
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
 * The thresholds this person is judged against: the defaults, unless a clinician has set a
 * `VitalTarget`.
 */
const targetsFor = async (userId) => {
    const row = await VitalTarget.findOne({ userId }).select('spo2Scale lowHeartRateExpected').lean();
    return row
        ? { spo2Scale: row.spo2Scale, lowHeartRateExpected: Boolean(row.lowHeartRateExpected) }
        : { ...DEFAULT_TARGETS };
};

/**
 * Tell the patient a clinician has looked at their readings.
 *
 * The alert told them something was out of range. Without this card nothing tells them
 * anyone saw it, and "I was warned and then heard nothing" is how a patient stops trusting
 * the warning. It goes out at normal priority (`vitals_review`) whatever the episode's
 * level: this is news, not an interruption.
 *
 * The body is the clinician's `patientMessage` when they wrote one, and otherwise the
 * outcome's default wording. It is **never** the internal `note`. That field is written for
 * the next clinician, and a patient reading "?non-compliant, cuff too small" on their lock
 * screen is a different conversation.
 *
 * @returns {Promise<Date|null>} when the card was written, or null
 */
const notifyReviewed = async (alert, { patientMessage = null } = {}) => {
    const copy = reviewCopyFor(alert.metric, alert.review?.outcome, patientMessage);
    if (!copy) return null;

    const { notification } = await publish(alert.userId, {
        category: 'vitals_review',
        title: copy.title,
        body: copy.body,
        route: copy.route || METRIC_ROUTE[alert.metric],
        actions: copy.action ? [copy.action] : [],
        data: { alertId: String(alert._id), metric: alert.metric, outcome: alert.review?.outcome },
        dedupeKey: `vitals:reviewed:${alert._id}`,
        source: 'vital_alerts',
    });
    return notification ? new Date() : null;
};

/**
 * Keep the automatic SpO2 readings that a second low backs up. Rule 8 of `vitalAlerts.js`.
 *
 * Runs after the sync has stored its batch, so the stored rows include it. The bracelet
 * sends whatever it has since the last sync, so a low's neighbour often arrives a sync later.
 * The window is therefore re-read around every incoming reading, and a low stored earlier
 * with no neighbour yet is confirmed by the one that has just arrived. Nothing records "held
 * for confirmation": a low is simply judged again whenever a neighbour arrives, and a low that
 * never gets a neighbour never alerts.
 *
 * Re-passing a stored reading is harmless while its episode is open, because readings are
 * keyed. A stored reading already in a closed episode, reviewed or withdrawn, is left out:
 * it was not sent by this sync, and must not reopen a case a clinician has closed.
 *
 * Everything that is not an automatic SpO2 reading passes through untouched.
 */
const confirmAutomaticSpo2 = async (userId, readings, targets) => {
    const automatic = readings.filter(needsConfirmation);
    if (!automatic.length) return readings;
    const others = readings.filter((r) => !needsConfirmation(r));

    const times = automatic.map((r) => new Date(r?.measuredAt).getTime()).filter(Number.isFinite);
    if (!times.length) return others;
    const windowMs = SPO2_CONFIRM_WINDOW_MIN * 60_000;
    const from = times.reduce((a, b) => Math.min(a, b)) - windowMs;
    const to = times.reduce((a, b) => Math.max(a, b)) + windowMs;

    // Candidates reach a window either side of the batch, and their neighbours one further.
    const stored = await MetricLog.find({
        userId,
        kind: 'spo2',
        measuredAt: { $gte: new Date(from - windowMs), $lte: new Date(to + windowMs) },
    }).select('measuredAt spo2 source externalId day').lean();

    const incomingIds = new Set(automatic.map((r) => r.externalId).filter(Boolean));
    const fallbackSource = automatic[0].source || null;
    const fromStore = stored
        .filter((row) => !row.externalId || !incomingIds.has(row.externalId))
        .map((row) => ({
            metric: 'spo2',
            measuredAt: row.measuredAt,
            spo2: row.spo2,
            // The alert keys a reading on its source. Only the bracelet writes SpO2, and it
            // is stored and alerted as `bracelet`; anything else takes this batch's label.
            source: row.source === 'bracelet' ? 'bracelet' : fallbackSource,
            externalId: row.externalId || null,
            day: row.day,
            stored: true,
        }));

    const pool = [...readings.filter((r) => r?.metric === 'spo2'), ...fromStore];
    const inWindow = (r) => {
        const at = new Date(r.measuredAt).getTime();
        return at >= from && at <= to;
    };
    const confirmed = confirmedSpo2([...automatic, ...fromStore.filter(inWindow)], pool, targets);

    const storedIds = confirmed.filter((r) => r.stored && r.externalId).map((r) => r.externalId);
    const closed = new Set();
    if (storedIds.length) {
        const rows = await VitalAlert.find({
            userId, metric: 'spo2', isOpen: false, 'readings.externalId': { $in: storedIds },
        }).select('readings.externalId').lean();
        for (const a of rows) for (const r of a.readings || []) closed.add(r.externalId);
    }
    const kept = confirmed
        .filter((r) => !(r.stored && closed.has(r.externalId)))
        .map(({ stored: _stored, ...r }) => r);

    const lone = automatic.filter((r) => evaluateOne(r, targets)).length
        - confirmed.filter((r) => !r.stored).length;
    if (lone > 0) console.log(`🫁 SpO2 u=${userId}: ${lone} lone low reading(s) not alerted, awaiting a second`);

    return [...others, ...kept];
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
        // Cheap pre-check before the targets read. The defaults are the strictest thresholds
        // a clinician can set (scale 2 and an expected low heart rate only ever remove
        // alerts), so a batch with nothing out of range under them costs no query at all.
        if (!evaluate(readings).length) return { alerts: [], notified: 0 };
        const targets = await targetsFor(userId);
        const breaches = evaluate(await confirmAutomaticSpo2(userId, readings, targets), targets);
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
 *
 * `reason` is `deleted` for that, and `unconfirmed` for a lone automatic SpO2 reading taken
 * back by `scripts/withdrawLoneSpo2.js`, so the portal can say which.
 */
const withdrawReading = async (userId, { logId = null, externalId = null, reason = 'deleted' } = {}) => {
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
                    if (!r.withdrawnAt) {
                        r.withdrawnAt = now;
                        r.withdrawnReason = reason;
                    }
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
    notifyReviewed,
    targetsFor,
    toView,
    worklistOrder,
    keyFor,
    localDay,
};
