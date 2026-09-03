/**
 * Specialist review of AI interpretations.
 *
 * The product promise is that a clinician checks what the model produced before it is
 * treated as advice. That requires three things this module provides:
 *
 *   1. **A queue** of interpretations awaiting review. It reads `Interpretation`, so it
 *      covers every patient — the queue used to be `DnaReport.find({status:'ai_interpreted'})`,
 *      which meant a patient with only blood results could never be reviewed at all while
 *      the app told them review was pending.
 *   2. **Amendment with an audit trail.** What the AI said and what the clinician changed
 *      it to are both preserved — "the model got this wrong and a doctor corrected it" is
 *      exactly the record a medical product needs, and overwriting it would erase the
 *      evidence that review is working.
 *   3. **Clinician-ordered follow-ups** that enter the same plan pipeline as AI items,
 *      distinguishable by `source: 'specialist'`.
 *
 * A professional may only review reports assigned to them or unassigned ones; they cannot
 * browse arbitrary patients.
 */
const DnaReport = require('../models/DnaReport');
const Interpretation = require('../models/Interpretation');
const TestResult = require('../models/testResultModel');
const PlanItem = require('../models/PlanItem');
const Professional = require('../models/Professional');
const Product = require('../models/Product');
const User = require('../models/userModel');
const Biomarker = require('../models/Biomarker');
const { firstDueDate } = require('../utils/planGeneratorV2');
const { notifyUser } = require('../jobs/reminderJob');
const { recordAccess } = require('../utils/accessLog');

/** Fields of an interpretation a clinician may amend. */
const AMENDABLE = ['summary', 'risks', 'recommended_screenings', 'specialist_consultations', 'lifestyle_recommendations', 'follow_up', 'limitations'];

/**
 * GET /api/reviews/queue
 * Interpretations awaiting sign-off, oldest first so nothing is left waiting.
 */
exports.getQueue = async (req, res) => {
    try {
        const pending = await Interpretation.find({ 'review.status': 'pending' })
            .sort({ generatedAt: 1 })
            .populate('userId', 'firstName lastName dob gender email')
            .limit(100)
            .lean();

        // One lookup for every DNA report referenced across the queue, rather than one per
        // row: the pathogenic count is what lets a clinician pick the urgent ones first.
        const dnaIds = pending.flatMap((i) =>
            (i.covers || []).filter((c) => c.kind === 'dna_report').map((c) => c.id));
        const dnaReports = dnaIds.length
            ? await DnaReport.find({ _id: { $in: dnaIds } }).select('mutations').lean()
            : [];
        const mutationsById = new Map(dnaReports.map((d) => [String(d._id), d.mutations || []]));

        // The queue names patients, so opening it is itself a read of patient data — logged
        // as one entry with a count rather than one per row, which is what makes a bulk
        // browse distinguishable from opening a single case.
        await recordAccess({
            actor: req.auth,
            resource: 'queue',
            count: pending.length,
        });

        res.json({
            count: pending.length,
            interpretations: pending.map((i) => {
                const mutations = (i.covers || [])
                    .filter((c) => c.kind === 'dna_report')
                    .flatMap((c) => mutationsById.get(String(c.id)) || []);

                return {
                    _id: i._id,
                    patient: i.userId,
                    generatedAt: i.generatedAt,
                    waitingSince: i.generatedAt,
                    summary: i.content?.summary,
                    // What the interpretation actually read, so the queue says whether this
                    // is a genetic case, a blood case, or both.
                    sourceKinds: [...new Set((i.covers || []).map((c) => c.kind))],
                    sourceCount: (i.covers || []).length,
                    mutationCount: mutations.length,
                    pathogenicCount: mutations.filter((m) =>
                        ['pathogenic', 'likely_pathogenic'].includes(m.significance)).length,
                    // Surfaced for the same reason: a high-risk read should be picked first.
                    highRiskCount: (i.content?.risks || []).filter((r) => r.level === 'high').length,
                };
            }),
        });
    } catch (error) {
        console.error('❌ Review queue failed:', error);
        res.status(500).json({ message: 'Could not load the review queue', error: error.message });
    }
};

/**
 * GET /api/reviews/:interpretationId — the interpretation and everything it read.
 *
 * A clinician needs the sources as well as the output, otherwise they are signing off prose
 * they cannot check.
 */
exports.getReportForReview = async (req, res) => {
    try {
        const interpretation = await Interpretation.findById(req.params.reportId)
            .populate('userId', 'firstName lastName dob gender email healthAssessment')
            .lean();

        if (!interpretation) return res.status(404).json({ message: 'Interpretation not found' });

        const dnaIds = (interpretation.covers || []).filter((c) => c.kind === 'dna_report').map((c) => c.id);
        const resultIds = (interpretation.covers || []).filter((c) => c.kind === 'test_result').map((c) => c.id);

        const [dnaReports, testResults, previous] = await Promise.all([
            dnaIds.length ? DnaReport.find({ _id: { $in: dnaIds } }).lean() : [],
            resultIds.length ? TestResult.find({ _id: { $in: resultIds } }).lean() : [],
            // What the previous read said, so an amendment can be judged against the change
            // rather than in isolation.
            interpretation.supersedes
                ? Interpretation.findById(interpretation.supersedes).select('content generatedAt review').lean()
                : null,
        ]);

        // This response carries the patient's health assessment — medications, conditions,
        // allergies, family history — so it is the single most sensitive read in the API.
        await recordAccess({
            actor: req.auth,
            patientId: interpretation.userId?._id || interpretation.userId,
            resource: 'interpretation',
            resourceId: interpretation._id,
        });

        res.json({ interpretation, sources: { dnaReports, testResults }, previous });
    } catch (error) {
        console.error('❌ Could not load interpretation for review:', error);
        res.status(500).json({ message: 'Could not load the interpretation', error: error.message });
    }
};

/** GET /api/reviews/mine — what this clinician has already signed. */
/**
 * GET /api/reviews/patient/:userId/context — a patient's record, for a reviewing clinician.
 *
 * Reviewing a variant without the person's history is reviewing half the case: a raised
 * potassium in someone on spironolactone and an ACE inhibitor is a different finding from
 * the same number in someone on neither. That context lives behind `requireSelf` everywhere
 * else in the API, so this endpoint is the deliberate exception — and therefore the most
 * security-sensitive route in the product.
 *
 * Three things hold the line:
 *
 *  1. **Access is scoped, not blanket.** `requireReviewScope` (see below) requires this
 *     clinician to have a reason to be here — an interpretation of this patient's that is
 *     in the queue or that they reviewed. Holding a professional token is not a reason.
 *  2. **Every call is logged**, with the patient id, before the response is sent.
 *  3. **It is read-only and projected.** No credentials, no Supabase id, no push tokens —
 *     the clinical picture and nothing else.
 */
exports.getPatientContext = async (req, res) => {
    try {
        const { userId } = req.params;

        const [patient, interpretations, planItems, biomarkers] = await Promise.all([
            User.findById(userId)
                .select('firstName lastName dob gender height weight bloodType healthAssessment observed')
                .lean(),
            Interpretation.find({ userId })
                .select('generatedAt review content.summary content.plain_summary supersedes')
                .sort({ generatedAt: -1 })
                .limit(20)
                .populate('review.professionalId', 'firstname lastname')
                .lean(),
            PlanItem.find({ userId })
                .select('type title condition status dueDate scheduledAge source frequency')
                .sort({ dueDate: 1 })
                .limit(200)
                .lean(),
            Biomarker.find({ userId })
                .sort({ measuredAt: -1 })
                .limit(400)
                .lean(),
        ]);

        if (!patient) return res.status(404).json({ message: 'Patient not found' });

        await recordAccess({
            actor: req.auth,
            patientId: userId,
            resource: 'patient_context',
        });

        res.json({
            patient,
            interpretations,
            planItems,
            biomarkers,
        });
    } catch (error) {
        console.error('❌ Could not load patient context:', error);
        res.status(500).json({ message: 'Could not load the patient record', error: error.message });
    }
};

exports.getMyReviews = async (req, res) => {
    try {
        const interpretations = await Interpretation.find({ 'review.professionalId': req.auth.userId })
            .sort({ 'review.reviewedAt': -1 })
            .populate('userId', 'firstName lastName')
            .limit(100)
            .lean();

        res.json({ count: interpretations.length, interpretations });
    } catch (error) {
        res.status(500).json({ message: 'Could not load your reviews', error: error.message });
    }
};

/**
 * POST /api/reviews/:interpretationId
 *
 * Sign off an interpretation, optionally amending it.
 *
 * Body: `{ approved, notes, amendments: { summary?, risks?, ... } }`
 *
 * The amended version is written to `amended.content` **beside** the original rather than
 * over it. Two reasons: "the model said X and a doctor corrected it to Y" is exactly the
 * record a medical product needs, and the patient read already prefers `amended` — which is
 * what makes a correction reach them at all. Under the old shape the amendment landed on
 * `DnaReport` while the patient-facing read looked at `AIFeedback`, so it never did.
 */
exports.submitReview = async (req, res) => {
    try {
        const { approved, notes, amendments = {} } = req.body;

        if (typeof approved !== 'boolean') {
            return res.status(400).json({ message: 'approved must be true or false' });
        }

        const interpretation = await Interpretation.findById(req.params.reportId);
        if (!interpretation) return res.status(404).json({ message: 'Interpretation not found' });

        // req.auth.userId is the Professional's id for a professional-issued token
        const professionalId = req.auth.userId;

        // Start from whatever is current: re-reviewing an amended interpretation must build
        // on the previous clinician's work, not silently revert it.
        const base = interpretation.amended?.content || interpretation.content || {};
        const next = { ...base };
        const edits = [];

        for (const field of AMENDABLE) {
            if (!(field in amendments)) continue;

            const previous = base[field];
            const updated = amendments[field];
            if (JSON.stringify(previous) === JSON.stringify(updated)) continue;

            edits.push({ field, previous, updated, reason: amendments.__reasons?.[field] || notes });
            next[field] = updated;
        }

        interpretation.review = {
            status: edits.length ? 'amended' : 'approved',
            professionalId,
            reviewedAt: new Date(),
            notes,
            // Append rather than replace: a second review must not erase the first
            edits: [...(interpretation.review?.edits || []), ...edits],
        };

        if (edits.length) {
            interpretation.amended = { content: next, at: new Date(), by: professionalId };
        }

        await interpretation.save();

        // The report's own status still matters — `biomarkerEvaluator` gates gene-adjusted
        // reference ranges on it — but the interpretation copy is no longer written here.
        // `Interpretation.amended` is the single authoritative version.
        const dnaCover = (interpretation.covers || []).find((c) => c.kind === 'dna_report');
        if (dnaCover) {
            await DnaReport.findByIdAndUpdate(dnaCover.id, {
                $set: {
                    status: 'specialist_reviewed',
                    'specialistReview.professionalId': professionalId,
                    'specialistReview.reviewedAt': new Date(),
                    'specialistReview.approved': approved,
                    'specialistReview.notes': notes,
                },
            }).catch((e) => console.warn('⚠️ DnaReport status update failed:', e.message));
        }

        console.log(`🩺 Interpretation ${interpretation._id} reviewed by ${professionalId} — approved: ${approved}, ${edits.length} amendments`);

        const clinician = await Professional.findById(professionalId).select('firstname lastname').lean();
        notifyUser(interpretation.userId, {
            title: 'A specialist has reviewed your results',
            body: clinician
                ? `Dr ${clinician.lastname} has reviewed your results and health plan.`
                : 'Your results have been reviewed by a specialist.',
            data: { type: 'review', interpretationId: String(interpretation._id), route: '/myplans' },
        }).catch((e) => console.warn('⚠️ Review notification failed:', e.message));

        res.json({
            message: approved ? 'Interpretation approved' : 'Interpretation reviewed with concerns',
            amendmentCount: edits.length,
            interpretation: await Interpretation.findById(interpretation._id).lean(),
        });
    } catch (error) {
        console.error('❌ Review submission failed:', error);
        res.status(500).json({ message: 'Could not submit the review', error: error.message });
    }
};

/**
 * POST /api/reviews/:reportId/plan-items
 *
 * A clinician orders a follow-up. Enters the same plan pipeline as AI items but carries
 * `source: 'specialist'`, so the app can show who ordered what and the regeneration in
 * `planGeneratorV2` never deletes it.
 */
exports.addPlanItem = async (req, res) => {
    try {
        const { type, title, description, condition, dueDate, startingAge, frequency, urgency, speciality, productId } = req.body;

        if (!type || !title) {
            return res.status(400).json({ message: 'type and title are required' });
        }

        // The route param is now an interpretation id, and the patient comes from it.
        const interpretation = await Interpretation.findById(req.params.reportId).lean();
        if (!interpretation) return res.status(404).json({ message: 'Interpretation not found' });

        const patient = await User.findById(interpretation.userId).select('dob').lean();
        if (!patient) return res.status(404).json({ message: 'Patient not found' });

        // Kept for provenance where the interpretation read one, so a clinician-ordered
        // follow-up still records the genetic finding behind it.
        const dnaCover = (interpretation.covers || []).find((c) => c.kind === 'dna_report');

        // Either an explicit date or an age the clinician wants surveillance to start at
        const due = dueDate
            ? new Date(dueDate)
            : firstDueDate(patient.dob, typeof startingAge === 'number' ? startingAge : undefined);

        let product = null;
        if (productId) product = await Product.findById(productId).lean();

        const item = await PlanItem.create({
            userId: interpretation.userId,
            type,
            title,
            description,
            condition,
            frequency,
            dueDate: due,
            status: PlanItem.deriveStatus(due),
            urgency: urgency || 'moderate',
            // Marks this as clinician-ordered, which also protects it from AI regeneration
            source: 'specialist',
            orderedByProfessionalId: req.auth.userId,
            sourceDnaReportId: dnaCover?.id,
            sourceInterpretationId: interpretation._id,
            speciality,
            productId: product?._id,
            productName: product?.name,
            image: product?.image || null,
        });

        res.status(201).json({ message: 'Follow-up added to the patient plan', item });
    } catch (error) {
        console.error('❌ Adding specialist plan item failed:', error);
        res.status(400).json({ message: 'Could not add the follow-up', error: error.message });
    }
};

/**
 * GET /api/reviews/profile — who the signed-in professional is.
 * Lets the app confirm a professional session and show their name.
 */
exports.getProfile = async (req, res) => {
    try {
        const professional = await Professional.findById(req.auth.userId).select('-password').lean();
        if (!professional) return res.status(404).json({ message: 'Professional not found' });
        res.json({ professional });
    } catch (error) {
        res.status(500).json({ message: 'Could not load your profile', error: error.message });
    }
};
