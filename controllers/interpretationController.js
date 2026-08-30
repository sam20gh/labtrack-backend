const mongoose = require('mongoose');
const User = require('../models/userModel');
const DnaReport = require('../models/DnaReport');
const Biomarker = require('../models/Biomarker');
const TestResult = require('../models/testResultModel');
const GenotypeFile = require('../models/GenotypeFile');
const Interpretation = require('../models/Interpretation');
const NutritionPlan = require('../models/NutritionPlan');
const MealLog = require('../models/MealLog');
const Medication = require('../models/Medication');
const MedicationDose = require('../models/MedicationDose');
const { requiresReview, presentToPatient } = require('../config/clinicalPolicy');
const { assessRegeneration } = require('../utils/regenerationGuard');
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
    //
    // Reads the *amended* version where a clinician corrected one: that is what the person
    // was actually shown, and writing a delta against superseded AI text the patient never
    // saw would describe a change that did not happen to them.
    let previous = null;
    const last = await Interpretation.findOne({ userId }).sort({ generatedAt: -1 }).lean();
    if (last) {
        const content = last.amended?.content || last.content;
        if (content) {
            previous = {
                generatedAt: last.generatedAt,
                summary: content.summary,
                risks: content.risks || [],
                biomarkersOfConcern: content.biomarkers_of_concern || [],
                // Stated so the model knows a human has already been over this one.
                reviewed: ['approved', 'amended'].includes(last.review?.status),
            };
        }
    }

    const nutrition = await gatherNutrition(userId);
    const medications = await gatherMedications(userId);

    return { user, dnaReports, biomarkers, trends, series, testResults, previous, nutrition, medications };
};

/** How many days of dose history the interpretation reads. */
const MEDICATION_WINDOW_DAYS = 30;

/**
 * What the person actually takes, and whether they are taking it.
 *
 * Two reasons this belongs in the shared context rather than only on the medication screens:
 *
 *   - **A biomarker cannot be read without it.** A raised potassium in someone on
 *     spironolactone and an ACE inhibitor is a different finding from the same number in
 *     someone on neither, and an engine that cannot see the medication list will write the
 *     wrong one. The same goes for a statin and a cholesterol trend, or thyroid results and
 *     levothyroxine.
 *   - **The assistant is asked about medicines constantly.** Reading them from the same
 *     `_gatherContext` every other surface uses is what stops it describing a drug
 *     differently from the way the medication screen does.
 *
 * Adherence is included because "your cholesterol has not moved" means something different
 * when a third of the doses were missed, and saying so is more useful than re-issuing the
 * advice. Returns null when there is nothing recorded: an empty section invites a model to
 * comment on an absence of data as though it were a finding.
 */
const gatherMedications = async (userId) => {
    const from = new Date();
    from.setDate(from.getDate() - MEDICATION_WINDOW_DAYS);

    const [medications, doses] = await Promise.all([
        Medication.find({ userId, active: true })
            .select('name brandName strength form frequency dose withFood notes startDay')
            .lean(),
        MedicationDose.find({ userId, scheduledFor: { $gte: from } })
            .select('status scheduledFor takenAt medicationName')
            .lean(),
    ]);

    if (!medications.length) return null;

    const { adherence } = require('../utils/medicationSchedule');
    const catalogue = require('../utils/medicationCatalogue');

    // The rule table's verdict travels with the list. An interpretation written without it
    // can recommend something that clashes with what the person already takes.
    const conditions = (await User.findById(userId).select('healthAssessment.conditions').lean())
        ?.healthAssessment?.conditions?.filter((c) => c.status !== 'Resolved').map((c) => c.name) || [];
    const rules = catalogue.runRules(medications, conditions);

    return {
        windowDays: MEDICATION_WINDOW_DAYS,
        current: medications.map((m) => ({
            name: m.name,
            brandName: m.brandName,
            strength: m.strength,
            form: m.form,
            frequency: m.frequency,
            dose: m.dose,
            plainName: catalogue.explain(m.name)?.plainName || null,
            classes: catalogue.classesFor(m.name),
            since: m.startDay,
        })),
        adherence: doses.length ? adherence(doses) : null,
        interactionFindings: rules.findings.map((f) => ({
            severity: f.severity,
            between: f.between,
            effect: f.effect,
        })),
        /** Drugs the catalogue could not classify. Stated so the model does not treat the
         *  finding list as complete. */
        uncheckable: rules.uncheckable,
    };
};

/** How many days of meal logs the interpretation reads. */
const NUTRITION_WINDOW_DAYS = 30;

/**
 * Recent logged nutrition, summarised.
 *
 * The tracker exists to push people towards the dietary advice this engine writes, so the
 * next interpretation has to be able to see whether that worked. Without it the model
 * re-issues "shift towards a Mediterranean pattern" to someone who has been eating that way
 * for a month, which reads as not having been listened to.
 *
 * Returns null when there is nothing logged: an empty section would invite the model to
 * comment on an absence of data as though it were a finding.
 */
const gatherNutrition = async (userId) => {
    const from = new Date();
    from.setDate(from.getDate() - NUTRITION_WINDOW_DAYS);

    const [plan, meals] = await Promise.all([
        NutritionPlan.findOne({ userId }).lean(),
        MealLog.find({ userId, eatenAt: { $gte: from } }).select('day calories analysis').lean(),
    ]);

    if (!meals.length) return null;

    const byDay = new Map();
    for (const m of meals) {
        byDay.set(m.day, (byDay.get(m.day) || 0) + (m.calories || 0));
    }
    const dayTotals = [...byDay.values()];

    const assessedMeals = meals.filter((m) => m.analysis && m.analysis.alignment !== 'unassessed');

    return {
        windowDays: NUTRITION_WINDOW_DAYS,
        daysLogged: byDay.size,
        meanCalories: Math.round(dayTotals.reduce((a, b) => a + b, 0) / dayTotals.length),
        targets: plan?.targets || null,
        guidance: (plan?.guidance || []).map((g) => g.directive).filter(Boolean),
        adherence: {
            assessed: assessedMeals.length,
            aligned: assessedMeals.filter((m) => m.analysis.alignment === 'aligned').length,
            partial: assessedMeals.filter((m) => m.analysis.alignment === 'partial').length,
            offPlan: assessedMeals.filter((m) => m.analysis.alignment === 'off_plan').length,
        },
    };
};


/**
 * Append one snapshot to the person's interpretation history.
 *
 * `covers` records what the prompt actually read, which is the whole point: the old
 * `testID` claimed a single owning document for output derived from all of them.
 */
const writeSnapshot = async ({ userId, context, data, dnaReportId, testResultId }) => {
    const covers = [];
    for (const r of context.dnaReports || []) {
        covers.push({ kind: 'dna_report', id: r._id, date: r.reportDate });
    }
    for (const t of context.testResults || []) {
        covers.push({ kind: 'test_result', id: t._id, date: t.patient?.date_of_test });
    }
    // The document the user asked about may sit outside the context window gatherContext
    // applies to test results, so make sure it is represented.
    const requested = dnaReportId || testResultId;
    if (requested && !covers.some((c) => String(c.id) === String(requested))) {
        covers.push({ kind: dnaReportId ? 'dna_report' : 'test_result', id: requested });
    }

    const previous = await Interpretation.findOne({ userId }).sort({ generatedAt: -1 }).select('_id').lean();

    return Interpretation.create({
        userId,
        generatedAt: new Date(),
        model: MODEL,
        covers,
        content: data,
        supersedes: previous?._id || null,
        review: { status: requiresReview(data) ? 'pending' : 'not_required' },
    });
};

/** The verification block every interpretation response carries. */
const presentation = (snapshot) => {
    const shown = presentToPatient(snapshot);
    return {
        status: shown.status,
        withheld: shown.withheld,
        reviewRequired: snapshot.review?.status === 'pending',
        reviewedAt: snapshot.review?.reviewedAt || null,
    };
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
            // Matches on `covers`, so an interpretation generated *after* this document
            // existed counts as covering it — which it does. The old per-document key would
            // miss that and spend a second model call saying the same thing.
            const cached = await Interpretation.findOne({ userId, 'covers.id': cacheKey })
                .sort({ generatedAt: -1 })
                .lean();
            if (cached) {
                const shown = presentToPatient(cached);
                return res.json({
                    message: 'Existing interpretation returned',
                    cached: true,
                    interpretation: shown.content,
                    verification: presentation(cached),
                });
            }
        }

        // Only reached when a model call is actually about to happen: a cache hit above
        // costs nothing and must never be rate-limited.
        const verdict = await assessRegeneration({ userId });
        if (!verdict.allowed) {
            const existing = verdict.existing ? presentToPatient(verdict.existing) : null;
            return res.status(429)
                .set('Retry-After', String(verdict.retryAfterSeconds))
                .json({
                    message: verdict.message,
                    reason: verdict.reason,
                    retryAfterSeconds: verdict.retryAfterSeconds,
                    // Hand back what they already have, so the client can keep showing an
                    // analysis rather than treating a refusal as an absence.
                    interpretation: existing?.content ?? null,
                    verification: verdict.existing ? presentation(verdict.existing) : null,
                });
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
        // The snapshot is the only store. A failure here has to surface: swallowing it would
        // take the user's money for a model call and then show them nothing.
        const snapshot = await writeSnapshot({ userId, context, data: result.data, dnaReportId, testResultId });

        // The report's status still drives gene-adjusted reference ranges in
        // `biomarkerEvaluator`, so it is kept current. The interpretation itself is no
        // longer copied here — `Interpretation` holds the one authoritative version, and
        // two copies that could drift is the defect this migration removed.
        if (dnaReportId) {
            await DnaReport.findOneAndUpdate(
                { _id: dnaReportId, userId },
                { $set: { status: 'ai_interpreted' } },
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
            // Retained for older clients. `verification` below is the field to read: it is
            // source-agnostic, where this one was only ever true for DNA reports.
            pendingSpecialistReview: Boolean(dnaReportId),
            verification: snapshot
                ? presentation(snapshot)
                : { status: 'unverified', withheld: false, reviewRequired: true },
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
/** Metadata for one `covers` entry, queried against the collection its `kind` names. */
const describeSource = async (ref) => {
    if (!ref) return null;

    if (ref.kind === 'test_result') {
        const r = await TestResult.findById(ref.id).lean();
        if (!r) return null;
        return {
            kind: 'test_result',
            id: String(r._id),
            testType: r.patient?.test_type || null,
            labName: r.patient?.lab_name || null,
            date: r.patient?.date_of_test || null,
        };
    }

    // A genotype file is a third kind, not a DnaReport. Falling through to the DnaReport
    // branch made `findById` miss, which returned a null source — and the client then had
    // nothing to name, so a seeded genotype approval rendered as "your earlier result".
    if (ref.kind === 'genotype_file') {
        const g = await GenotypeFile.findById(ref.id).select('labName reportedAt').lean();
        if (!g) return null;
        return {
            kind: 'genotype_file',
            id: String(g._id),
            testType: 'Genotype report',
            labName: g.labName || null,
            date: g.reportedAt || null,
        };
    }

    const d = await DnaReport.findById(ref.id).select('labName reportDate').lean();
    if (!d) return null;
    return {
        kind: 'dna_report',
        id: String(d._id),
        testType: 'Genetic report',
        labName: d.labName || null,
        date: d.reportDate || null,
    };
};

/**
 * The newest document an interpretation read.
 *
 * That is what "this analysis covers your 9 June result" should name — the leading edge of
 * what it saw, not an arbitrary one of the several documents it drew on.
 */
const newestCover = (covers = []) =>
    [...covers]
        .filter((c) => c?.id)
        .sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime())[0] || null;

exports.getLatest = async (req, res) => {
    try {
        const userId = req.auth.userId;

        const latestResult = await TestResult.findOne({ 'patient.user_id': userId })
            .sort({ 'patient.date_of_test': -1 })
            .lean();

        // Prefer the newest interpretation that actually read the newest result, and only
        // fall back to "newest overall" when nothing has read it yet.
        //
        // Sorting by `generatedAt` alone was wrong whenever a snapshot covering a *narrower*
        // set of documents was written later — a genotype approval, for instance, covers one
        // genotype file and no test results. That snapshot outranked the real analysis of the
        // newest bloods, so the card rendered the genotype content, reported the newest
        // result as unanalysed, and the "Analyse latest result" button then found the real
        // analysis in cache and returned it unchanged: two seconds of spinner and no visible
        // change, because the screen re-read the same losing snapshot.
        let snapshot = latestResult
            ? await Interpretation.findOne({ userId, 'covers.id': latestResult._id })
                .sort({ generatedAt: -1 })
                .lean()
            : null;
        if (!snapshot) {
            snapshot = await Interpretation.findOne({ userId }).sort({ generatedAt: -1 }).lean();
        }

        let interpretation = null;
        let source = null;
        let coversLatest = false;
        let verification = {
            status: 'unverified', withheld: false, reviewRequired: false, reviewedAt: null,
        };

        if (snapshot) {
            const shown = presentToPatient(snapshot);
            interpretation = shown.content;
            verification = presentation(snapshot);
            source = await describeSource(newestCover(snapshot.covers));
            // A direct membership test, where the old shape could only compare one id.
            coversLatest = Boolean(
                latestResult && (snapshot.covers || []).some((c) => String(c.id) === String(latestResult._id)),
            );
        }

        res.json({
            available: isConfigured(),
            interpretation,
            verification,
            generatedAt: snapshot?.generatedAt || null,
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
            // Whether the interpretation above actually read the newest result, or predates
            // it. The client says so rather than implying the analysis is current.
            isForLatestResult: Boolean(interpretation) && coversLatest,
        });
    } catch (error) {
        console.error('❌ Latest interpretation error:', error);
        res.status(500).json({ message: 'Could not fetch interpretation', error: error.message });
    }
};

/** GET /api/interpretation/:sourceId — a cached interpretation, if one exists. */
exports.getInterpretation = async (req, res) => {
    try {
        const userId = req.auth.userId;
        const sourceId = req.params.sourceId;

        // "The newest interpretation that read this document" — not "the interpretation
        // belonging to it". A later whole-person read covers this source too, and is the
        // better answer.
        const snapshot = await Interpretation.findOne({ userId, 'covers.id': sourceId })
            .sort({ generatedAt: -1 })
            .lean();

        if (snapshot) {
            const shown = presentToPatient(snapshot);
            if (shown.withheld) {
                return res.status(404).json({ message: 'Awaiting clinician review' });
            }
            return res.json({
                interpretation: shown.content,
                generatedAt: snapshot.generatedAt,
                verification: presentation(snapshot),
                aiGenerated: true,
            });
        }

        res.status(404).json({ message: 'No interpretation found' });
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
exports._gatherNutrition = gatherNutrition;
exports._gatherMedications = gatherMedications;
