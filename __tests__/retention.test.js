/**
 * Interpretation retention.
 *
 * The sweep is the one piece of this system that deletes medical records, so what matters
 * is everything it refuses to touch: anything a clinician signed, the newest read, and the
 * per-user floor that keeps a delta computable.
 */
const mongoose = require('mongoose');
const Interpretation = require('../models/Interpretation');
const { runRetentionSweep } = require('../jobs/retentionSweep');
const { DRAFT_RETENTION_DAYS, MIN_DRAFTS_KEPT } = require('../config/retention');

const DAY = 24 * 60 * 60 * 1000;
const silent = () => {};
const userId = new mongoose.Types.ObjectId();
const old = (extraDays = 30) => new Date(Date.now() - (DRAFT_RETENTION_DAYS + extraDays) * DAY);

const draft = (generatedAt, status = 'pending') => Interpretation.create({
    userId, generatedAt, content: { summary: String(generatedAt) }, review: { status },
});

describe('runRetentionSweep', () => {
    it('does nothing when everything is recent', async () => {
        for (let i = 0; i < 3; i++) await draft(new Date(Date.now() - i * DAY));

        const stats = await runRetentionSweep({ log: silent });
        expect(stats.deleted).toBe(0);
        expect(await Interpretation.countDocuments({ userId })).toBe(3);
    });

    it('never deletes a reviewed interpretation, however old', async () => {
        await draft(old(400), 'approved');
        await draft(old(300), 'amended');
        // Old unreviewed drafts alongside them, so the sweep genuinely examines this user
        // and the reviewed rows survive a pass that is actively deleting.
        for (let i = 0; i < MIN_DRAFTS_KEPT + 3; i++) await draft(old(100 + i));

        const stats = await runRetentionSweep({ log: silent });

        expect(stats.deleted).toBeGreaterThan(0);
        expect(stats.keptReviewed).toBe(2);
        expect(await Interpretation.countDocuments({ userId, 'review.status': 'approved' })).toBe(1);
        expect(await Interpretation.countDocuments({ userId, 'review.status': 'amended' })).toBe(1);
    });

    it('keeps the newest read even when it is older than the window', async () => {
        await draft(old(500));

        const stats = await runRetentionSweep({ log: silent });
        expect(stats.deleted).toBe(0);
        expect(await Interpretation.countDocuments({ userId })).toBe(1);
    });

    it('keeps the per-user floor of drafts', async () => {
        for (let i = 0; i < MIN_DRAFTS_KEPT + 4; i++) await draft(old(100 + i));

        await runRetentionSweep({ log: silent });
        expect(await Interpretation.countDocuments({ userId })).toBe(MIN_DRAFTS_KEPT);
    });

    it('prunes the oldest first, keeping the most recent drafts', async () => {
        const total = MIN_DRAFTS_KEPT + 3;
        // Keep the created rows: `old()` is relative to now, so recomputing it later drifts.
        const created = [];
        for (let i = 0; i < total; i++) created.push(await draft(old(100 + i)));

        await runRetentionSweep({ log: silent });

        const survivors = await Interpretation.find({ userId }).sort({ generatedAt: -1 }).lean();
        expect(survivors).toHaveLength(MIN_DRAFTS_KEPT);
        // created[0] is the newest, so it must be the newest survivor.
        expect(String(survivors[0]._id)).toBe(String(created[0]._id));
        // ...and the oldest of the original set is gone.
        expect(survivors.map((s2) => String(s2._id))).not.toContain(String(created[total - 1]._id));
    });

    it('repairs the supersedes chain rather than leaving a dangling reference', async () => {
        const a = await draft(old(300));
        const b = await draft(old(200));
        await Interpretation.updateOne({ _id: b._id }, { $set: { supersedes: a._id } });
        // Enough newer drafts that a and b both fall outside the floor.
        let prev = b._id;
        for (let i = 0; i < MIN_DRAFTS_KEPT; i++) {
            const n = await draft(new Date(Date.now() - i * DAY));
            await Interpretation.updateOne({ _id: n._id }, { $set: { supersedes: prev } });
            prev = n._id;
        }

        await runRetentionSweep({ log: silent });

        const remaining = await Interpretation.find({ userId }).lean();
        const ids = new Set(remaining.map((r) => String(r._id)));
        for (const row of remaining) {
            if (row.supersedes) expect(ids.has(String(row.supersedes))).toBe(true);
        }
    });

    it('writes nothing on a dry run', async () => {
        for (let i = 0; i < MIN_DRAFTS_KEPT + 3; i++) await draft(old(100 + i));

        const stats = await runRetentionSweep({ dry: true, log: silent });
        expect(stats.deleted).toBeGreaterThan(0);
        expect(await Interpretation.countDocuments({ userId })).toBe(MIN_DRAFTS_KEPT + 3);
    });

    it('does not touch another user\'s history', async () => {
        const other = new mongoose.Types.ObjectId();
        for (let i = 0; i < MIN_DRAFTS_KEPT + 3; i++) {
            await Interpretation.create({ userId: other, generatedAt: old(100 + i), content: {}, review: { status: 'pending' } });
        }
        await draft(new Date());

        await runRetentionSweep({ log: silent });
        expect(await Interpretation.countDocuments({ userId })).toBe(1);
    });
});
