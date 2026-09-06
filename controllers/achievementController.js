/**
 * Achievements, the leaderboard, and the share card.
 *
 * Three rules run through every handler here, and each of them is a decision that could
 * reasonably have gone the other way:
 *
 *   1. **Progress is derived, unlocks are stored.** Every number on the screen is recomputed
 *      from the trackers' own rows on each read — there is no counter to drift. The *unlock*
 *      is a row, because progress can fall when somebody deletes their own data and a badge
 *      must never be taken back. See the note on `AchievementUnlock`.
 *   2. **The leaderboard is opt-in and holds no health data.** See `AchievementProfile`.
 *   3. **A share link is a public URL, so it carries only what the person chose to publish.**
 *      The badge, its description, the display name and the date. Never a value, never a
 *      result, never an email. `cardForToken` is the only unauthenticated handler in this
 *      file and it is deliberately the smallest.
 */
const AchievementUnlock = require('../models/AchievementUnlock');
const AchievementProfile = require('../models/AchievementProfile');
const User = require('../models/userModel');
const engine = require('../utils/achievementEngine');
const { BY_KEY, CATEGORIES, MAX_POINTS, describe, grade, instruction } = require('../utils/achievementCatalogue');

/**
 * Where a shared badge lands.
 *
 * The card is a public web page with Open Graph tags, served by the portal — that is what
 * makes a link unfurl into the badge inside WhatsApp, Messages or a Facebook post rather
 * than arriving as a bare URL. Unset, sharing still works and the app falls back to sharing
 * text alone, which is honest: a link to nowhere is worse than no link.
 */
const shareBase = () =>
    (process.env.ACHIEVEMENT_SHARE_URL || (process.env.PORTAL_URL ? `${process.env.PORTAL_URL}/a` : ''))
        .replace(/\/+$/, '');

const shareUrlFor = (token) => (shareBase() ? `${shareBase()}/${token}` : null);

/**
 * The address printed on the card itself.
 *
 * A shared **image** carries no link — that is the point of it, and it is why the card has to
 * say where it came from in its own pixels. Somebody seeing a badge in a group chat has
 * nothing to tap; a host in the corner is the only route back.
 *
 * Derived from the share base rather than written down, so it is always an address that
 * actually resolves. A deployment with neither `ACHIEVEMENT_SHARE_URL` nor `PORTAL_URL` gets
 * **null and no watermark**, rather than a plausible-looking domain nobody owns — the same
 * call every other absent-value in this API makes.
 */
const shareHost = () => {
    const base = shareBase();
    if (!base) return null;
    try {
        return new URL(base).host;
    } catch {
        return null;
    }
};

/* ------------------------------------------------------------------ *
 * Evaluation
 * ------------------------------------------------------------------ */

/**
 * Grade everything, persist anything newly crossed, and merge the two.
 *
 * The merge is the important part. `graded` is what the person's data says right now;
 * `unlocks` is what they have already been told. Where the two disagree the **higher** wins:
 * a stored level 3 stays level 3 even if the live grade has fallen to 2, and a live level 4
 * writes a new row. Nothing here can lower a badge.
 */
const evaluate = async (userId, { now = Date.now() } = {}) => {
    const graded = await engine.evaluate(userId, { now });
    const unlocks = await AchievementUnlock.find({ userId }).lean();

    const stored = new Map();
    for (const row of unlocks) {
        const best = stored.get(row.key);
        if (!best || row.level > best.level) stored.set(row.key, row);
    }

    const fresh = [];
    for (const item of graded.achievements) {
        const achievement = BY_KEY.get(item.key);
        const held = stored.get(item.key);
        const heldLevel = held?.level || 0;

        // Every level between what they held and what they have now — crossing two
        // thresholds in one sync should award two badges, not skip one.
        for (let level = heldLevel + 1; level <= item.level; level += 1) {
            fresh.push({
                userId,
                key: item.key,
                level,
                threshold: achievement.levels[level - 1],
                value: item.value,
                points: achievement.points,
                unlockedAt: new Date(now),
            });
        }

        if (heldLevel > item.level) {
            // The stored row is ahead: their data shrank. Show what they were told.
            item.level = heldLevel;
            item.unlocked = true;
            item.threshold = held.threshold;
            item.points = achievement.points * heldLevel;
            item.next = achievement.levels[heldLevel] ?? null;
            item.progress = item.next === null ? 1 : 0;
            item.how = instruction(achievement, item.next ?? achievement.levels[achievement.levels.length - 1]);
        }

        item.unlockedAt = held?.unlockedAt || null;
        item.shareToken = held?.shareToken || null;
    }

    if (fresh.length) {
        // Unordered so one duplicate — two evaluations racing on the same threshold — does
        // not discard the rest of the batch. The unique index is what makes that safe.
        try {
            await AchievementUnlock.insertMany(fresh, { ordered: false });
        } catch (err) {
            if (err.code !== 11000) throw err;
        }
        console.log(`🏅 ${fresh.length} new achievement level(s) for ${userId}`);
    }

    // Recount from the merged view rather than from `graded`, which predates the merge.
    const points = graded.achievements.reduce((sum, a) => sum + a.points, 0);
    const unlockedCount = graded.achievements.filter((a) => a.unlocked).length;

    await refreshProfile(userId, { points, unlockedCount });

    return { ...graded, points, unlocked: unlockedCount, fresh: fresh.length };
};

/**
 * Keep the leaderboard row in step with the badges.
 *
 * Upserted rather than created on opt-in, so somebody's points are already correct the
 * moment they join the board instead of being zero until their next sync. `optedIn` is
 * untouched here — only the person can change that.
 */
const refreshProfile = async (userId, { points, unlockedCount }) => {
    const user = await User.findById(userId).select('firstName profileImage').lean();
    return AchievementProfile.findOneAndUpdate(
        { userId },
        {
            $set: { points, unlockedCount, avatar: user?.profileImage || null, computedAt: new Date() },
            $setOnInsert: { displayName: (user?.firstName || '').slice(0, 40), optedIn: false },
        },
        { upsert: true, new: true },
    );
};

/**
 * Re-evaluate in the background after something was logged.
 *
 * Exactly `scoreController.touch`, for exactly the same reason: not awaited, swallows its
 * own failures. Somebody who has just logged a meal gets their 201 whether or not a badge
 * was worked out, and a bug in the catalogue must never be able to fail the write the person
 * actually made.
 */
const touch = (userId) => {
    setImmediate(async () => {
        try {
            await evaluate(userId);
        } catch (err) {
            console.error(`⚠️ Background achievement evaluation failed for ${userId}:`, err.message);
        }
    });
};

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

/**
 * `GET /api/achievements`
 *
 * The hub. Everything the Achievement tab draws, plus any unlock the person has not been
 * shown yet — that is what fires the celebration, and it is a list rather than a boolean
 * because a week away can earn several at once.
 */
exports.getAchievements = async (req, res) => {
    try {
        const userId = req.auth.userId;
        const result = await evaluate(userId);

        const unseen = await AchievementUnlock.find({ userId, seen: false })
            .sort({ unlockedAt: 1 })
            .lean();

        const recent = await AchievementUnlock.find({ userId })
            .sort({ unlockedAt: -1 })
            .limit(6)
            .lean();

        res.json({
            summary: {
                unlocked: result.unlocked,
                total: result.total,
                points: result.points,
                maxPoints: MAX_POINTS,
            },
            achievements: result.achievements,
            categories: CATEGORIES,
            /** Newly earned and never shown. The client posts `/seen` once it has. */
            celebrate: unseen.map(celebrationOf).filter(Boolean),
            recent: recent.map(celebrationOf).filter(Boolean),
        });
    } catch (err) {
        console.error('❌ getAchievements failed:', err);
        res.status(500).json({ message: 'Could not load your achievements', error: err.message });
    }
};

/** An unlock row, in the shape the celebration modal and the "recent" rail want. */
const celebrationOf = (row) => {
    const achievement = BY_KEY.get(row.key);
    if (!achievement) return null; // a retired catalogue entry — skip, never crash
    return {
        ...describe(achievement),
        level: row.level,
        threshold: row.threshold,
        unlockedAt: row.unlockedAt,
        points: row.points,
        how: instruction(achievement, row.threshold),
    };
};

/**
 * `POST /api/achievements/seen`
 *
 * Marks celebrations as shown. Body may name keys; with none, everything unseen is cleared,
 * which is what the client does when someone dismisses the last modal in a run.
 */
exports.markSeen = async (req, res) => {
    try {
        const filter = { userId: req.auth.userId, seen: false };
        if (Array.isArray(req.body?.keys) && req.body.keys.length) filter.key = { $in: req.body.keys };

        const { modifiedCount } = await AchievementUnlock.updateMany(filter, { $set: { seen: true } });
        res.json({ marked: modifiedCount });
    } catch (err) {
        console.error('❌ markSeen failed:', err);
        res.status(500).json({ message: 'Could not update your achievements', error: err.message });
    }
};

/**
 * `GET /api/achievements/:key`
 *
 * One badge, its levels, and every level this person has reached. The detail screen draws
 * the whole ladder, not only the current rung — "Level 2, next milestone" needs both.
 */
exports.getAchievement = async (req, res) => {
    try {
        const achievement = BY_KEY.get(req.params.key);
        if (!achievement) return res.status(404).json({ message: 'No such achievement' });

        const userId = req.auth.userId;
        const facts = await engine.gather(userId);
        const metrics = engine.measure(facts);
        const live = grade(achievement, metrics[achievement.metric]);

        const rows = await AchievementUnlock.find({ userId, key: achievement.key })
            .sort({ level: 1 })
            .lean();

        const held = rows.length ? rows[rows.length - 1] : null;
        const level = Math.max(live.level, held?.level || 0);

        // Built by the same function `cardForToken` uses, so the preview cannot promise
        // something different from what the public page publishes.
        const profile = await AchievementProfile.findOne({ userId })
            .select('displayName avatar optedIn')
            .lean();

        res.json({
            ...describe(achievement),
            ...live,
            ...publicPerson(profile),
            /** Printed in the card's corner. Null on a deployment with no share URL. */
            shareHost: shareHost(),
            level,
            unlocked: level > 0,
            unlockedAt: held?.unlockedAt || null,
            shareToken: held?.shareToken || null,
            shareUrl: held?.shareToken ? shareUrlFor(held.shareToken) : null,
            /** Every rung, with the date each was reached. */
            ladder: achievement.levels.map((threshold, i) => {
                const row = rows.find((r) => r.level === i + 1);
                return {
                    level: i + 1,
                    threshold,
                    how: instruction(achievement, threshold),
                    reached: Boolean(row) || level > i,
                    reachedAt: row?.unlockedAt || null,
                };
            }),
        });
    } catch (err) {
        console.error('❌ getAchievement failed:', err);
        res.status(500).json({ message: 'Could not load that achievement', error: err.message });
    }
};

/**
 * `POST /api/achievements/:key/share`
 *
 * Mints a share token for a badge the caller has actually unlocked, and returns the public
 * URL. Idempotent: sharing twice returns the same link, so a card already sent in a chat
 * keeps working.
 *
 * A locked badge is a **409**, not a 403: the request is well formed and the caller is
 * entitled to it, there is simply nothing yet to share.
 */
exports.shareAchievement = async (req, res) => {
    try {
        const achievement = BY_KEY.get(req.params.key);
        if (!achievement) return res.status(404).json({ message: 'No such achievement' });

        const userId = req.auth.userId;
        const held = await AchievementUnlock.find({ userId, key: achievement.key })
            .sort({ level: -1 })
            .limit(1);

        if (!held.length) {
            return res.status(409).json({
                message: 'You have not unlocked this achievement yet',
                code: 'not_unlocked',
            });
        }

        const row = held[0];
        if (!row.shareToken) {
            row.shareToken = AchievementUnlock.mintToken();
            row.sharedAt = new Date();
            await row.save();
        }

        const url = shareUrlFor(row.shareToken);
        console.log(`🔗 Share link ${url ? 'issued' : 'requested with no ACHIEVEMENT_SHARE_URL set'} for ${achievement.key}`);

        res.json({
            token: row.shareToken,
            url,
            shareHost: shareHost(),
            /** The words the app puts in the share sheet, so both clients say the same thing. */
            message: `I just unlocked ${achievement.name} on LabTrack — ${instruction(achievement, row.threshold).toLowerCase()}.`,
            level: row.level,
        });
    } catch (err) {
        console.error('❌ shareAchievement failed:', err);
        res.status(500).json({ message: 'Could not create a share link', error: err.message });
    }
};

/**
 * `DELETE /api/achievements/:key/share`
 *
 * Revokes the link. The badge is untouched; only the public page stops resolving. Somebody
 * who shared a card and thought better of it has to be able to take the page down, and
 * deleting the achievement to do it would be an absurd price.
 */
exports.revokeShare = async (req, res) => {
    try {
        const { modifiedCount } = await AchievementUnlock.updateMany(
            { userId: req.auth.userId, key: req.params.key, shareToken: { $ne: null } },
            { $set: { shareToken: null, sharedAt: null } },
        );
        res.json({ revoked: modifiedCount });
    } catch (err) {
        console.error('❌ revokeShare failed:', err);
        res.status(500).json({ message: 'Could not revoke that link', error: err.message });
    }
};

/**
 * The `person` block on a share card, and the single definition of it.
 *
 * **A name is published only by somebody who chose to be visible.** `AchievementProfile` seeds
 * `displayName` from the account's first name so the leaderboard opt-in has something to show
 * in its field — but a seeded value is not a choice, and publishing it on a page anyone with
 * the link can open would put a real first name on the internet because somebody tapped Share.
 * So it is gated on `optedIn`, exactly as the avatar is: the one screen that asks for that
 * consent is the leaderboard switch, which names what becomes visible before it is flipped.
 *
 * Without it the card reads "A LabTrack member", which is a complete card — the badge is the
 * subject, not the person.
 *
 * This is shared with `getAchievement` so the preview the app draws before sharing is built
 * from the same function as the thing that gets published. `ShareCard.tsx` and the portal's
 * Open Graph image are already two drawings of one design; they must at least be drawing the
 * same facts.
 */
const publicPerson = (profile) => ({
    person: {
        name: profile?.optedIn ? profile?.displayName || null : null,
        avatar: profile?.optedIn ? profile?.avatar || null : null,
    },
});

/**
 * `GET /api/achievements/card/:token` — **public, unauthenticated**
 *
 * What a share link resolves to. This is the only handler in the API that answers a request
 * carrying no token at all, so what it returns is the whole of what sharing a badge
 * publishes:
 *
 *   - the badge's name, artwork and what it took to earn
 *   - the display name the person chose for the leaderboard, or nothing
 *   - the month it was earned
 *
 * It returns no user id, no email, no avatar unless the person opted into a public profile,
 * and nothing whatsoever about their health. A 404 for an unknown or revoked token, with no
 * distinction between the two — telling a stranger that a token *used* to work is telling
 * them something about somebody.
 */
exports.cardForToken = async (req, res) => {
    try {
        const row = await AchievementUnlock.findOne({ shareToken: req.params.token }).lean();
        if (!row) return res.status(404).json({ message: 'This link is no longer available' });

        const achievement = BY_KEY.get(row.key);
        if (!achievement) return res.status(404).json({ message: 'This link is no longer available' });

        const profile = await AchievementProfile.findOne({ userId: row.userId })
            .select('displayName avatar optedIn')
            .lean();

        res.set('Cache-Control', 'public, max-age=300');
        res.json({
            ...publicPerson(profile),
            badge: {
                name: achievement.name,
                shape: achievement.shape,
                glyph: achievement.glyph,
                tone: CATEGORIES[achievement.category].tone,
                categoryLabel: CATEGORIES[achievement.category].label,
            },
            level: row.level,
            how: instruction(achievement, row.threshold),
            // Month, not day: the exact date of a health-app action is more than a public
            // page needs, and "November 2025" is what the design prints anyway.
            earned: new Date(row.unlockedAt).toISOString().slice(0, 7),
            shareHost: shareHost(),
        });
    } catch (err) {
        console.error('❌ cardForToken failed:', err);
        res.status(500).json({ message: 'Could not load that card' });
    }
};

/**
 * `GET /api/achievements/leaderboard`
 *
 * The top of the board, plus where the caller stands. Someone who has not opted in still
 * gets their own points and a rank of `null` — the board is shown so they can decide whether
 * to join it, and hiding their own number until they do would make that a blind choice.
 */
const BOARD_LIMIT = 25;

exports.getLeaderboard = async (req, res) => {
    try {
        const userId = req.auth.userId;
        const mine = await AchievementProfile.findOne({ userId }).lean();

        const board = await AchievementProfile.find({ optedIn: true })
            .sort({ points: -1, computedAt: 1 })
            .limit(BOARD_LIMIT)
            .select('userId displayName avatar points unlockedCount')
            .lean();

        // Rank by counting everyone ahead, which is correct past the first page and cheap
        // on the compound index. Ties share a rank, so two people on 400 points are both 7th.
        const rank = mine?.optedIn
            ? await AchievementProfile.countDocuments({ optedIn: true, points: { $gt: mine.points } }) + 1
            : null;

        const participants = await AchievementProfile.countDocuments({ optedIn: true });

        res.json({
            board: board.map((row, i) => ({
                rank: i + 1,
                name: row.displayName || 'LabTrack member',
                avatar: row.avatar,
                points: row.points,
                unlocked: row.unlockedCount,
                isYou: String(row.userId) === String(userId),
            })),
            you: {
                optedIn: Boolean(mine?.optedIn),
                displayName: mine?.displayName || '',
                points: mine?.points || 0,
                unlocked: mine?.unlockedCount || 0,
                rank,
            },
            participants,
            /**
             * Shown above the board, always. A scoreboard in a health app has to say what it
             * is counting, or somebody will read a low position as a statement about them.
             */
            disclaimer:
                'Points count what you have done in the app — sessions recorded, meals logged, '
                + 'doses taken. They say nothing about anybody\'s health, and nobody on this '
                + 'board can see your results.',
        });
    } catch (err) {
        console.error('❌ getLeaderboard failed:', err);
        res.status(500).json({ message: 'Could not load the leaderboard', error: err.message });
    }
};

/**
 * `PUT /api/achievements/leaderboard`
 *
 * Join, leave, or rename. Leaving is immediate and leaves nothing behind: the row stays so
 * the points keep accruing, but nothing about it is returned to anybody else again.
 */
exports.updateLeaderboardProfile = async (req, res) => {
    try {
        const userId = req.auth.userId;
        const update = {};

        if (typeof req.body?.optedIn === 'boolean') {
            update.optedIn = req.body.optedIn;
            update.optedInAt = req.body.optedIn ? new Date() : null;
        }
        if (typeof req.body?.displayName === 'string') {
            update.displayName = req.body.displayName.trim().slice(0, 40);
        }
        if (!Object.keys(update).length) {
            return res.status(400).json({ message: 'Nothing to update' });
        }

        // A blank name on a public board is a row nobody can attribute, including its owner.
        if (update.optedIn === true && !(update.displayName ?? '').trim()) {
            const existing = await AchievementProfile.findOne({ userId }).select('displayName').lean();
            if (!existing?.displayName) {
                const user = await User.findById(userId).select('firstName').lean();
                update.displayName = (user?.firstName || 'LabTrack member').slice(0, 40);
            }
        }

        const profile = await AchievementProfile.findOneAndUpdate(
            { userId }, { $set: update }, { upsert: true, new: true },
        ).lean();

        console.log(`🏆 Leaderboard opt-in for ${userId}: ${profile.optedIn}`);
        res.json({
            optedIn: profile.optedIn,
            displayName: profile.displayName,
            points: profile.points,
        });
    } catch (err) {
        console.error('❌ updateLeaderboardProfile failed:', err);
        res.status(500).json({ message: 'Could not update your leaderboard settings', error: err.message });
    }
};

/**
 * `GET /api/achievements/stats`
 *
 * The Stats tab. Everything here is a **count of something the person did**, in the same
 * spirit as the catalogue, and there is deliberately no health figure among them — no score,
 * no blood pressure, no weight. The design's stats screen sits behind a "Share my stats"
 * button, and a screen built to be published is the last place a clinical number belongs.
 * The score lives one tap away on `/score`, where it is explained.
 */
exports.getStats = async (req, res) => {
    try {
        const userId = req.auth.userId;
        const facts = await engine.gather(userId);
        const m = engine.measure(facts);
        const graded = engine.gradeAll(m);

        const nz = (v) => (Number.isFinite(v) ? v : 0);

        res.json({
            header: {
                memberSince: facts.joinedAt,
                daysWithLabTrack: m.daysSinceJoining,
                achievementsUnlocked: graded.unlocked,
                points: graded.points,
            },
            sections: [
                {
                    title: 'Activity',
                    rows: [
                        { label: 'Steps recorded', value: nz(m.stepsTotal), format: 'count' },
                        { label: 'Distance covered', value: nz(m.distanceKm), format: 'km' },
                        { label: 'Sessions finished', value: nz(m.activitySessions), format: 'count' },
                    ],
                },
                {
                    title: 'Sleep',
                    rows: [
                        { label: 'Nights recorded', value: nz(m.sleepNights), format: 'count' },
                        { label: 'Longest run of nights', value: nz(m.sleepStreak), format: 'days' },
                    ],
                },
                {
                    title: 'Nutrition & hydration',
                    rows: [
                        { label: 'Meals logged', value: nz(m.mealsLogged), format: 'count' },
                        { label: 'Meals photographed', value: nz(m.mealPhotos), format: 'count' },
                        { label: 'Drinks logged', value: nz(m.hydrationLogs), format: 'count' },
                        { label: 'Days on your hydration target', value: nz(m.hydrationDaysMet), format: 'days' },
                    ],
                },
                {
                    title: 'Medication',
                    rows: [
                        { label: 'Medicines tracked', value: nz(m.medicationsTracked), format: 'count' },
                        { label: 'Doses recorded as taken', value: nz(m.dosesTaken), format: 'count' },
                    ],
                },
                {
                    title: 'Records',
                    rows: [
                        { label: 'Reports uploaded', value: nz(m.reportsUploaded), format: 'count' },
                        { label: 'Markers on record', value: nz(m.markersTracked), format: 'count' },
                        { label: 'Forecasts run', value: nz(m.predictionsRun), format: 'count' },
                        { label: 'Plan items completed', value: nz(m.planItemsDone), format: 'count' },
                    ],
                },
                {
                    title: 'Consistency',
                    rows: [
                        { label: 'Longest daily streak', value: nz(m.activeDayStreak), format: 'days' },
                        { label: 'Trackers used', value: `${nz(m.trackersUsed)} of 8`, format: 'text' },
                        { label: 'Questions asked', value: nz(m.assistantMessages), format: 'count' },
                    ],
                },
            ],
            note:
                'These are counts of what you have done in LabTrack. Your health results are '
                + 'on your score and results screens, and none of them are included here.',
        });
    } catch (err) {
        console.error('❌ getStats failed:', err);
        res.status(500).json({ message: 'Could not load your stats', error: err.message });
    }
};

/** `POST /api/achievements/evaluate` — force a recalculation. Pull-to-refresh, and after a sync. */
exports.recompute = async (req, res) => {
    try {
        const result = await evaluate(req.auth.userId);
        res.json({ unlocked: result.unlocked, total: result.total, points: result.points, newlyEarned: result.fresh });
    } catch (err) {
        console.error('❌ achievement recompute failed:', err);
        res.status(500).json({ message: 'Could not update your achievements', error: err.message });
    }
};

exports.evaluate = evaluate;
exports.touch = touch;
exports._shareUrlFor = shareUrlFor;
exports._shareHost = shareHost;
