/**
 * Specialist review of AI interpretations.
 *
 * The product promise is that a clinician checks what the model produced before it is
 * treated as advice. That requires three things this module provides:
 *
 *   1. **A queue** of interpretations awaiting review.
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
const PlanItem = require('../models/PlanItem');
const Professional = require('../models/Professional');
const Product = require('../models/Product');
const User = require('../models/userModel');
const { firstDueDate } = require('../utils/planGeneratorV2');
const { notifyUser } = require('../jobs/reminderJob');

/** Fields of an interpretation a clinician may amend. */
const AMENDABLE = ['summary', 'risks', 'recommended_screenings', 'specialist_consultations', 'lifestyle_recommendations', 'follow_up', 'limitations'];

/**
 * GET /api/reviews/queue
 * Interpretations awaiting sign-off, oldest first so nothing is left waiting.
 */
exports.getQueue = async (req, res) => {
    try {
        const reports = await DnaReport.find({ status: 'ai_interpreted' })
            .sort({ createdAt: 1 })
            .populate('userId', 'firstName lastName dob gender email')
            .limit(100)
            .lean();

        res.json({
            count: reports.length,
            reports: reports.map((r) => ({
                _id: r._id,
                patient: r.userId,
                labName: r.labName,
                reportDate: r.reportDate,
                mutationCount: r.mutations?.length ?? 0,
                // Surfaced in the queue so the clinically urgent ones can be picked first
                pathogenicCount: (r.mutations || []).filter((m) =>
                    ['pathogenic', 'likely_pathogenic'].includes(m.significance)).length,
                summary: r.aiInterpretation?.summary,
                generatedAt: r.aiInterpretation?.generatedAt,
                waitingSince: r.createdAt,
            })),
        });
    } catch (error) {
        console.error('❌ Review queue failed:', error);
        res.status(500).json({ message: 'Could not load the review queue', error: error.message });
    }
};

/** GET /api/reviews/:reportId — the full report and interpretation for review. */
exports.getReportForReview = async (req, res) => {
    try {
        const report = await DnaReport.findById(req.params.reportId)
            .populate('userId', 'firstName lastName dob gender email healthAssessment')
            .lean();

        if (!report) return res.status(404).json({ message: 'Report not found' });

        res.json({ report });
    } catch (error) {
        res.status(500).json({ message: 'Could not load the report', error: error.message });
    }
};

/**
 * POST /api/reviews/:reportId
 *
 * Sign off an interpretation, optionally amending it.
 *
 * Body: { approved, notes, amendments: { summary?, risks?, ... } }
 *
 * Amendments are applied to `aiInterpretation.raw` and each change is recorded in
 * `specialistReview.edits` with its previous value.
 */
exports.submitReview = async (req, res) => {
    try {
        const { approved, notes, amendments = {} } = req.body;

        if (typeof approved !== 'boolean') {
            return res.status(400).json({ message: 'approved must be true or false' });
        }

        const report = await DnaReport.findById(req.params.reportId);
        if (!report) return res.status(404).json({ message: 'Report not found' });

        if (report.status !== 'ai_interpreted' && report.status !== 'specialist_reviewed') {
            return res.status(409).json({
                message: `A report at status "${report.status}" is not ready for review`,
            });
        }

        // req.auth.userId is the Professional's id for a professional-issued token
        const professionalId = req.auth.userId;

        const raw = report.aiInterpretation?.raw ? { ...report.aiInterpretation.raw } : {};
        const edits = [];

        for (const field of AMENDABLE) {
            if (!(field in amendments)) continue;

            const previous = raw[field];
            const updated = amendments[field];
            if (JSON.stringify(previous) === JSON.stringify(updated)) continue;

            edits.push({
                field,
                previous,
                updated,
                reason: amendments.__reasons?.[field] || notes,
            });
            raw[field] = updated;
        }

        report.aiInterpretation.raw = raw;
        // Keep the top-level summary in step with an amended one
        if (raw.summary) report.aiInterpretation.summary = raw.summary;
        if (raw.risks) {
            report.aiInterpretation.risks = raw.risks.map((r) => ({
                condition: r.condition, level: r.level, rationale: r.rationale,
            }));
        }

        report.status = 'specialist_reviewed';
        report.specialistReview = {
            professionalId,
            reviewedAt: new Date(),
            approved,
            notes,
            // Append rather than replace: a second review must not erase the first
            edits: [...(report.specialistReview?.edits || []), ...edits],
        };

        await report.save();

        console.log(`🩺 Report ${report._id} reviewed by ${professionalId} — approved: ${approved}, ${edits.length} amendments`);

        const clinician = await Professional.findById(professionalId).select('firstname lastname').lean();
        notifyUser(report.userId, {
            title: 'A specialist has reviewed your results',
            body: clinician
                ? `Dr ${clinician.lastname} has reviewed your genetic report and health plan.`
                : 'Your genetic report has been reviewed by a specialist.',
            data: { type: 'review', dnaReportId: String(report._id), route: '/myplans' },
        }).catch((e) => console.warn('⚠️ Review notification failed:', e.message));

        res.json({
            message: approved ? 'Interpretation approved' : 'Interpretation reviewed with concerns',
            amendmentCount: edits.length,
            report: await DnaReport.findById(report._id).lean(),
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

        const report = await DnaReport.findById(req.params.reportId).lean();
        if (!report) return res.status(404).json({ message: 'Report not found' });

        const patient = await User.findById(report.userId).select('dob').lean();
        if (!patient) return res.status(404).json({ message: 'Patient not found' });

        // Either an explicit date or an age the clinician wants surveillance to start at
        const due = dueDate
            ? new Date(dueDate)
            : firstDueDate(patient.dob, typeof startingAge === 'number' ? startingAge : undefined);

        let product = null;
        if (productId) product = await Product.findById(productId).lean();

        const item = await PlanItem.create({
            userId: report.userId,
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
            sourceDnaReportId: report._id,
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
 * GET /api/reviews/mine — reports this professional has reviewed.
 */
exports.getMyReviews = async (req, res) => {
    try {
        const reports = await DnaReport.find({ 'specialistReview.professionalId': req.auth.userId })
            .sort({ 'specialistReview.reviewedAt': -1 })
            .populate('userId', 'firstName lastName')
            .limit(100)
            .lean();

        res.json({ count: reports.length, reports });
    } catch (error) {
        res.status(500).json({ message: 'Could not load your reviews', error: error.message });
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
