const ConnectedSource = require('../models/ConnectedSource');
const ActivitySession = require('../models/ActivitySession');
const SleepSession = require('../models/SleepSession');
const HeartRateSample = require('../models/HeartRateSample');
const DailyMetrics = require('../models/DailyMetrics');
const SleepPlan = require('../models/SleepPlan');
const { ingestBatch, ACCEPTED_HR_CONTEXTS } = require('../utils/healthSync');
const scoreController = require('./scoreController');

/** A batch larger than this is a client bug or a first-ever backfill run without paging. */
const MAX_ROWS_PER_BATCH = 2000;

/**
 * GET /api/wearables/status
 *
 * What the client needs before it draws a connect screen: which sources this person has
 * linked, when each last synced, and the cursor to resume from.
 *
 * The server cannot tell whether the phone has HealthKit or Health Connect — that is a
 * device fact the client probes for itself. What it can say is what was connected last
 * time, which is what makes an incremental sync possible after a reinstall.
 */
exports.getStatus = async (req, res) => {
    try {
        const userId = req.user.id;

        const sources = await ConnectedSource.find({ userId }).lean();

        res.json({
            sources: sources.map((s) => ({
                id: s._id,
                platform: s.platform,
                providerLabel: s.providerLabel,
                permissions: s.permissions || [],
                devices: s.devices || [],
                lastSyncAt: s.lastSyncAt || null,
                cursor: s.lastSyncCursor || null,
                status: s.status,
                lastError: s.lastError || null,
            })),
            capabilities: {
                sync: true,
                // Insight generation is the only part of this feature that needs a model
                aiInsight: Boolean(process.env.ANTHROPIC_API_KEY),
            },
            acceptedHeartContexts: ACCEPTED_HR_CONTEXTS,
            maxRowsPerBatch: MAX_ROWS_PER_BATCH,
        });
    } catch (err) {
        console.error('❌ Wearable status failed:', err);
        res.status(500).json({ message: 'Could not read sync status' });
    }
};

/**
 * POST /api/wearables/sync
 *
 * One batch from the device's health store. Idempotent: the client re-sends on every
 * foreground, batches are retried after a dropped connection, and an Apple Watch and its
 * paired iPhone both write the same workout — so the same row arriving twice is normal.
 *
 * The response carries the cursor back so the client can persist it alongside its own copy,
 * and the days that changed so screens already on-screen know to refetch.
 */
exports.sync = async (req, res) => {
    try {
        const userId = req.user.id;
        const {
            platform, tzOffset, cursor, permissions, devices,
            activities = [], sleep = [], heart = [], days = [],
        } = req.body || {};

        if (!['apple_health', 'health_connect', 'aggregator'].includes(platform)) {
            return res.status(400).json({ message: 'Unknown platform' });
        }

        const total = activities.length + sleep.length + heart.length + days.length;
        if (total > MAX_ROWS_PER_BATCH) {
            return res.status(413).json({
                message: `Batch too large: ${total} rows. Page at ${MAX_ROWS_PER_BATCH}.`,
                maxRowsPerBatch: MAX_ROWS_PER_BATCH,
            });
        }

        // The sleep goal shapes every night's score, so it has to be read before the nights
        // are written rather than backfilled afterwards.
        const plan = await SleepPlan.findOne({ userId }).select('goalMinutes').lean();

        const result = await ingestBatch({
            userId,
            platform,
            tzOffset,
            activities,
            sleep,
            heart,
            days,
            goalMinutes: plan?.goalMinutes,
        });

        await ConnectedSource.findOneAndUpdate(
            { userId, platform },
            {
                $set: {
                    lastSyncAt: new Date(),
                    lastSyncCursor: cursor ?? null,
                    status: 'connected',
                    lastError: null,
                    ...(permissions ? { permissions } : {}),
                    ...(devices ? { devices } : {}),
                    ...(req.body.providerLabel ? { providerLabel: req.body.providerLabel } : {}),
                },
                $setOnInsert: { userId, platform },
            },
            { upsert: true, new: true }
        );

        console.log(
            `🔄 Sync ${platform} u=${userId} ` +
            `a=${result.counts.activities} s=${result.counts.sleep} ` +
            `h=${result.counts.heart} d=${result.counts.days} → ${result.days.length} days`
        );

        // A sync is the single biggest mover of the score — it is the moment a month of
        // activity, sleep and heart data lands. Fired after the response is shaped so the
        // client is never waiting on a recalculation it did not ask for.
        scoreController.touch(userId, 'sync', { tzOffset: Number(req.body.tzOffset) || 0 });

        res.json({
            received: result.counts,
            daysUpdated: result.days,
            // Named so a client author sees it: raw continuous readings are dropped on
            // purpose, and silently swallowing them would look like data loss.
            rejectedHeartSamples: result.rejectedHeartSamples,
        });
    } catch (err) {
        console.error('❌ Sync failed:', err);
        res.status(500).json({ message: 'Could not sync health data' });
    }
};

/** GET /api/wearables/sources — the connected-device screen. */
exports.listSources = async (req, res) => {
    try {
        const sources = await ConnectedSource.find({ userId: req.user.id }).lean();
        res.json({ sources });
    } catch (err) {
        console.error('❌ Listing sources failed:', err);
        res.status(500).json({ message: 'Could not list sources' });
    }
};

/**
 * DELETE /api/wearables/sources/:id
 *
 * Disconnecting stops future syncs. It does **not** delete what was already imported unless
 * `?purge=true` — someone unlinking a watch they no longer own should not lose two years of
 * their own history as a side effect. Purging is offered, but it is a separate decision the
 * person has to make explicitly.
 */
exports.disconnectSource = async (req, res) => {
    try {
        const userId = req.user.id;
        const source = await ConnectedSource.findOne({ _id: req.params.id, userId });
        if (!source) return res.status(404).json({ message: 'Source not found' });

        let purged = null;
        if (String(req.query.purge) === 'true') {
            const filter = { userId, source: source.platform };
            const [a, s, h] = await Promise.all([
                ActivitySession.deleteMany(filter),
                SleepSession.deleteMany(filter),
                HeartRateSample.deleteMany(filter),
            ]);
            purged = {
                activities: a.deletedCount,
                sleep: s.deletedCount,
                heart: h.deletedCount,
            };
            // The rollups now describe rows that are gone. Clearing them is safe: the next
            // read recomputes from whatever is left.
            await DailyMetrics.deleteMany({ userId });
        }

        await source.deleteOne();
        console.log(`🔌 Disconnected ${source.platform} for u=${userId}${purged ? ' (purged)' : ''}`);

        res.json({ message: 'Source disconnected', purged });
    } catch (err) {
        console.error('❌ Disconnect failed:', err);
        res.status(500).json({ message: 'Could not disconnect source' });
    }
};

exports._MAX_ROWS_PER_BATCH = MAX_ROWS_PER_BATCH;
