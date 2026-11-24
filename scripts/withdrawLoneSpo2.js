/**
 * Withdraw the lone automatic SpO2 readings that open vital-alert episodes still hold.
 *
 *   node scripts/withdrawLoneSpo2.js                 # dry run, every open SpO2 episode
 *   node scripts/withdrawLoneSpo2.js --user <id>     # dry run, one person
 *   node scripts/withdrawLoneSpo2.js --user <id> --apply
 *   node scripts/withdrawLoneSpo2.js --restore <file>   # undo, from a backup this wrote
 *
 * Rule 8 of `utils/vitalAlerts.js`: an automatic SpO2 reading alerts only when a second low
 * lies within `SPO2_CONFIRM_WINDOW_MIN` of it. Episodes opened before that rule hold single
 * hourly dips between normal readings, each of which pushed a "seek care" card. This judges
 * every reading still standing in an **open** episode by the same `confirmedSpo2`, against the
 * stored readings around it, and withdraws the ones nothing confirms, with
 * `withdrawnReason: 'unconfirmed'`. The portal strikes them through and says why.
 *
 * - **Reviewed episodes are never touched**: the review was made against what they showed.
 *   That is `withdrawReading`'s own rule, and this goes through it.
 * - **Only automatic readings** (`:spo2_automatic:` in the id). A spot check, or a reading
 *   with no id to judge it by, is left standing.
 * - An episode left with nothing standing closes as `withdrawn` and leaves the worklist.
 * - The readings themselves stay in `MetricLog`, so the list on the phone is unchanged.
 * - Notifications already sent stay in the inbox; they are messages, not the record.
 *
 * Every episode this could change is written to `scripts/backups/` before anything is touched.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const VitalAlert = require('../models/VitalAlert');
const VitalTarget = require('../models/VitalTarget');
const MetricLog = require('../models/MetricLog');
const { withdrawReading } = require('../utils/vitalAlertCentre');
const { confirmedSpo2, SPO2_CONFIRM_WINDOW_MIN, DEFAULT_TARGETS } = require('../utils/vitalAlerts');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const valueOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);

const WINDOW_MS = SPO2_CONFIRM_WINDOW_MIN * 60_000;
const iso = (d) => new Date(d).toISOString().replace(/:\d\d\.\d{3}Z$/, 'Z');
const isAutomatic = (r) => typeof r.externalId === 'string' && r.externalId.includes(':spo2_automatic:');

const restore = async (file) => {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const doc of saved) {
        await VitalAlert.replaceOne({ _id: doc._id }, doc);
        console.log(`↩️  restored ${doc._id}`);
    }
};

/** One episode: which standing readings are lone, with the stored readings either side. */
const judge = async (alert) => {
    const target = await VitalTarget.findOne({ userId: alert.userId }).select('spo2Scale lowHeartRateExpected').lean();
    const targets = target ? { spo2Scale: target.spo2Scale, lowHeartRateExpected: Boolean(target.lowHeartRateExpected) } : DEFAULT_TARGETS;

    const standing = alert.readings.filter((r) => !r.withdrawnAt);
    const candidates = standing.filter(isAutomatic).map((r) => ({ ...r, metric: 'spo2' }));
    if (!candidates.length) return { targets, standing, lone: [], around: new Map() };

    const times = candidates.map((r) => new Date(r.measuredAt).getTime());
    const stored = await MetricLog.find({
        userId: alert.userId,
        kind: 'spo2',
        measuredAt: {
            $gte: new Date(Math.min(...times) - 2 * WINDOW_MS),
            $lte: new Date(Math.max(...times) + 2 * WINDOW_MS),
        },
    }).select('measuredAt spo2 externalId').sort({ measuredAt: 1 }).lean();

    const storedIds = new Set(stored.map((r) => r.externalId));
    const pool = [
        ...stored.map((r) => ({ metric: 'spo2', measuredAt: r.measuredAt, spo2: r.spo2, externalId: r.externalId })),
        // A reading the episode holds but the log lost still counts as a neighbour.
        ...standing.filter((r) => !storedIds.has(r.externalId)).map((r) => ({ ...r, metric: 'spo2' })),
    ];
    const confirmed = new Set(confirmedSpo2(candidates, pool, targets).map((r) => r.externalId));
    const lone = candidates.filter((r) => !confirmed.has(r.externalId));

    const around = new Map(candidates.map((c) => {
        const at = new Date(c.measuredAt).getTime();
        const near = stored.filter((s) => Math.abs(new Date(s.measuredAt).getTime() - at) <= 2 * WINDOW_MS);
        return [c.externalId, near.map((s) => (s.externalId === c.externalId ? `[${s.spo2}]` : `${s.spo2}`)).join(' ')];
    }));
    return { targets, standing, lone, around };
};

const run = async () => {
    const user = valueOf('--user');
    const apply = flag('--apply');
    if (apply && !user) throw new Error('--apply needs --user <id>: withdraw one person at a time');

    const alerts = await VitalAlert.find({ metric: 'spo2', isOpen: true, ...(user ? { userId: user } : {}) }).lean();
    console.log(`${alerts.length} open SpO2 episode(s)${user ? ` for ${user}` : ''}`);

    const plan = [];
    for (const alert of alerts) {
        const { targets, standing, lone, around } = await judge(alert);
        const loneIds = new Set(lone.map((r) => r.externalId));
        const left = standing.length - lone.length;
        console.log(`\nEpisode ${alert._id} u=${alert.userId} level=${alert.level} scale=${targets.spo2Scale}`
            + ` standing=${standing.length} lone=${lone.length} → ${left ? `stays open with ${left}` : 'closes as withdrawn'}`);
        for (const r of standing) {
            const mark = loneIds.has(r.externalId) ? 'WITHDRAW' : isAutomatic(r) ? 'confirmed' : 'kept (not automatic)';
            const near = around.get(r.externalId);
            console.log(`  ${iso(r.measuredAt)} ${String(r.spo2).padStart(3)}%  ${mark.padEnd(20)} ${near ? `±3h: ${near}` : ''}`);
        }
        if (lone.length) plan.push({ alert, lone });
    }

    const total = plan.reduce((n, p) => n + p.lone.length, 0);
    if (!apply) {
        console.log(`\nDry run: ${total} reading(s) would be withdrawn. Nothing written. Add --user <id> --apply.`);
        return;
    }
    if (!total) {
        console.log('\nNothing to withdraw.');
        return;
    }

    const dir = path.join(__dirname, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `spo2-lone-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify(plan.map((p) => p.alert), null, 2));
    console.log(`\n💾 Backup: ${file}`);

    for (const { alert, lone } of plan) {
        for (const r of lone) {
            await withdrawReading(alert.userId, { externalId: r.externalId, reason: 'unconfirmed' });
        }
        const after = await VitalAlert.findById(alert._id).lean();
        console.log(`🫁 ${alert._id}: withdrew ${lone.length}; now ${after.status}, level ${after.level},`
            + ` worst ${after.worst?.spo2 ?? '-'}%`);
    }
};

(async () => {
    await connectDB();
    const file = valueOf('--restore');
    await (file ? restore(file) : run());
    await mongoose.disconnect();
})().catch(async (e) => {
    console.error('❌', e.message);
    await mongoose.disconnect();
    process.exit(1);
});
