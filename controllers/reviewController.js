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
const mongoose = require('mongoose');
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
const { slaFor, slaOrder } = require('../utils/reviewSla');
const { computeReviewMetrics } = require('../utils/reviewMetrics');
const { resolveProfessional, actingProfessionalId } = require('../utils/resolveProfessional');

/**
 * Fields of an interpretation a clinician may amend.
 *
 * Defined beside the schema that produces them (`utils/interpretationSchema.js`) rather than
 * here, so `labtrack-shared` can generate the same list for both clients. A portal offering
 * an editor for a field this list omits would silently drop the edit — the server ignores
 * anything it does not recognise rather than rejecting it.
 */
const { AMENDABLE_FIELDS: AMENDABLE } = require('../utils/interpretationSchema');

/**
 * GET /api/reviews/queue
 *
 * Interpretations awaiting sign-off.
 *
 * The queue is the doctor workspace's front door, and three things about it are load-bearing:
 *
 *  - **It is interpretation-shaped, not report-shaped.** It covers every patient, so a
 *    blood-only case can legitimately be the most urgent thing in it.
 *  - **Every row carries its SLA state** from `utils/reviewSla.js`, computed server-side.
 *    A target each screen works out for itself is a target the queue, the dashboard and the
 *    export eventually disagree about.
 *  - **Filters narrow what is shown, never what may be seen.** Scope is
 *    `middleware/reviewScope.js`'s job; a query string is a convenience and is treated as
 *    one — which is why `assignment=mine` is a filter here and not a permission anywhere.
 *
 * Query: `assignment=all|mine|unclaimed|others`, `sla=all|breached|due_soon|on_track`,
 * `source=all|dna|blood`, `q=<patient name or email>`, `sort=waiting|sla`, `limit`, `skip`.
 */
exports.getQueue = async (req, res) => {
    try {
        const query = req.query || {};
        const {
            assignment = 'all',
            sla: slaFilter = 'all',
            source = 'all',
            q = '',
            sort = 'waiting',
        } = query;

        const limit = Math.min(Math.max(parseInt(query.limit, 10) || 100, 1), 200);
        const skip = Math.max(parseInt(query.skip, 10) || 0, 0);

        const filter = { 'review.status': 'pending' };

        /**
         * "Mine" means either id this clinician's work can be recorded under — the linked
         * `Professional` or the login account — for the same reason `getMyReviews` searches
         * both: a claim made before the directory link and one made after are the same
         * person, and matching only one of the two hides half their work.
         */
        const actingId = await actingProfessionalId(req.auth);
        const myIds = [...new Set([String(actingId), String(req.auth.userId)])]
            .filter((id) => mongoose.Types.ObjectId.isValid(id))
            .map((id) => new mongoose.Types.ObjectId(id));

        if (assignment === 'mine') filter['review.assignedTo'] = { $in: myIds };
        else if (assignment === 'unclaimed') filter['review.assignedTo'] = null;
        else if (assignment === 'others') filter['review.assignedTo'] = { $nin: [null, ...myIds] };

        /**
         * Patient search resolves to ids first.
         *
         * The name lives on `User`, not on the interpretation, so there is no way to do this
         * in one query without denormalising a patient's name onto every row — which would
         * put identifying data in a second place and leave it stale the day someone corrects
         * a spelling.
         */
        const search = String(q).trim();
        if (search) {
            const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            const matches = await User.find({
                $or: [{ firstName: rx }, { lastName: rx }, { email: rx }],
            }).select('_id').limit(200).lean();
            filter.userId = { $in: matches.map((m) => m._id) };
        }

        if (source === 'dna') filter['covers.kind'] = 'dna_report';
        else if (source === 'blood') filter['covers.kind'] = 'test_result';

        const pending = await Interpretation.find(filter)
            .sort({ generatedAt: 1 })
            .populate('userId', 'firstName lastName dob gender email')
            // Read wide enough that an SLA or source filter still has a full queue to work
            // over, then page after the derived fields exist. The queue is bounded by the
            // review backlog, which is hundreds at worst — not a collection scan.
            .limit(1000)
            .lean();

        // One lookup for every DNA report referenced across the queue, rather than one per
        // row: the pathogenic count is what lets a clinician pick the urgent ones first.
        const dnaIds = pending.flatMap((i) =>
            (i.covers || []).filter((c) => c.kind === 'dna_report').map((c) => c.id));
        const dnaReports = dnaIds.length
            ? await DnaReport.find({ _id: { $in: dnaIds } }).select('mutations').lean()
            : [];
        const mutationsById = new Map(dnaReports.map((d) => [String(d._id), d.mutations || []]));

        const now = new Date();
        let rows = pending.map((i) => {
            const mutations = (i.covers || [])
                .filter((c) => c.kind === 'dna_report')
                .flatMap((c) => mutationsById.get(String(c.id)) || []);

            const pathogenicCount = mutations.filter((m) =>
                ['pathogenic', 'likely_pathogenic'].includes(m.significance)).length;
            const highRiskCount = (i.content?.risks || []).filter((r) => r.level === 'high').length;

            const assignedTo = i.review?.assignedTo ? String(i.review.assignedTo) : null;

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
                pathogenicCount,
                // Surfaced for the same reason: a high-risk read should be picked first.
                highRiskCount,
                assignedTo,
                assignedAt: i.review?.assignedAt || null,
                /** Whether *this* clinician holds it — the only assignment question a row needs. */
                assignedToMe: Boolean(assignedTo && myIds.some((id) => String(id) === assignedTo)),
                sla: slaFor({ generatedAt: i.generatedAt, highRiskCount, pathogenicCount }, now),
            };
        });

        if (slaFilter !== 'all') rows = rows.filter((r) => r.sla.state === slaFilter);

        // Oldest first by default so nothing is left waiting; `sla` puts the most overdue
        // first, which is a different question and deliberately not the default — sorting by
        // breach hides a fresh urgent case behind a stale routine one.
        if (sort === 'sla') rows.sort((a, b) => slaOrder(a.sla) - slaOrder(b.sla));

        const total = rows.length;
        const counts = {
            breached: rows.filter((r) => r.sla.state === 'breached').length,
            dueSoon: rows.filter((r) => r.sla.state === 'due_soon').length,
            unclaimed: rows.filter((r) => !r.assignedTo).length,
            mine: rows.filter((r) => r.assignedToMe).length,
        };

        const page = rows.slice(skip, skip + limit);

        // The queue names patients, so opening it is itself a read of patient data — logged
        // as one entry with a count rather than one per row, which is what makes a bulk
        // browse distinguishable from opening a single case.
        await recordAccess({
            actor: req.auth,
            resource: 'queue',
            count: page.length,
        });

        res.json({ count: page.length, total, counts, interpretations: page });
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

        /**
         * The same clock the queue shows, and whether this clinician holds the case.
         *
         * Computed here rather than left to the screen so the detail view can never disagree
         * with the row that led to it — a case that reads "breached" in the queue and
         * "on track" once opened is a case nobody trusts either number on.
         */
        const pathogenicCount = (await countPathogenic([interpretation])).get(String(interpretation._id)) || 0;
        const highRiskCount = (interpretation.content?.risks || []).filter((r) => r.level === 'high').length;
        const holder = interpretation.review?.assignedTo ? String(interpretation.review.assignedTo) : null;
        const mine = await claimIdsFor(req.auth);

        res.json({
            interpretation,
            sources: { dnaReports, testResults },
            previous,
            sla: slaFor({ generatedAt: interpretation.generatedAt, highRiskCount, pathogenicCount }),
            assignment: {
                assignedTo: holder,
                assignedAt: interpretation.review?.assignedAt || null,
                assignedToMe: Boolean(holder && mine.some((id) => String(id) === holder)),
            },
        });
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
        /**
         * Match on whichever id this clinician's reviews were recorded under.
         *
         * Sign-off stores the linked `Professional` id where there is one and the
         * authenticated id otherwise, and a clinician may have reviewed cases either side of
         * being linked. Querying only one of the two silently hides half their history.
         */
        const actingId = await actingProfessionalId(req.auth);
        const ids = [...new Set([String(actingId), String(req.auth.userId)])];

        const interpretations = await Interpretation.find({ 'review.professionalId': { $in: ids } })
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

        /**
         * A case somebody else is holding is refused, not silently overwritten.
         *
         * This is the whole reason claiming exists: without it two clinicians can each spend
         * an hour on the same interpretation and the second sign-off quietly lands on top of
         * the first, appending its edits to theirs. `Interpretation` is append-only, so the
         * losing clinician's work is not lost — but the record would then say two people
         * reviewed a case neither knew the other had touched.
         *
         * 409, and the response names the holder's id so the portal can offer "take over"
         * rather than a dead end. Admins pass, matching the bypass they already have
         * throughout `middleware/ownership.js`.
         */
        const holder = interpretation.review?.assignedTo
            ? String(interpretation.review.assignedTo) : null;
        if (holder && req.auth.role !== 'admin') {
            const mine = await claimIdsFor(req.auth);
            if (!mine.some((id) => String(id) === holder)) {
                return res.status(409).json({
                    message: 'Another clinician has this case open. Take it over from the queue if they are not working on it.',
                    assignedTo: holder,
                    assignedAt: interpretation.review?.assignedAt || null,
                });
            }
        }

        /**
         * Who is signing this off.
         *
         * The linked `Professional` where one exists, otherwise the authenticated id — so
         * an administrator, or a clinician nobody has linked to a directory entry yet, can
         * still review. Attribution stays unambiguous either way; it simply points at a
         * `User` instead of a `Professional`.
         */
        const professionalId = await actingProfessionalId(req.auth);

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
            // The claim ends with the work. Leaving it set would make every signed case
            // look permanently held, and "who has this open" is a question about now.
            assignedTo: null,
            assignedAt: null,
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

        /**
         * The speciality has to be the schema's enum spelling, or the referral can never
         * resolve.
         *
         * `PlanItem.speciality` is free-text at the model level — nothing there would stop
         * "Cardiologist" being saved — but the app's professional directory matches on
         * `Professional.speciality`, whose values come from a fixed 48-entry enum. A value
         * outside it produces a follow-up nobody can ever be recommended for, and nothing
         * would say so until a patient looked for a specialist and found none. Checked here
         * rather than added to the model, because this is the one write path a human types
         * the value into; `planGeneratorV2` only ever copies it from the AI's own
         * schema-enforced output, which is already constrained.
         */
        if (speciality) {
            const allowed = Professional.schema.path('speciality').caster.enumValues;
            if (!allowed.includes(speciality)) {
                return res.status(400).json({
                    message: `Unknown speciality "${speciality}". Use the exact directory spelling, e.g. "Cardiology" not "Cardiologist".`,
                });
            }
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
            orderedByProfessionalId: await actingProfessionalId(req.auth),
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
/**
 * GET /api/reviews/profile — the signed-in clinician's directory record.
 *
 * Answers 200 with `professional: null` rather than 404 when no directory entry is linked.
 * That is a normal state, not an error: an administrator reviewing a case has no directory
 * entry and never will, and a newly invited clinician has one only once somebody attaches
 * it. A 404 here made every such caller look like a failure, and the portal's own
 * connection check read it as the API being broken.
 */
exports.getProfile = async (req, res) => {
    try {
        const professional = await resolveProfessional(req.auth);
        res.json({
            professional: professional || null,
            linked: Boolean(professional),
            role: req.auth.role,
        });
    } catch (error) {
        res.status(500).json({ message: 'Could not load your profile', error: error.message });
    }
};

/**
 * The ids a claim by this caller could have been recorded under.
 *
 * The linked `Professional` where one exists and the login account otherwise — the same
 * pair `getMyReviews` searches, for the same reason: a clinician linked to a directory
 * record halfway through a week made claims either side of the link, and they are the
 * same person.
 */
const claimIdsFor = async (auth) => {
    const actingId = await actingProfessionalId(auth);
    return [...new Set([String(actingId), String(auth.userId)])]
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => new mongoose.Types.ObjectId(id));
};

/**
 * How long a claim holds a case against another clinician.
 *
 * A claim is a coordination signal, not a lock, and the failure it must not cause is a case
 * parked forever because whoever opened it went on leave. After this long anyone may take
 * it over — the takeover is recorded, and the person who held it is named in the response
 * so it is a decision rather than an accident.
 */
const CLAIM_TTL_HOURS = 8;

/**
 * POST /api/reviews/:reportId/claim — take a case.
 *
 * Body: `{ takeover?: boolean }`. Claiming something already held by somebody else is a
 * 409 unless the claim has gone stale (`CLAIM_TTL_HOURS`) or `takeover` is explicit and the
 * caller is an admin.
 *
 * Deliberately **not** a permission. `middleware/reviewScope.js` already lets any clinician
 * see anything in the queue; if a claim gated access, an unclaimed case would be one nobody
 * could open in order to claim it.
 */
exports.claimReview = async (req, res) => {
    try {
        const interpretation = await Interpretation.findById(req.params.reportId);
        if (!interpretation) return res.status(404).json({ message: 'Interpretation not found' });

        if (interpretation.review?.status !== 'pending') {
            return res.status(409).json({
                message: 'This case has already been reviewed.',
                status: interpretation.review?.status,
            });
        }

        const mine = await claimIdsFor(req.auth);
        const holder = interpretation.review?.assignedTo ? String(interpretation.review.assignedTo) : null;
        const heldByMe = holder && mine.some((id) => String(id) === holder);

        if (holder && !heldByMe) {
            const heldFor = interpretation.review?.assignedAt
                ? (Date.now() - new Date(interpretation.review.assignedAt).getTime()) / 3_600_000
                : Infinity;
            const stale = heldFor >= CLAIM_TTL_HOURS;
            const forced = req.body?.takeover === true && req.auth.role === 'admin';

            if (!stale && !forced) {
                return res.status(409).json({
                    message: `Another clinician claimed this case ${Math.round(heldFor)}h ago. It can be taken over after ${CLAIM_TTL_HOURS}h.`,
                    assignedTo: holder,
                    assignedAt: interpretation.review?.assignedAt || null,
                    takeoverAvailableInHours: Math.max(0, Math.round(CLAIM_TTL_HOURS - heldFor)),
                });
            }

            console.log(`🔁 Interpretation ${interpretation._id} taken over from ${holder} by ${req.auth.userId} (${stale ? 'stale claim' : 'admin takeover'})`);
        }

        const actingId = await actingProfessionalId(req.auth);
        interpretation.review.assignedTo = actingId;
        interpretation.review.assignedAt = new Date();
        await interpretation.save();

        res.json({
            message: 'Case claimed',
            assignedTo: String(actingId),
            assignedAt: interpretation.review.assignedAt,
            tookOverFrom: holder && !heldByMe ? holder : null,
        });
    } catch (error) {
        console.error('❌ Claim failed:', error);
        res.status(500).json({ message: 'Could not claim the case', error: error.message });
    }
};

/**
 * POST /api/reviews/:reportId/release — put a case back.
 *
 * Only the holder or an admin, because releasing somebody else's claim is how two people
 * end up on the same case by accident — the thing claiming exists to stop.
 */
exports.releaseReview = async (req, res) => {
    try {
        const interpretation = await Interpretation.findById(req.params.reportId);
        if (!interpretation) return res.status(404).json({ message: 'Interpretation not found' });

        const holder = interpretation.review?.assignedTo ? String(interpretation.review.assignedTo) : null;
        if (!holder) return res.json({ message: 'Case was not claimed', assignedTo: null });

        const mine = await claimIdsFor(req.auth);
        const heldByMe = mine.some((id) => String(id) === holder);
        if (!heldByMe && req.auth.role !== 'admin') {
            return res.status(403).json({
                message: 'Only the clinician holding this case, or an administrator, can release it.',
                assignedTo: holder,
            });
        }

        interpretation.review.assignedTo = null;
        interpretation.review.assignedAt = null;
        await interpretation.save();

        res.json({ message: 'Case released', assignedTo: null });
    } catch (error) {
        console.error('❌ Release failed:', error);
        res.status(500).json({ message: 'Could not release the case', error: error.message });
    }
};

/**
 * Pathogenic variant count per interpretation, in one lookup for the whole set.
 *
 * Shared by the queue and the metrics backlog so both feed `slaFor` the same numbers. One
 * query for every DNA report referenced across the set, never one per row.
 */
const countPathogenic = async (interpretations) => {
    const ids = interpretations.flatMap((i) =>
        (i.covers || []).filter((c) => c.kind === 'dna_report').map((c) => c.id));
    if (!ids.length) return new Map();

    const reports = await DnaReport.find({ _id: { $in: ids } }).select('mutations').lean();
    const byReport = new Map(reports.map((d) => [String(d._id), (d.mutations || []).filter((m) =>
        ['pathogenic', 'likely_pathogenic'].includes(m.significance)).length]));

    return new Map(interpretations.map((i) => [
        String(i._id),
        (i.covers || [])
            .filter((c) => c.kind === 'dna_report')
            .reduce((sum, c) => sum + (byReport.get(String(c.id)) || 0), 0),
    ]));
};

/**
 * GET /api/reviews/metrics — how the review loop is performing.
 *
 * Query: `days` (default 30, max 365).
 *
 * The point of this screen is **not** productivity monitoring. It is the two questions the
 * product cannot answer without it: are patients being kept waiting, and which parts of the
 * interpretation do clinicians keep having to correct? The second is the only feedback path
 * from real clinical review back into the prompt, and until it existed a systematically bad
 * field could be rewritten every single time with nobody noticing.
 *
 * Reads no patient content — counts, dates and field names only — so unlike every other
 * route in this controller it is not a read of anybody's record and writes no access-log
 * entry. Adding a patient name to this response would change that, and the log entry with
 * it.
 */
exports.getReviewMetrics = async (req, res) => {
    try {
        const days = Math.min(Math.max(parseInt(req.query?.days, 10) || 30, 1), 365);
        const since = new Date(Date.now() - days * 86_400_000);

        const [signed, pending] = await Promise.all([
            Interpretation.find({
                'review.status': { $in: Interpretation.SIGNED_STATUSES },
                'review.reviewedAt': { $gte: since },
            }).select('generatedAt review.status review.reviewedAt review.professionalId review.edits').lean(),
            Interpretation.find({ 'review.status': 'pending' })
                .select('generatedAt content.risks covers').lean(),
        ]);

        const metrics = computeReviewMetrics(signed, pending);

        // Names for the per-clinician rows. Ids alone make the table unreadable, and this is
        // directory data — who the clinicians are — not patient data.
        const ids = metrics.byClinician
            .map((c) => c.professionalId)
            .filter((id) => mongoose.Types.ObjectId.isValid(id));
        const professionals = ids.length
            ? await Professional.find({ _id: { $in: ids } }).select('firstname lastname speciality').lean()
            : [];
        const nameById = new Map(professionals.map((p) => [String(p._id), `${p.firstname || ''} ${p.lastname || ''}`.trim()]));

        /**
         * SLA state across the live backlog.
         *
         * Computed from the same table *and the same inputs* the queue uses — including the
         * pathogenic count, which means the same DNA lookup. Passing a zero here instead
         * would have been cheaper and would have quietly filed every genetic case one
         * priority lower than the queue shows, which is exactly the disagreement holding the
         * table in one file is supposed to prevent.
         */
        const now = new Date();
        const slaCounts = { breached: 0, due_soon: 0, on_track: 0, unknown: 0 };
        const pathogenicByInterpretation = await countPathogenic(pending);
        for (const row of pending) {
            const state = slaFor({
                generatedAt: row.generatedAt,
                highRiskCount: (row.content?.risks || []).filter((r) => r.level === 'high').length,
                pathogenicCount: pathogenicByInterpretation.get(String(row._id)) || 0,
            }, now).state;
            slaCounts[state] += 1;
        }

        res.json({
            windowDays: days,
            since,
            ...metrics,
            backlog: { ...metrics.backlog, sla: slaCounts },
            byClinician: metrics.byClinician.map((c) => ({
                ...c,
                name: nameById.get(c.professionalId) || null,
            })),
        });
    } catch (error) {
        console.error('❌ Review metrics failed:', error);
        res.status(500).json({ message: 'Could not compute review metrics', error: error.message });
    }
};
