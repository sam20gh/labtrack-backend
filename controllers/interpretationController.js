const mongoose = require('mongoose');
const User = require('../models/userModel');
const DnaReport = require('../models/DnaReport');
const Biomarker = require('../models/Biomarker');
const TestResult = require('../models/testResultModel');
const AIFeedback = require('../models/AIFeedback');
const { interpret, isConfigured, MODEL } = require('../utils/interpretationEngine');

/**
 * Assemble everything the engine needs about one person.
 * Latest value per biomarker plus its trend — a value inside range but climbing is a
 * different clinical picture from a stable one, and only the series shows that.
 */
const gatherContext = async (userId) => {
    const [user, dnaReports, testResults] = await Promise.all([
        User.findById(userId).select('-password').lean(),
        DnaReport.find({ userId, status: { $nin: ['parsing', 'failed'] } }).sort({ createdAt: -1 }).lean(),
        TestResult.find({ 'patient.user_id': userId }).sort({ 'patient.date_of_test': -1 }).limit(10).lean(),
    ]);

    const latest = await Biomarker.aggregate([
        { $match: { userId: new mongoose.Types.ObjectId(String(userId)) } },
        { $sort: { measuredAt: -1 } },
        { $group: { _id: '$name', doc: { $first: '$$ROOT' }, values: { $push: { v: '$value', at: '$measuredAt' } } } },
        { $sort: { '_id': 1 } },
    ]);

    const biomarkers = latest.map((g) => g.doc);
    const trends = {};
    for (const g of latest) {
        // Aggregation pushed newest-first; reverse for chronological first/last
        const series = g.values.slice().reverse();
        if (series.length < 2) continue;
        const first = series[0].v;
        const last = series[series.length - 1].v;
        trends[g._id] = {
            count: series.length,
            first,
            last,
            direction: last > first ? 'rising' : last < first ? 'falling' : 'stable',
        };
    }

    return { user, dnaReports, biomarkers, trends, testResults };
};

/**
 * POST /api/interpretation/generate
 *
 * Cached by source: an interpretation is expensive and deterministic enough that
 * regenerating it on every view wastes money and produces gratuitous variation in what a
 * person reads about their own health. Pass `force: true` to regenerate after new data.
 */
exports.generateInterpretation = async (req, res) => {
    try {
        if (!isConfigured()) {
            return res.status(503).json({ message: 'AI interpretation is unavailable on this server' });
        }

        const userId = req.auth.userId;
        const { dnaReportId, testResultId, force } = req.body;

        // Cache key: the document this interpretation is about, or the user's overall state
        const cacheKey = dnaReportId || testResultId || null;

        if (!force && cacheKey) {
            const cached = await AIFeedback.findOne({ userID: userId, testID: cacheKey }).sort({ createdAt: -1 });
            if (cached) {
                return res.json({
                    message: 'Existing interpretation returned',
                    cached: true,
                    interpretation: JSON.parse(cached.feedback),
                });
            }
        }

        const context = await gatherContext(userId);
        if (!context.user) return res.status(404).json({ message: 'User not found' });

        if (!context.dnaReports.length && !context.biomarkers.length) {
            return res.status(400).json({
                message: 'Add a test result or genetic report before generating an interpretation',
            });
        }

        const result = await interpret(context);
        if (!result.ok) return res.status(502).json({ message: result.error });

        // Upsert rather than insert: the old path created a new row on every save, so later
        // duplicates became unreachable behind findOne()
        if (cacheKey) {
            await AIFeedback.findOneAndUpdate(
                { userID: userId, testID: cacheKey },
                { $set: { userID: userId, testID: cacheKey, feedback: JSON.stringify(result.data), createdAt: new Date() } },
                { upsert: true, runValidators: true }
            );
        }

        // Attach to the DNA report and move it into the review queue
        if (dnaReportId) {
            await DnaReport.findOneAndUpdate(
                { _id: dnaReportId, userId },
                {
                    $set: {
                        status: 'ai_interpreted',
                        aiInterpretation: {
                            summary: result.data.summary,
                            risks: result.data.risks?.map((r) => ({
                                condition: r.condition, level: r.level, rationale: r.rationale,
                            })),
                            raw: result.data,
                            model: MODEL,
                            generatedAt: new Date(),
                        },
                    },
                },
                { runValidators: true }
            );
        }

        res.status(201).json({
            message: 'Interpretation generated',
            cached: false,
            // The client must show this as AI-generated and pending clinical review
            aiGenerated: true,
            pendingSpecialistReview: Boolean(dnaReportId),
            model: MODEL,
            interpretation: result.data,
            usage: result.usage,
        });
    } catch (error) {
        console.error('❌ Interpretation error:', error);
        res.status(500).json({ message: 'Could not generate interpretation', error: error.message });
    }
};

/** GET /api/interpretation/:sourceId — a cached interpretation, if one exists. */
exports.getInterpretation = async (req, res) => {
    try {
        const cached = await AIFeedback.findOne({
            userID: req.auth.userId,
            testID: req.params.sourceId,
        }).sort({ createdAt: -1 });

        if (!cached) return res.status(404).json({ message: 'No interpretation found' });

        res.json({
            interpretation: JSON.parse(cached.feedback),
            generatedAt: cached.createdAt,
            aiGenerated: true,
        });
    } catch (error) {
        res.status(500).json({ message: 'Could not fetch interpretation', error: error.message });
    }
};

/** GET /api/interpretation/status */
exports.getStatus = async (req, res) => {
    res.json({ available: isConfigured(), model: isConfigured() ? MODEL : null });
};
