const User = require('../models/userModel');
const Order = require('../models/Order');
const TestResult = require('../models/testResultModel');
const ConnectedSource = require('../models/ConnectedSource');
const Interpretation = require('../models/Interpretation');
const SleepSession = require('../models/SleepSession');
const ActivitySession = require('../models/ActivitySession');
const { deriveJourney, STEPS } = require('../utils/onboardingState');
const { claimByEmail, claimByCode } = require('../utils/claimOrders');
const { diffAnalyses } = require('../utils/analysisDiff');
const { presentToPatient } = require('../config/clinicalPolicy');

/**
 * The first-run journey. See `utils/onboardingState.js` for what each step means and why
 * none of it is stored.
 */

/** Everything `deriveJourney` reads, in one round of parallel reads. */
const gather = async (userId) => {
    const [user, orders, resultsCount, sources, analysis, nights, activities] = await Promise.all([
        User.findById(userId).select('dob gender height weight firstName healthAssessment onboarding').lean(),
        Order.find({ userId }).sort({ createdAt: -1 }).limit(20).lean(),
        TestResult.countDocuments({ 'patient.user_id': userId }),
        ConnectedSource.find({ userId }).select('platform status').lean(),
        Interpretation.findOne({ userId }).sort({ generatedAt: -1 }).select('generatedAt covers').lean(),
        SleepSession.countDocuments({ userId }),
        ActivitySession.countDocuments({ userId }),
    ]);
    return { user, orders, resultsCount, sources, analysis, learned: { nights, activities } };
};

/**
 * GET /api/onboarding
 *
 * Also claims any website order bought with this account's verified email since the last
 * sign-in. Sign-in claims too, but a package bought on the website *after* the account was
 * made would otherwise wait for the next sign-in — which, with "keep me signed in", is never.
 */
exports.getJourney = async (req, res) => {
    try {
        const userId = req.auth.userId;
        if (req.auth.emailVerified && req.auth.email) await claimByEmail(userId, req.auth.email);

        const input = await gather(userId);
        if (!input.user) return res.status(404).json({ message: 'User not found' });
        res.json(deriveJourney(input));
    } catch (error) {
        console.error('❌ Onboarding state failed:', error);
        res.status(500).json({ message: 'Could not load your setup', error: error.message });
    }
};

/** Apply one `$set`/`$unset` to `onboarding`, then answer with the new journey. */
const writeThenAnswer = async (req, res, update) => {
    await User.updateOne({ _id: req.auth.userId }, update);
    const input = await gather(req.auth.userId);
    res.json(deriveJourney(input));
};

/**
 * POST /api/onboarding/welcomed — the welcome hub has been seen.
 * Set once; a second call keeps the first date, because that is when they started.
 */
exports.markWelcomed = async (req, res) => {
    try {
        await User.updateOne(
            { _id: req.auth.userId, 'onboarding.welcomedAt': { $exists: false } },
            { $set: { 'onboarding.welcomedAt': new Date() } }
        );
        const input = await gather(req.auth.userId);
        res.json(deriveJourney(input));
    } catch (error) {
        res.status(500).json({ message: 'Could not save that', error: error.message });
    }
};

const stepFrom = (req, res) => {
    const step = req.body?.step;
    if (!STEPS.includes(step)) {
        res.status(400).json({ message: `step must be one of: ${STEPS.join(', ')}` });
        return null;
    }
    return step;
};

/** POST /api/onboarding/skip { step } — "not now". Never blocks anything; the card keeps it. */
exports.skipStep = async (req, res) => {
    try {
        const step = stepFrom(req, res);
        if (!step) return;
        await writeThenAnswer(req, res, { $set: { [`onboarding.skipped.${step}`]: new Date() } });
    } catch (error) {
        res.status(500).json({ message: 'Could not save that', error: error.message });
    }
};

/** POST /api/onboarding/resume { step } — undo a skip. */
exports.resumeStep = async (req, res) => {
    try {
        const step = stepFrom(req, res);
        if (!step) return;
        await writeThenAnswer(req, res, { $unset: { [`onboarding.skipped.${step}`]: '' } });
    } catch (error) {
        res.status(500).json({ message: 'Could not save that', error: error.message });
    }
};

/** POST /api/onboarding/dismiss — hide the journey card. `{ undo: true }` brings it back. */
exports.dismiss = async (req, res) => {
    try {
        const update = req.body?.undo === true
            ? { $unset: { 'onboarding.dismissedAt': '' } }
            : { $set: { 'onboarding.dismissedAt': new Date() } };
        await writeThenAnswer(req, res, update);
    } catch (error) {
        res.status(500).json({ message: 'Could not save that', error: error.message });
    }
};

/**
 * POST /api/onboarding/claim { code }
 *
 * The code from a website purchase's thank-you page or the card in the box. Rate-limited at
 * the route: the code space is large, but a claim endpoint is exactly what somebody would
 * script against.
 */
exports.claimKit = async (req, res) => {
    try {
        const result = await claimByCode(req.auth.userId, req.body?.code);
        if (!result.ok) {
            return res.status(result.reason === 'invalid' ? 400 : 404).json({
                message: result.reason === 'invalid'
                    ? 'That does not look like a kit code. It is 8 letters and numbers.'
                    : 'We could not find an order with that code. Check it and try again.',
                reason: result.reason,
            });
        }
        console.log(`🎁 Kit code claimed for ${req.auth.userId}: order ${result.order._id}`);
        const input = await gather(req.auth.userId);
        res.json({
            message: result.already ? 'This order is already on your account' : 'Order added to your account',
            already: result.already,
            order: { _id: result.order._id, items: result.order.items.map((i) => ({ name: i.name })) },
            journey: deriveJourney(input),
        });
    } catch (error) {
        console.error('❌ Kit claim failed:', error);
        res.status(500).json({ message: 'Could not add that order', error: error.message });
    }
};

/**
 * GET /api/onboarding/analysis-update
 *
 * The newest analysis set against the one before it — the "what changed" screen the DNA
 * arrival opens. Both go through `presentToPatient`, so an analysis held for clinical review
 * is reported as held, never shown early by the back door of a diff.
 */
exports.getAnalysisUpdate = async (req, res) => {
    try {
        const rows = await Interpretation.find({ userId: req.auth.userId })
            .sort({ generatedAt: -1 })
            .limit(2)
            .lean();
        if (!rows.length) return res.status(404).json({ message: 'No analysis yet' });

        const [latest, previous] = rows;
        const now = presentToPatient(latest);
        const coverKinds = (latest.covers || []).map((c) => c.kind);
        const reads = {
            dna: coverKinds.filter((k) => k === 'dna_report' || k === 'genotype_file').length,
            results: coverKinds.filter((k) => k === 'test_result').length,
        };

        if (now.withheld || !now.content) {
            return res.json({
                withheld: true,
                generatedAt: latest.generatedAt,
                reads,
                message: 'Your updated analysis is with a clinician for review. We will tell you when it is ready.',
            });
        }

        const before = previous ? presentToPatient(previous) : null;
        const diff = diffAnalyses(before && !before.withheld ? before.content : null, now.content);

        res.json({
            withheld: false,
            generatedAt: latest.generatedAt,
            previousAt: previous?.generatedAt || null,
            reads,
            headline: now.content.plain_summary?.headline || null,
            whatItMeans: now.content.plain_summary?.what_it_means || null,
            nextStep: now.content.plain_summary?.next_step || null,
            ...diff,
        });
    } catch (error) {
        console.error('❌ Analysis update failed:', error);
        res.status(500).json({ message: 'Could not load the update', error: error.message });
    }
};
