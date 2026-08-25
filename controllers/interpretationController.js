const mongoose = require('mongoose');
const User = require('../models/userModel');
const DnaReport = require('../models/DnaReport');
const Biomarker = require('../models/Biomarker');
const TestResult = require('../models/testResultModel');
const AIFeedback = require('../models/AIFeedback');
const { interpret, isConfigured, MODEL } = require('../utils/interpretationEngine');
const { regeneratePlan } = require('../utils/planGeneratorV2');
const Product = require('../models/Product');
const Professional = require('../models/Professional');

/** Most recent measurements rendered per biomarker. Beyond this the oldest are summarised. */
const SERIES_LIMIT = 24;

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
    const series = {};
    for (const g of latest) {
        // Aggregation pushed newest-first; reverse for chronological order
        const points = g.values.slice().reverse();

        // The dated series, not just its endpoints. Without dates the model cannot tell
        // five genuine draws from one draw entered five times — an observed failure, and
        // it said so in the output rather than being able to read the history.
        series[g._id] = points.length > SERIES_LIMIT
            ? { points: points.slice(-SERIES_LIMIT), omitted: points.length - SERIES_LIMIT }
            : { points, omitted: 0 };

        if (points.length < 2) continue;
        const first = points[0].v;
        const last = points[points.length - 1].v;
        trends[g._id] = {
            count: points.length,
            first,
            last,
            direction: last > first ? 'rising' : last < first ? 'falling' : 'stable',
        };
    }

    // What the last interpretation said, so this one can be written as a delta rather
    // than as though the person had never been assessed before.
    let previous = null;
    const lastFeedback = await AIFeedback.findOne({ userID: userId }).sort({ createdAt: -1 }).lean();
    if (lastFeedback) {
        try {
            const parsed = JSON.parse(lastFeedback.feedback);
            previous = {
                generatedAt: lastFeedback.createdAt,
                summary: parsed.summary,
                risks: parsed.risks || [],
                biomarkersOfConcern: parsed.biomarkers_of_concern || [],
            };
        } catch {
            // An unreadable prior read is the same as not having one.
            previous = null;
        }
    }

    return { user, dnaReports, biomarkers, trends, series, testResults, previous };
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

        // Turn the interpretation into dated, actionable items. The server loads the
        // catalogues itself — the old /api/plans/create made the client POST the entire
        // product and professional lists, which is both wasteful and trivially forgeable.
        const [products, professionals] = await Promise.all([
            Product.find().lean(),
            Professional.find().select('firstname lastname speciality profile_image').lean(),
        ]);

        const plan = await regeneratePlan({
            interpretation: result.data,
            user: context.user,
            products,
            professionals,
            sourceDnaReportId: dnaReportId,
            sourceTestResultId: testResultId,
        });

        res.status(201).json({
            message: 'Interpretation generated',
            cached: false,
            // The client must show this as AI-generated and pending clinical review
            aiGenerated: true,
            pendingSpecialistReview: Boolean(dnaReportId),
            model: MODEL,
            interpretation: result.data,
            plan: {
                created: plan.created.length,
                replaced: plan.removedCount,
                // Surfaced rather than swallowed: a recommendation with nothing to book
                // against is a catalogue gap someone needs to close
                unmatched: plan.unmatched,
            },
            usage: result.usage,
        });
    } catch (error) {
        console.error('❌ Interpretation error:', error);
        res.status(500).json({ message: 'Could not generate interpretation', error: error.message });
    }
};


/**
 * GET /api/interpretation/latest
 *
 * The home screen's single call: the most recent interpretation this person has, whatever
 * document it was generated from, plus their newest test result and whether that result
 * has been interpreted yet.
 *
 * Exists because the client previously had to fetch `/test-results?user_id=`, sort it,
 * take the newest, and ask for *that* document's interpretation. Three failure modes came
 * out of that: a stale cached user id made the whole thing 403, a result with a missing
 * date sorted unpredictably, and — most visibly — someone whose newest result had no
 * interpretation saw nothing at all, even with a perfectly good analysis sitting against
 * their previous result.
 *
 * Deliberately does NOT copy an old interpretation onto a new result. An interpretation
 * names the values it read; presenting it as the analysis of a later draw it never saw
 * would be wrong, and because generation is cached by source id, the copy would then be
 * returned instead of a real analysis. The two are returned separately and labelled, so
 * the client can show the existing read while offering to generate a current one.
 */
exports.getLatest = async (req, res) => {
    try {
        const userId = req.auth.userId;

        const [feedback, latestResult] = await Promise.all([
            AIFeedback.findOne({ userID: userId }).sort({ createdAt: -1 }).lean(),
            TestResult.findOne({ 'patient.user_id': userId })
                .sort({ 'patient.date_of_test': -1 })
                .lean(),
        ]);

        let interpretation = null;
        if (feedback) {
            try {
                interpretation = JSON.parse(feedback.feedback);
            } catch (err) {
                // A row that will not parse is a row the client cannot use. Log it and
                // answer as though there were none, rather than 500-ing the home screen.
                console.error('❌ Unparseable AIFeedback', String(feedback._id), err.message);
            }
        }

        // The interpretation's source may be a test result or a DNA report.
        let source = null;
        if (interpretation && feedback?.testID) {
            const [sourceResult, sourceDna] = await Promise.all([
                TestResult.findById(feedback.testID).lean(),
                DnaReport.findById(feedback.testID).select('labName reportDate').lean(),
            ]);
            if (sourceResult) {
                source = {
                    kind: 'test_result',
                    id: String(sourceResult._id),
                    testType: sourceResult.patient?.test_type || null,
                    labName: sourceResult.patient?.lab_name || null,
                    date: sourceResult.patient?.date_of_test || null,
                };
            } else if (sourceDna) {
                source = {
                    kind: 'dna_report',
                    id: String(sourceDna._id),
                    testType: 'Genetic report',
                    labName: sourceDna.labName || null,
                    date: sourceDna.reportDate || null,
                };
            }
        }

        res.json({
            available: isConfigured(),
            interpretation,
            generatedAt: feedback?.createdAt || null,
            source,
            latestResult: latestResult
                ? {
                    id: String(latestResult._id),
                    testType: latestResult.patient?.test_type || null,
                    labName: latestResult.patient?.lab_name || null,
                    date: latestResult.patient?.date_of_test || null,
                    labInterpretation: latestResult.interpretation || null,
                    biomarkerCount: latestResult.biomarkerCount ?? null,
                }
                : null,
            // Whether the interpretation above actually describes the newest result, or an
            // earlier one. The client says so rather than implying the analysis is current.
            isForLatestResult: Boolean(
                interpretation && latestResult && String(feedback.testID) === String(latestResult._id)
            ),
        });
    } catch (error) {
        console.error('❌ Latest interpretation error:', error);
        res.status(500).json({ message: 'Could not fetch interpretation', error: error.message });
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

// Exported for tests: the series capping and previous-interpretation parsing here are
// what make the prompt's history usable, and they are worth asserting on directly.
exports._gatherContext = gatherContext;
