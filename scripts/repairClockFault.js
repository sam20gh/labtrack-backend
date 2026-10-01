/**
 * Move readings a bracelet stamped while its own clock was wrong, and stored before anything
 * knew to stop them.
 *
 *   node scripts/repairClockFault.js --user <id> --device <id> \
 *        --band-from <iso> --band-to <iso> --skew <seconds> --fixed-at <iso> --tz <minutes>
 *                                                   # dry run — prints, writes nothing
 *   ... --apply
 *   node scripts/repairClockFault.js --restore <file>   # undo, from a backup this wrote
 *
 * Since `utils/clockFault.js` a sync that finds the clock wrong corrects what it carries. A
 * stretch from before that was filed where its stamps said — on 2026-10-01 a morning nap
 * under the evening before — and the band still holds the mis-stamped records and re-sends
 * them every sync. This does for one such stretch what a sync now does:
 *
 * 1. Records a `ClockFault` (origin `repair`), so every later re-send is moved too.
 *    `knownIds` are the rows in the window stored **before** `--fixed-at` — the sync that
 *    first delivered the mis-stamped ones — so a later twin of a genuine reading is dropped,
 *    not filed over it.
 * 2. Moves every row stored at or after `--fixed-at` whose stamp is in the window by
 *    `--skew`, through `ingestBatch`, so it is joined and rolled up exactly as a sync would.
 * 3. Deletes the mis-stamped originals and recomputes the days they were on.
 *
 * Arguments are band time for the window and real time for `--fixed-at`; `--skew` is real
 * minus band. `--tz` is the person's `getTimezoneOffset()`.
 *
 * A mis-stamped reading that shared its id with a genuine one cannot be told apart from it
 * and is not moved — the genuine row stays as it is. Families this cannot rebuild (workouts,
 * ECG, blood pressure) stop the run rather than being half-repaired.
 *
 * Everything this could change is written to `scripts/backups/` before anything is touched.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const ClockFault = require('../models/ClockFault');
const SleepSession = require('../models/SleepSession');
const SleepPlan = require('../models/SleepPlan');
const MetricLog = require('../models/MetricLog');
const HeartRateSample = require('../models/HeartRateSample');
const ActivitySession = require('../models/ActivitySession');
const EcgRecording = require('../models/EcgRecording');
const { ingestBatch, recomputeDay } = require('../utils/healthSync');
const { recomputeMetricDay } = require('../utils/metricRollup');
const { recomputeNight } = require('../utils/nightTemperature');
const { shiftRow, snapshotKnownIds, prefixFor, FAULT_TTL_DAYS } = require('../utils/clockFault');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const valueOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);

const PAD_MS = 12 * 3600_000;
const iso = (d) => new Date(d).toISOString();

/** A stored row back into what a sync would have sent for it. */
const asSleep = (r) => ({
    externalId: r.externalId,
    startedAt: iso(r.startedAt),
    endedAt: iso(r.endedAt),
    segments: (r.segments || []).map((s) => ({ stage: s.stage, startedAt: iso(s.startedAt), endedAt: iso(s.endedAt) })),
    asleepMin: r.asleepMin,
    inBedMin: r.inBedMin,
    sourceDevice: r.sourceDevice,
});
const asMetric = (r) => {
    if (r.kind === 'temperature') return ['temperature', { externalId: r.externalId, measuredAt: iso(r.measuredAt), celsius: r.celsius, site: r.site }];
    if (r.kind === 'spo2') {
        return ['spo2', {
            externalId: r.externalId, measuredAt: iso(r.measuredAt), spo2: r.spo2,
            context: r.note === 'Automatic measurement' ? 'automatic' : 'manual',
        }];
    }
    return [null, null];
};
const asHeart = (r) => ({ externalId: r.externalId, measuredAt: iso(r.measuredAt), bpm: r.bpm, context: r.context });

/** Every day a set of rows touched, and the rollups that read them. */
const recompute = async (userId, sleepDays, metricDays, heartDays) => {
    for (const day of new Set([...sleepDays, ...heartDays])) await recomputeDay(userId, day);
    for (const day of new Set(metricDays)) await recomputeMetricDay(userId, day);
    for (const day of new Set([...sleepDays, ...metricDays])) await recomputeNight(userId, day);
};

const restore = async (file) => {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const userId = new mongoose.Types.ObjectId(j.userId);
    const moved = { $regex: `~${j.skewSec}s$` };

    await ClockFault.deleteOne({ _id: j.faultId });
    // Sleep: everything in the span the join could have touched goes back to how it was.
    await SleepSession.deleteMany({
        userId, externalId: { $type: 'string' },
        startedAt: { $lte: new Date(j.sleepSpan.to) }, endedAt: { $gte: new Date(j.sleepSpan.from) },
    });
    if (j.before.sleep.length) await SleepSession.insertMany(j.before.sleep, { ordered: false });
    await MetricLog.deleteMany({ userId, externalId: moved });
    if (j.before.metrics.length) await MetricLog.insertMany(j.before.metrics, { ordered: false });
    await HeartRateSample.deleteMany({ userId, externalId: moved });
    if (j.before.heart.length) await HeartRateSample.insertMany(j.before.heart, { ordered: false });

    // The days the rows went back to, and the days they had been moved onto.
    const after = j.days.after || [];
    await recompute(userId, [...j.days.sleep, ...after], [...j.days.metric, ...after], [...j.days.heart, ...after]);
    console.log(`♻️  Restored ${j.before.sleep.length} sleep, ${j.before.metrics.length} metric, ${j.before.heart.length} heart row(s); fault removed.`);
};

const run = async () => {
    await connectDB();

    const restoreFile = valueOf('--restore');
    if (restoreFile) return restore(restoreFile);

    const need = ['--user', '--device', '--band-from', '--band-to', '--skew', '--fixed-at', '--tz'];
    const missing = need.filter((n) => valueOf(n) === null);
    if (missing.length) throw new Error(`Missing ${missing.join(', ')}. See the header.`);

    const apply = flag('--apply');
    const userId = new mongoose.Types.ObjectId(valueOf('--user'));
    const idPrefix = prefixFor(valueOf('--device'));
    const window = { from: new Date(valueOf('--band-from')), to: new Date(valueOf('--band-to')) };
    const skewSec = Number(valueOf('--skew'));
    const fixedAt = new Date(valueOf('--fixed-at'));
    const tzOffset = Number(valueOf('--tz'));
    if (!(skewSec > 0)) throw new Error('Only a band that ran behind can be repaired; --skew must be positive.');

    const externalId = { $regex: `^${idPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` };
    const span = { $gte: window.from, $lte: window.to };
    const late = { createdAt: { $gte: fixedAt } };

    const knownIds = await snapshotKnownIds(userId, idPrefix, window, { before: fixedAt });
    const known = new Set(knownIds);

    const [sleep, metrics, heart, workouts, ecg] = await Promise.all([
        SleepSession.find({ userId, externalId, startedAt: span, ...late }).lean(),
        MetricLog.find({ userId, externalId, measuredAt: span, ...late }).lean(),
        HeartRateSample.find({ userId, externalId, measuredAt: span, ...late }).lean(),
        ActivitySession.find({ userId, externalId, startedAt: span, ...late }).lean(),
        EcgRecording.find({ userId, externalId, measuredAt: span, ...late }).lean(),
    ]);

    const phantomSleep = sleep.filter((r) => !known.has(r.externalId));
    const mixed = phantomSleep.filter((r) => (r.parts || []).some((p) => known.has(p.externalId)));
    if (mixed.length) throw new Error(`Sleep row(s) join genuine and mis-stamped pieces: ${mixed.map((r) => r._id)}. Not repaired.`);
    const phantomMetrics = metrics.filter((r) => !known.has(r.externalId));
    const unsupported = phantomMetrics.filter((r) => !asMetric(r)[0]);
    if (workouts.length || ecg.length || unsupported.length) {
        throw new Error(`Rows this cannot rebuild: ${workouts.length} workout(s), ${ecg.length} ECG, `
            + `${unsupported.map((r) => r.kind).join(', ') || 'no'} metric(s). Not repaired.`);
    }
    const phantomHeart = heart.filter((r) => !known.has(r.externalId));
    const twins = metrics.length + heart.length + sleep.length
        - phantomMetrics.length - phantomHeart.length - phantomSleep.length;

    const fmt = (d) => iso(d).slice(0, 19).replace('T', ' ');
    console.log(`\n⏰ ${userId}: band ${fmt(window.from)} → ${fmt(window.to)} UTC, behind by ${skewSec}s`);
    console.log(`   ${knownIds.length} genuine row(s) stored before ${fmt(fixedAt)} — kept, and dropped from later syncs`);
    for (const r of phantomSleep) {
        console.log(`   sleep  ${fmt(r.startedAt)} → ${fmt(r.endedAt)} (${r.day}, ${r.asleepMin}m)  ⇒  `
            + `${fmt(new Date(r.startedAt.getTime() + skewSec * 1000))}`);
    }
    for (const r of [...phantomMetrics, ...phantomHeart]) {
        console.log(`   ${(r.kind || 'heart').padEnd(11)} ${fmt(r.measuredAt)}  ⇒  ${fmt(new Date(r.measuredAt.getTime() + skewSec * 1000))}`);
    }
    if (twins) console.log(`   ${twins} late row(s) share an id with a genuine reading — cannot be told apart, left alone`);

    if (!apply) {
        console.log('\nDry run — nothing written. Re-run with --apply.');
        return;
    }

    // The span the sleep join can reach: twelve hours either side of where the rows are and
    // of where they are going.
    const sleepSpan = {
        from: new Date(window.from.getTime() - PAD_MS),
        to: new Date(window.to.getTime() + skewSec * 1000 + PAD_MS),
    };
    const beforeSleep = await SleepSession.find({
        userId, externalId: { $type: 'string' },
        startedAt: { $lte: sleepSpan.to }, endedAt: { $gte: sleepSpan.from },
    }).lean();

    const faultId = new mongoose.Types.ObjectId();
    const today = new Date(Date.now() - tzOffset * 60_000).toISOString().slice(0, 10);
    const frozenDays = [...new Set([window.from, window.to].map((d) => new Date(d.getTime() - tzOffset * 60_000).toISOString().slice(0, 10)))]
        .filter((d) => d < today);
    const journal = {
        userId: String(userId),
        faultId: String(faultId),
        skewSec,
        sleepSpan,
        days: {
            sleep: phantomSleep.map((r) => r.day),
            metric: phantomMetrics.map((r) => r.day),
            heart: phantomHeart.map((r) => r.day),
        },
        before: { sleep: beforeSleep, metrics: phantomMetrics, heart: phantomHeart },
    };
    const backupFile = path.join(__dirname, 'backups', `clockfault-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.mkdirSync(path.dirname(backupFile), { recursive: true });
    fs.writeFileSync(backupFile, JSON.stringify(journal, null, 2));

    await ClockFault.create({
        _id: faultId,
        userId,
        platform: 'jstyle_bracelet',
        idPrefix,
        skewSec,
        window,
        mode: 'shift',
        knownIds,
        shiftedIds: [
            ...phantomSleep.flatMap((r) => [r.externalId, ...(r.parts || []).map((p) => p.externalId)]),
            ...phantomMetrics.map((r) => r.externalId),
            ...phantomHeart.map((r) => r.externalId),
        ],
        frozenDays,
        origin: 'repair',
        detectedAt: fixedAt,
        expiresAt: new Date(fixedAt.getTime() + FAULT_TTL_DAYS * 86_400_000),
    });

    // Originals out first, so the moved sleep is not joined to its own mis-stamped self.
    await SleepSession.deleteMany({ _id: { $in: phantomSleep.map((r) => r._id) } });
    await MetricLog.deleteMany({ _id: { $in: phantomMetrics.map((r) => r._id) } });
    await HeartRateSample.deleteMany({ _id: { $in: phantomHeart.map((r) => r._id) } });
    await recompute(userId, journal.days.sleep, journal.days.metric, journal.days.heart);

    const batch = { sleep: [], spo2: [], temperature: [], heart: [] };
    for (const r of phantomSleep) {
        // A joined row goes back in as its pieces, so the join is redone at the right time.
        const pieces = r.parts?.length ? r.parts.map((p) => ({ ...p, sourceDevice: r.sourceDevice })) : [r];
        for (const p of pieces) batch.sleep.push(shiftRow(asSleep(p), skewSec));
    }
    for (const r of phantomMetrics) {
        const [family, row] = asMetric(r);
        batch[family].push(shiftRow(row, skewSec));
    }
    for (const r of phantomHeart) batch.heart.push(shiftRow(asHeart(r), skewSec));

    const plan = await SleepPlan.findOne({ userId }).select('goalMinutes').lean();
    const result = await ingestBatch({ userId, platform: 'jstyle_bracelet', tzOffset, goalMinutes: plan?.goalMinutes, ...batch });
    journal.days.after = result.days;
    fs.writeFileSync(backupFile, JSON.stringify(journal, null, 2));

    console.log(`\n✅ Moved ${phantomSleep.length} sleep, ${phantomMetrics.length} metric, ${phantomHeart.length} heart row(s); `
        + `days now updated: ${result.days.join(', ')}`);
    console.log(`💾 Backup: ${backupFile}\n   Undo with: node scripts/repairClockFault.js --restore ${backupFile}`);
};

run()
    .catch((err) => { console.error('❌', err.message || err); process.exitCode = 1; })
    .finally(() => mongoose.disconnect());
