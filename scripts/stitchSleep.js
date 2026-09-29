/**
 * Join sleep that was stored in pieces.
 *
 *   node scripts/stitchSleep.js                     # dry run — prints, writes nothing
 *   node scripts/stitchSleep.js --apply
 *   node scripts/stitchSleep.js --user <id> --apply # one person
 *   node scripts/stitchSleep.js --restore <file>    # undo, from a backup this wrote
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
        const clusters = clusterSessions(rows, STITCH_GAP_MIN).filter((c) => c.length > 1);
        if (!clusters.length) continue;

        affectedGroups += 1;
        joinable += clusters.reduce((n, c) => n + c.length, 0);
        console.log(`\n👤 ${userId} ${source}: ${clusters.length} sleep(s) stored in pieces`);
        for (const c of clusters) {
            const asleep = c.reduce((n, r) => n + (r.asleepMin || 0), 0);
            const longest = Math.max(...c.map((r) => r.asleepMin || 0));
            console.log(
                `   ${c[0].day}  ${hhmm(c[0].startedAt)}→${hhmm(c[c.length - 1].endedAt)} UTC  `
                + `${c.length} rows · shown as ${longest}m, actually ${asleep}m asleep`
            );
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
            source, tzOffset: 0, goalMinutes: plan?.goalMinutes, window: { from, to },
        });
        for (const day of days) await recomputeDay(userId, day);
        const after = await SleepSession.countDocuments({ userId, source, externalId: { $type: 'string' } });
        console.log(`   ✅ ${rows.length} rows → ${after}; ${days.size} day(s) recomputed`);
    }

    console.log(`\n${affectedGroups} person/source group(s), ${joinable} row(s) in pieces.`);
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
