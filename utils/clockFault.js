/**
 * Readings a bracelet stamped while its own clock was wrong.
 *
 * Every record a J-Style bracelet sends is timestamped from its own clock, which the phone
 * sets at the start of every sync. On 2026-10-01 a V8 was found running 10h 34m behind for an
 * hour and a half after one: at the 07:07 sync it went back to roughly the time the sync
 * before had set (20:33 the evening before) and stamped everything after that in the wrong
 * day until the 08:44 sync set it right. A morning nap arrived filed as the previous evening,
 * so the record screen showed no nap that morning. Its temperature readings went into an hour that already held
 * real ones, and where the band gave both the same second they shared an `externalId`
 * and one overwrote the other. Seven stretches turned up in four days of data, every one
 * beginning at a sync and going back to about the time the sync before had set. Nothing
 * in the app had noticed any of them.
 *
 * The phone now reads the band's clock *before* setting it and sends what it saw
 * (`batch.clock`). From that, this file decides:
 *
 * 1. **Whether the clock was wrong** — off by more than `CLOCK_TOLERANCE_SEC`. A few seconds
 *    of drift is a quartz crystal; five minutes is not.
 * 2. **Which band-time a wrong stamp can carry.** The clock was last known right when it was
 *    last set (`lastSetAt`). However it went wrong after that, no more band time than real
 *    time can have passed since, so every wrong stamp lies in
 *    `[bandAt − (phoneAt − lastSetAt), bandAt]` — the `window`.
 * 3. **Whether every unknown row in that window is wrong.** For a band that was *behind*, if
 *    the whole window lies before `lastSetAt`, no genuine reading could be stamped in it that
 *    was not already on the record at the last sync — so anything new in it is mis-stamped,
 *    and is moved by the skew (`shift`). If the window reaches into real time since the last
 *    set, a new row in it might be genuine; it is kept on the fault, unfiled (`hold`).
 *    Filing a guess as a fact is the failure this exists to stop, so the ambiguous case
 *    keeps the reading rather than placing it.
 *
 * Three rules about what the band sends *afterwards*, because it keeps sending: sleep and
 * blood pressure are never deleted from it (`reader.ts` `MAPPERS` says why), so the same
 * mis-stamped nap comes back on every sync for weeks.
 *
 * - **A row stored before the stretch is never re-ingested** (`knownIds`). It is already on
 *   the record, and its mis-stamped twin can carry the identical id.
 * - **A row once moved is moved again, to the same id** (`shiftedIds`), so a re-send upserts
 *   rather than refiling the reading at the wrong time.
 * - **Whole-day figures for a day the band was wrongly in are frozen** (`frozenDays`). The
 *   band kept adding to that day's steps and heart spread while it believed it was that day,
 *   and those totals arrive keyed by day, not by instant — nothing could take the extra out.
 *
 * A band that ran *fast* has not been seen. It is handled only while its stamps are still in
 * the future, which no genuine reading can be; once real time reaches them a stamp says
 * nothing about which reading it belongs to, and they pass through as they are.
 *
 * Pure except `snapshotKnownIds` and `prepareBraceletBatch`.
 */
const ClockFault = require('../models/ClockFault');
const SleepSession = require('../models/SleepSession');
const ActivitySession = require('../models/ActivitySession');
const HeartRateSample = require('../models/HeartRateSample');
const MetricLog = require('../models/MetricLog');
const EcgRecording = require('../models/EcgRecording');

/** Beyond this, the band's clock is wrong rather than drifting. */
const CLOCK_TOLERANCE_SEC = 300;
/** Slack either side of the window, for the seconds a sync takes between reading and setting. */
const WINDOW_MARGIN_MS = 2 * 60_000;
/** With no record of when the clock was last set, how far back a wrong stamp is looked for. */
const UNKNOWN_SET_LOOKBACK_MS = 7 * 86_400_000;
/** The band's buffers roll over in a few weeks; past this it cannot send the stretch again. */
const FAULT_TTL_DAYS = 60;
/** `held` is a record of what was not filed, not a second store. */
const MAX_HELD_ROWS = 500;

/** Each instant-stamped family and the field its stamp is in. `days` is keyed by day instead. */
const INSTANT_FAMILIES = {
    activities: 'startedAt',
    sleep: 'startedAt',
    heart: 'measuredAt',
    spo2: 'measuredAt',
    temperature: 'measuredAt',
    bloodPressure: 'measuredAt',
    ecg: 'measuredAt',
    stress: 'measuredAt',
};

const time = (value) => {
    if (value === null || value === undefined) return null;
    const t = new Date(value).getTime();
    return Number.isFinite(t) ? t : null;
};

const localDay = (ms, tzOffset = 0) =>
    new Date(ms - (Number(tzOffset) || 0) * 60_000).toISOString().slice(0, 10);

/** Real minus band, in whole seconds, from one `{ bandAt, phoneAt }` reading. */
const skewOf = (reading) => {
    const band = time(reading?.bandAt);
    const phone = time(reading?.phoneAt);
    return band === null || phone === null ? null : Math.round((phone - band) / 1000);
};

/** Every local day from `fromMs` to `toMs` inclusive. */
const daysBetween = (fromMs, toMs, tzOffset) => {
    const out = [];
    const last = localDay(toMs, tzOffset);
    for (let t = fromMs; ; t += 86_400_000) {
        const day = localDay(t, tzOffset);
        out.push(day);
        if (day >= last) break;
    }
    return [...new Set(out)];
};

const prefixFor = (deviceId) => `jstyle:${deviceId}:`;

/**
 * Was the clock wrong, and over what band time? Null when it was right, or when the phone
 * could not read it — a build without the clock read, or a band that did not answer, is not
 * evidence of anything.
 *
 * @param {object} clock      `batch.clock` from `lib/health/jstyle/reader.ts`
 * @param {object} [options]
 * @param {number} [options.tzOffset]  the batch's `getTimezoneOffset()`
 */
const detectFault = (clock, { tzOffset = 0 } = {}) => {
    if (!clock || typeof clock !== 'object' || !clock.deviceId) return null;
    const bandAt = time(clock.bandAt);
    const phoneAt = time(clock.phoneAt);
    if (bandAt === null || phoneAt === null) return null;

    const skewMs = phoneAt - bandAt;
    if (Math.abs(skewMs) <= CLOCK_TOLERANCE_SEC * 1000) return null;

    const lastSetAt = time(clock.lastSetAt);
    const known = lastSetAt !== null && lastSetAt < phoneAt;
    const elapsed = known ? phoneAt - lastSetAt : UNKNOWN_SET_LOOKBACK_MS;

    const from = bandAt - elapsed - WINDOW_MARGIN_MS;
    const to = bandAt + WINDOW_MARGIN_MS;

    // Rule 3. A genuine reading that is not on the record yet was taken after the last set,
    // so it is stamped in [lastSetAt, phoneAt]; a window clear of that span holds none.
    const clear = known && (to < lastSetAt || from > phoneAt);
    const behind = skewMs > 0;

    // The band only believed it was a *past* day when it was behind. Today is still
    // accumulating and is not frozen.
    const today = localDay(phoneAt, tzOffset);
    const frozenDays = behind
        ? daysBetween(from, to, tzOffset).filter((d) => d < today)
        : [];

    return {
        idPrefix: prefixFor(clock.deviceId),
        skewSec: Math.round(skewMs / 1000),
        window: { from: new Date(from), to: new Date(to) },
        mode: behind && clear ? 'shift' : 'hold',
        frozenDays,
        diagnostics: {
            lastSetAt: known ? new Date(lastSetAt) : null,
            afterReadSkewSec: skewOf(clock.afterRead),
            previous: clock.previous
                ? {
                    at: clock.previous.at || null,
                    afterReadSkewSec: skewOf(clock.previous.afterRead),
                    afterAckSkewSec: skewOf(clock.previous.afterAck),
                }
                : null,
        },
    };
};

/** A row moved by the fault's skew, under an id of its own so a re-send lands on it. */
const shiftRow = (row, skewSec) => {
    const ms = skewSec * 1000;
    const move = (value) => (time(value) === null ? value : new Date(time(value) + ms).toISOString());
    const out = { ...row };
    for (const field of ['startedAt', 'endedAt', 'measuredAt']) {
        if (row[field] !== undefined) out[field] = move(row[field]);
    }
    if (Array.isArray(row.segments)) {
        out.segments = row.segments.map((s) => ({ ...s, startedAt: move(s.startedAt), endedAt: move(s.endedAt) }));
    }
    // The day is the server's to work out from the corrected instant.
    delete out.day;
    out.externalId = `${row.externalId}~${skewSec}s`;
    return out;
};

/**
 * What one fault says about one row: `shift`, `drop`, `hold`, or null for "not mine".
 *
 * `fresh` is true only for the fault detected from this very batch — the one batch in which
 * an unknown row in the window can be judged without having been seen before.
 */
const judge = (row, stampMs, fault, { phoneAtMs, fresh }) => {
    const id = row?.externalId;
    if (typeof id !== 'string' || !id.startsWith(fault.idPrefix)) return null;

    const inWindow = stampMs !== null
        && stampMs >= time(fault.window.from) && stampMs <= time(fault.window.to);

    if (fault.skewSec < 0) {
        // Fast: only a future stamp is certainly wrong. See the header.
        if (!inWindow) return null;
        if (stampMs > phoneAtMs) return 'shift';
        return fresh && !fault.known.has(id) ? 'hold' : null;
    }

    if (fault.known.has(id)) return 'drop';
    if (fault.shifted.has(id)) return 'shift';
    if (!inWindow) return null;
    if (fresh && fault.mode === 'shift') return 'shift';
    return 'hold';
};

/**
 * Apply every active fault to a batch. Returns the corrected batch, what each fault learnt
 * (ids it moved, rows it held), and counts for the log.
 *
 * @param {object} body     the sync request body
 * @param {Array}  faults   `{ _id?, idPrefix, skewSec, window, mode, knownIds, shiftedIds,
 *                           frozenDays }`, oldest first
 * @param {object} options  `{ phoneAt, freshIndex }` — the index in `faults` detected from
 *                           this batch, or -1
 */
const applyFaults = (body, faults = [], { phoneAt = Date.now(), freshIndex = -1 } = {}) => {
    const prepared = faults.map((f) => ({
        ...f,
        known: new Set(f.knownIds || []),
        shifted: new Set(f.shiftedIds || []),
    }));
    const learnt = prepared.map(() => ({ shiftedIds: new Set(), held: [] }));
    const report = { shifted: 0, dropped: 0, held: 0, daysDropped: 0 };
    const out = { ...body };
    const phoneAtMs = time(phoneAt) ?? Date.now();

    for (const [family, field] of Object.entries(INSTANT_FAMILIES)) {
        if (!Array.isArray(body[family])) continue;
        const kept = [];
        for (const row of body[family]) {
            const stampMs = time(row?.[field]);
            let verdict = null;
            let index = -1;
            for (let i = 0; i < prepared.length && !verdict; i += 1) {
                verdict = judge(row, stampMs, prepared[i], { phoneAtMs, fresh: i === freshIndex });
                index = i;
            }

            if (!verdict) { kept.push(row); continue; }
            const fault = prepared[index];
            if (verdict === 'shift') {
                kept.push(shiftRow(row, fault.skewSec));
                if (fault.skewSec > 0) learnt[index].shiftedIds.add(row.externalId);
                report.shifted += 1;
            } else if (verdict === 'hold') {
                learnt[index].held.push({ family, row });
                report.held += 1;
            } else {
                report.dropped += 1;
            }
        }
        out[family] = kept;
    }

    // Day-keyed families. The continuous heart stream is filed by day like the day totals, so
    // a frozen day keeps out both.
    const frozen = new Set(prepared.flatMap((f) => f.frozenDays || []));
    for (const family of ['days', 'heartStream']) {
        if (!Array.isArray(body[family])) continue;
        out[family] = body[family].filter((d) => {
            if (!frozen.has(d?.day)) return true;
            report.daysDropped += 1;
            return false;
        });
    }

    return {
        body: out,
        learnt: learnt.map((l) => ({ shiftedIds: [...l.shiftedIds], held: l.held })),
        report,
    };
};

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The ids of rows already on the record that carry a stamp in the window — the genuine ones,
 * read before the batch that found the fault is written. `before` restricts it to rows stored
 * earlier than an instant, which is how a repair tells the genuine rows from mis-stamped ones
 * that were stored before anything knew to stop them.
 */
const snapshotKnownIds = async (userId, idPrefix, window, { before = null } = {}) => {
    const externalId = { $regex: `^${escapeRegex(idPrefix)}` };
    const created = before ? { createdAt: { $lt: before } } : {};
    const span = { $gte: window.from, $lte: window.to };

    const [sleep, activities, heart, metrics, ecg] = await Promise.all([
        SleepSession.find({
            userId, externalId, ...created,
            startedAt: { $lte: window.to }, endedAt: { $gte: window.from },
        }).select('externalId parts.externalId').lean(),
        ActivitySession.find({ userId, externalId, startedAt: span, ...created }).select('externalId').lean(),
        HeartRateSample.find({ userId, externalId, measuredAt: span, ...created }).select('externalId').lean(),
        MetricLog.find({ userId, externalId, measuredAt: span, ...created }).select('externalId').lean(),
        EcgRecording.find({ userId, externalId, measuredAt: span, ...created }).select('externalId').lean(),
    ]);

    return [...new Set([
        ...sleep.flatMap((r) => [r.externalId, ...(r.parts || []).map((p) => p.externalId)]),
        ...[...activities, ...heart, ...metrics, ...ecg].map((r) => r.externalId),
    ].filter(Boolean))];
};

/** Writes what a batch taught each fault. */
const persistLearnt = async (faults, learnt) => {
    for (let i = 0; i < faults.length; i += 1) {
        const { shiftedIds, held } = learnt[i];
        if (!faults[i]._id || (!shiftedIds.length && !held.length)) continue;
        await ClockFault.updateOne({ _id: faults[i]._id }, {
            ...(shiftedIds.length ? { $addToSet: { shiftedIds: { $each: shiftedIds } } } : {}),
            ...(held.length ? { $push: { held: { $each: held, $slice: MAX_HELD_ROWS } } } : {}),
        });
    }
};

/**
 * The one call the sync controller makes: find the faults that apply to this person's
 * bracelet, record a new one if this batch's clock reading shows one, and return the batch
 * with every mis-stamped row corrected or set aside.
 *
 * Throws nothing at the caller. A failure here returns the batch as it came — a sync must
 * still land if this goes wrong, which is the bargain `scoreController.touch` keeps too.
 */
const prepareBraceletBatch = async (userId, body) => {
    if (body?.platform !== 'jstyle_bracelet') return { body, report: null };
    try {
        const tzOffset = Number(body.tzOffset) || 0;
        const phoneAt = time(body.clock?.phoneAt) ?? Date.now();
        const faults = await ClockFault.find({
            userId, platform: 'jstyle_bracelet', expiresAt: { $gt: new Date() },
        }).sort({ detectedAt: 1 }).lean();

        let freshIndex = -1;
        let detected = null;
        const found = detectFault(body.clock, { tzOffset });
        if (found) {
            const knownIds = await snapshotKnownIds(userId, found.idPrefix, found.window);
            const doc = await ClockFault.create({
                userId,
                platform: 'jstyle_bracelet',
                ...found,
                knownIds,
                origin: 'sync',
                detectedAt: new Date(phoneAt),
                expiresAt: new Date(phoneAt + FAULT_TTL_DAYS * 86_400_000),
            });
            faults.push(doc.toObject());
            freshIndex = faults.length - 1;
            detected = { skewSec: found.skewSec, mode: found.mode, diagnostics: found.diagnostics };
        }

        if (!faults.length) return { body, report: null };

        const result = applyFaults(body, faults, { phoneAt, freshIndex });
        await persistLearnt(faults, result.learnt);

        const report = { ...result.report, detected };
        if (detected || report.shifted || report.held || report.daysDropped) {
            console.log(
                `⏰ Bracelet clock u=${userId}`
                + (detected ? ` off by ${detected.skewSec}s (${detected.mode})` : '')
                + ` shifted=${report.shifted} held=${report.held} dropped=${report.dropped}`
                + ` daysDropped=${report.daysDropped}`
                + (detected ? ` diag=${JSON.stringify(detected.diagnostics)}` : ''),
            );
        }
        return { body: result.body, report };
    } catch (err) {
        console.error('❌ Clock-fault check failed; batch ingested as sent:', err);
        return { body, report: null };
    }
};

module.exports = {
    detectFault,
    applyFaults,
    shiftRow,
    snapshotKnownIds,
    prepareBraceletBatch,
    skewOf,
    prefixFor,
    CLOCK_TOLERANCE_SEC,
    FAULT_TTL_DAYS,
    MAX_HELD_ROWS,
    INSTANT_FAMILIES,
};
