/**
 * Join sleep that was stored in pieces — and split what an older rule joined.
 *
 *   node scripts/stitchSleep.js                     # dry run — prints, writes nothing
 *   node scripts/stitchSleep.js --apply
 *   node scripts/stitchSleep.js --user <id> --apply # one person
 *   node scripts/stitchSleep.js --restore <file>    # undo, from a backup this wrote
 *   ... --tz <minutes>                              # override the person's offset
 *
 * Since 2026-10-01 a morning wake ends the night sooner (`utils/sleepStitch.js` rule 1b),
 * so a nap the 30-minute rule joined to the night is split back out. That rule needs the
 * person's local clock: it is taken from their latest push registration, and with none the
 * morning rule is off for them, exactly as it was before.
 *
 * The J-Style bracelet reports a night as records of about two hours each, and until
 * `utils/sleepStitch.js` existed every record was stored as a night of its own — so a
 * 00:23–07:05 night was four rows, the "night" was the longest block, and the rest were thrown
 * away or called naps. Syncs join them now, and a sync also heals the twelve hours around
 * what it carries; this repairs everything older.
 *
 * It runs exactly what a sync runs — `healthSync.joinSleep` with an empty batch over the
 * person's whole history — so a repaired night and a freshly synced one cannot differ. The
 * bracelet deletes what it has synced, so these rows are the only copy: every row this could
 * change is written to `scripts/backups/` before anything is touched.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const SleepSession = require('../models/SleepSession');
const SleepPlan = require('../models/SleepPlan');
const User = require('../models/userModel');
const { joinSleep, recomputeDay } = require('../utils/healthSync');
const { clusterSessions, STITCH_GAP_MIN } = require('../utils/sleepStitch');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const valueOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);

const hhmm = (d) => new Date(d).toISOString().slice(11, 16);

const restore = async (file) => {
    const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const entry of journal) {
        const ids = entry.before.map((r) => r.externalId);
        // Whatever the join wrote for this person and source, over the same span.
        const removed = await SleepSession.deleteMany({
            userId: entry.userId,
            source: entry.source,
            externalId: { $type: 'string' },
            startedAt: { $gte: new Date(entry.from) },
            endedAt: { $lte: new Date(entry.to) },
        });
        await SleepSession.insertMany(entry.before, { ordered: false });
        for (const day of new Set(entry.before.map((r) => r.day))) {
            await recomputeDay(new mongoose.Types.ObjectId(entry.userId), day);
        }
        console.log(`♻️  ${entry.userId} ${entry.source}: removed ${removed.deletedCount}, restored ${ids.length}`);
    }
};

const run = async () => {
    await connectDB();

    const restoreFile = valueOf('--restore');
    if (restoreFile) {
        await restore(restoreFile);
        return;
    }

    const apply = flag('--apply');
    const only = valueOf('--user');

    const filter = { source: { $ne: 'manual' }, externalId: { $type: 'string' } };
    if (only) filter.userId = new mongoose.Types.ObjectId(only);
    const groups = await SleepSession.aggregate([
        { $match: filter },
        { $group: { _id: { userId: '$userId', source: '$source' } } },
    ]);

    const journal = [];
    const backupFile = path.join(__dirname, 'backups', `sleep-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    let affectedGroups = 0;
    let joinable = 0;

    for (const { _id: { userId, source } } of groups) {
        const rows = await SleepSession.find({ userId, source, externalId: { $type: 'string' } })
            .sort({ startedAt: 1 }).lean();

        // The morning rule (`sleepStitch` rule 1b) needs the person's clock. The phone sends
        // its offset with every push registration; the latest one is the best there is.
        const user = await User.findById(userId).select('pushTokens.tzOffset').lean();
        const offsets = (user?.pushTokens || []).map((t) => t.tzOffset).filter(Number.isFinite);
        const tzOffset = valueOf('--tz') !== null ? Number(valueOf('--tz')) : (offsets.at(-1) ?? null);

        // Every stored piece, regrouped by today's rule, against how the rows group them now.
        const pieces = rows.flatMap((r) => (r.parts?.length ? r.parts : [r]).map((p) => ({ ...p, row: r })));
        const clusters = clusterSessions(pieces, STITCH_GAP_MIN, { tzOffset });
        const joins = clusters.filter((c) => new Set(c.map((p) => String(p.row._id))).size > 1);
        const rowsSplit = rows.filter((r) => new Set(
            clusters.filter((c) => c.some((p) => p.row === r)),
        ).size > 1);
        if (!joins.length && !rowsSplit.length) continue;

        affectedGroups += 1;
        joinable += joins.length + rowsSplit.length;
        console.log(`\n👤 ${userId} ${source} (tzOffset ${tzOffset ?? 'unknown — morning rule off'}):`);
        for (const c of joins) {
            const ids = new Set(c.map((p) => String(p.row._id)));
            const asleep = c.reduce((n, p) => n + (p.asleepMin || 0), 0);
            console.log(`   join   ${c[0].row.day}  ${hhmm(c[0].startedAt)}→${hhmm(c[c.length - 1].endedAt)} UTC  `
                + `${ids.size} rows → one sleep of ${asleep}m`);
        }
        for (const r of rowsSplit) {
            const parts = clusters.filter((c) => c.some((p) => p.row === r))
                .map((c) => `${hhmm(c[0].startedAt)}→${hhmm(c[c.length - 1].endedAt)} ${c.reduce((n, p) => n + (p.asleepMin || 0), 0)}m`);
            console.log(`   split  ${r.day}  ${r.asleepMin}m → ${parts.join(' + ')} UTC`);
        }

        if (!apply) continue;

        const from = new Date(rows[0].startedAt.getTime() - 60_000);
        const to = new Date(Math.max(...rows.map((r) => r.endedAt.getTime())) + 60_000);
        journal.push({ userId: String(userId), source, from, to, before: rows });
        // Written before every change, not after the last: a run that dies halfway must still
        // leave the rows it already changed recoverable.
        fs.mkdirSync(path.dirname(backupFile), { recursive: true });
        fs.writeFileSync(backupFile, JSON.stringify(journal, null, 2));

        const plan = await SleepPlan.findOne({ userId }).select('goalMinutes').lean();
        const days = await joinSleep(userId, [], {
            source, tzOffset: tzOffset ?? undefined, goalMinutes: plan?.goalMinutes, window: { from, to },
        });
        for (const day of days) await recomputeDay(userId, day);
        const after = await SleepSession.countDocuments({ userId, source, externalId: { $type: 'string' } });
        console.log(`   ✅ ${rows.length} rows → ${after}; ${days.size} day(s) recomputed`);
    }

    console.log(`\n${affectedGroups} person/source group(s), ${joinable} sleep(s) to join or split.`);
    if (!apply) {
        console.log('Dry run — nothing written. Re-run with --apply.');
        return;
    }
    if (journal.length) {
        console.log(`💾 Backup: ${backupFile}\n   Undo with: node scripts/stitchSleep.js --restore ${backupFile}`);
    }
};

run()
    .catch((err) => { console.error('❌', err); process.exitCode = 1; })
    .finally(() => mongoose.disconnect());
