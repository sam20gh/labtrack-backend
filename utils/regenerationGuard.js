/**
 * When may a person regenerate their interpretation?
 *
 * Three things push in the same direction here: every generation is an Opus 5 call, every
 * generation appends a row to an append-only store, and — once the review queue moves onto
 * `Interpretation` — every generation becomes a clinician's work item. A Regenerate button
 * with no guard puts all three at the mercy of a repeated tap.
 *
 * The primary gate is **not** a request count. It is whether anything has changed: an
 * interpretation is a function of the person's data, so regenerating over identical inputs
 * spends a model call to produce the same answer and asks a clinician to review it twice.
 * The counter is only the backstop.
 *
 * Deliberately still allows a deliberate re-read after the cooldown. The model is not
 * perfectly deterministic and the prompt evolves — a person who genuinely wants another
 * look should be able to have one, just not forty.
 */
const Biomarker = require('../models/Biomarker');
const TestResult = require('../models/testResultModel');
const DnaReport = require('../models/DnaReport');
const Interpretation = require('../models/Interpretation');
const User = require('../models/userModel');

/** Generations per rolling 24 hours, whatever the reason. */
const DAILY_LIMIT = 10;

/** How long to wait before a re-read over unchanged data is allowed. */
const UNCHANGED_COOLDOWN_HOURS = 24;

const HOUR = 60 * 60 * 1000;

/**
 * Has anything reached the record since the last interpretation was written?
 *
 * Compares against `createdAt` — when the document arrived — rather than the clinical date
 * it carries. Uploading a two-year-old report is new information about the person even
 * though `measuredAt` is old, and the interpretation should be allowed to account for it.
 */
const hasNewDataSince = async (userId, since) => {
    if (!since) return true;

    const [biomarker, result, dna, user] = await Promise.all([
        Biomarker.findOne({ userId, createdAt: { $gt: since } }).select('_id').lean(),
        TestResult.findOne({ 'patient.user_id': userId, createdAt: { $gt: since } }).select('_id').lean(),
        DnaReport.findOne({ userId, createdAt: { $gt: since } }).select('_id').lean(),
        // The health assessment feeds the prompt, so completing or revising it is new input.
        User.findOne({
            _id: userId,
            'healthAssessment.completedAt': { $gt: since },
        }).select('_id').lean(),
    ]);

    return Boolean(biomarker || result || dna || user);
};

/**
 * @param {{ userId: string, now?: Date }} params
 * @returns {Promise<{
 *   allowed: boolean, reason: string, message?: string,
 *   retryAfterSeconds?: number, hasNewData: boolean, dailyCount: number,
 *   existing?: object|null
 * }>}
 */
const assessRegeneration = async ({ userId, now = new Date() }) => {
    const dayAgo = new Date(now.getTime() - 24 * HOUR);

    const [dailyCount, last] = await Promise.all([
        Interpretation.countDocuments({ userId, generatedAt: { $gt: dayAgo } }),
        Interpretation.findOne({ userId }).sort({ generatedAt: -1 }).lean(),
    ]);

    if (dailyCount >= DAILY_LIMIT) {
        // Retry when the oldest generation in the window falls out of it.
        const oldest = await Interpretation.findOne({ userId, generatedAt: { $gt: dayAgo } })
            .sort({ generatedAt: 1 })
            .select('generatedAt')
            .lean();
        const freeAt = new Date(oldest.generatedAt.getTime() + 24 * HOUR);

        return {
            allowed: false,
            reason: 'daily_limit',
            message: `You have generated ${dailyCount} analyses today. Try again later.`,
            retryAfterSeconds: Math.max(1, Math.ceil((freeAt - now) / 1000)),
            hasNewData: false,
            dailyCount,
            existing: last,
        };
    }

    // First interpretation: nothing to compare against, nothing to rate-limit.
    if (!last) {
        return { allowed: true, reason: 'first', hasNewData: true, dailyCount };
    }

    const hasNewData = await hasNewDataSince(userId, last.generatedAt);
    if (hasNewData) {
        return { allowed: true, reason: 'new_data', hasNewData: true, dailyCount };
    }

    const cooledDown = now.getTime() - new Date(last.generatedAt).getTime() >= UNCHANGED_COOLDOWN_HOURS * HOUR;
    if (cooledDown) {
        return { allowed: true, reason: 'cooldown_elapsed', hasNewData: false, dailyCount };
    }

    const readyAt = new Date(new Date(last.generatedAt).getTime() + UNCHANGED_COOLDOWN_HOURS * HOUR);
    return {
        allowed: false,
        reason: 'no_new_data',
        message: 'Nothing has changed since your last analysis, so it would say the same thing. Add a result to get a fresh read.',
        retryAfterSeconds: Math.max(1, Math.ceil((readyAt - now) / 1000)),
        hasNewData: false,
        dailyCount,
        existing: last,
    };
};

module.exports = { assessRegeneration, hasNewDataSince, DAILY_LIMIT, UNCHANGED_COOLDOWN_HOURS };
