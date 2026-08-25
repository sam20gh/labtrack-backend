/**
 * Prune superseded interpretation drafts.
 *
 * Deliberately conservative. Everything this deletes is an unreviewed draft that a newer
 * interpretation has already replaced — never a reviewed one, never the newest, never
 * anything within the per-user floor. In a medical product the cost of deleting one record
 * too many is not symmetric with the cost of keeping one too long.
 *
 * `supersedes` chains are repaired as it goes: deleting a middle link would otherwise leave
 * the row above it pointing at nothing.
 */
const Interpretation = require('../models/Interpretation');
const { DRAFT_RETENTION_DAYS, MIN_DRAFTS_KEPT, PERMANENT_STATUSES } = require('../config/retention');

const DAY = 24 * 60 * 60 * 1000;

/**
 * @param {{ dry?: boolean, now?: Date, log?: Function }} options
 * @returns {Promise<{ examined: number, deleted: number, keptReviewed: number, users: number }>}
 */
const runRetentionSweep = async ({ dry = false, now = new Date(), log = console.log } = {}) => {
    const cutoff = new Date(now.getTime() - DRAFT_RETENTION_DAYS * DAY);
    const stats = { examined: 0, deleted: 0, keptReviewed: 0, users: 0 };

    // Only users who actually hold an old draft — no point walking the whole collection.
    const userIds = await Interpretation.distinct('userId', {
        generatedAt: { $lt: cutoff },
        'review.status': { $nin: PERMANENT_STATUSES },
    });
    stats.users = userIds.length;

    for (const userId of userIds) {
        const all = await Interpretation.find({ userId })
            .sort({ generatedAt: -1 })
            .select('_id generatedAt review.status supersedes')
            .lean();

        stats.examined += all.length;

        const deletable = all
            // The newest is what the person reads, so index 0 is never a candidate.
            .slice(1)
            .filter((i) => {
                if (PERMANENT_STATUSES.includes(i.review?.status)) {
                    stats.keptReviewed++;
                    return false;
                }
                return new Date(i.generatedAt) < cutoff;
            });

        // Keep the floor. `deletable` runs newest-first, so keeping its head keeps the most
        // recent drafts and deleting its tail takes the oldest — slicing the other way round
        // prunes exactly the wrong end.
        const keepCount = Math.max(0, MIN_DRAFTS_KEPT - (all.length - deletable.length));
        const toDelete = deletable.slice(keepCount);
        if (!toDelete.length) continue;

        const ids = toDelete.map((i) => i._id);
        const idSet = new Set(ids.map(String));

        if (dry) {
            log(`  would prune ${ids.length} draft(s) for user ${userId}`);
        } else {
            // Repair the chain before deleting, so nothing is left pointing at a gap.
            for (const row of all) {
                if (idSet.has(String(row._id)) || !row.supersedes) continue;
                if (!idSet.has(String(row.supersedes))) continue;

                // Walk back to the first surviving ancestor.
                let target = row.supersedes;
                let guard = 0;
                while (target && idSet.has(String(target)) && guard++ < all.length) {
                    target = all.find((a) => String(a._id) === String(target))?.supersedes || null;
                }
                await Interpretation.updateOne({ _id: row._id }, { $set: { supersedes: target || null } });
            }

            await Interpretation.deleteMany({ _id: { $in: ids } });
        }

        stats.deleted += ids.length;
    }

    log(
        `🧹 Retention sweep${dry ? ' (dry)' : ''}: ` +
        `${stats.deleted} draft(s) pruned across ${stats.users} user(s); ` +
        `${stats.keptReviewed} reviewed interpretation(s) kept.`
    );
    return stats;
};

const scheduleRetentionSweep = () => {
    const cron = require('node-cron');

    // 03:30, after the status sweep and well before the morning reminder run.
    cron.schedule('30 3 * * *', () => {
        runRetentionSweep().catch((e) => console.error('❌ Retention sweep failed:', e.message));
    });

    console.log('📅 Interpretation retention sweep scheduled (daily 03:30)');
};

module.exports = { runRetentionSweep, scheduleRetentionSweep };
