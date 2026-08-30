/**
 * Medication checker — list, schedule, adherence, identification and interaction checking.
 *
 * Three rules run through every handler here, and each has a counterpart elsewhere in the
 * codebase that was learned the hard way:
 *
 *   1. **Analysis never writes.** `POST /identify` returns a draft; `POST /` is the only
 *      call that adds a medication. Same checkpoint report ingestion puts between a misread
 *      digit and the record, and nutrition puts between an estimate and a meal log. A drug
 *      name that reaches a medication list without a person confirming it is a drug name
 *      that reaches their interaction check.
 *   2. **Deleting archives.** The dose history is the answer to "what was I on in March",
 *      and a person tidying their list should not destroy it.
 *   3. **A check never says "safe".** Every response that carries findings also carries
 *      `uncheckable` and `SAFETY_FOOTER`. Silence from the rule table means nothing was
 *      found among what could be checked — see `medicationCatalogue`.
 */
const fs = require('fs');
const mongoose = require('mongoose');
const Medication = require('../models/Medication');
const MedicationDose = require('../models/MedicationDose');
const MedicationCheck = require('../models/MedicationCheck');
const User = require('../models/userModel');
const catalogue = require('../utils/medicationCatalogue');
const schedule = require('../utils/medicationSchedule');
const engine = require('../utils/medicationEngine');
const { uploadImageOrNull } = require('../utils/imageStore');
const scoreController = require('./scoreController');

const MAX_BYTES = 10 * 1024 * 1024;

/** How far ahead doses are written when a timeline is read. */
const MATERIALISE_AHEAD_DAYS = 30;

const todayFor = (tzOffset) => schedule.localDay(new Date(), Number(tzOffset) || 0);

const isObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

/** Conditions from the health assessment, for the drug↔condition rules. */
const conditionsOf = (user) =>
    (user?.healthAssessment?.conditions || [])
        .filter((c) => c.status !== 'Resolved')
        .map((c) => c.name)
        .filter(Boolean);

const allergiesOf = (user) =>
    (user?.healthAssessment?.allergies || []).map((a) => a.allergen).filter(Boolean);

/**
 * Write the dose rows a medication should have over a window, without duplicating any.
 *
 * Idempotent by construction: every write is an upsert on `{ medicationId, scheduledFor }`,
 * which the model declares unique. Two devices opening the timeline at the same moment
 * therefore produce one row each, not two, and re-reading a week never grows the collection.
 *
 * Only `scheduled` rows are ever touched. A dose the person has taken or skipped keeps its
 * state even if the medication's schedule has since changed — that record is history now.
 */
const materialise = async (medication, fromDay, toDay) => {
    const wanted = schedule.expand(medication, fromDay, toDay);
    if (!wanted.length) return 0;

    const ops = wanted.map((d) => ({
        updateOne: {
            filter: { medicationId: medication._id, scheduledFor: d.scheduledFor },
            update: {
                $setOnInsert: {
                    userId: medication.userId,
                    medicationId: medication._id,
                    day: d.day,
                    time: d.time,
                    scheduledFor: d.scheduledFor,
                    status: 'scheduled',
                    medicationName: medication.name,
                },
            },
            upsert: true,
        },
    }));

    const result = await MedicationDose.bulkWrite(ops, { ordered: false });
    return result.upsertedCount || 0;
};

/** Materialise every active medication for a window. Used by the timeline reads. */
const materialiseAll = async (userId, fromDay, toDay) => {
    const meds = await Medication.find({ userId, active: true });
    let written = 0;
    for (const med of meds) written += await materialise(med, fromDay, toDay);
    return { medications: meds, written };
};

/**
 * Remove future `scheduled` rows for a medication.
 *
 * Called when a schedule changes or a medication is archived. Deliberately bounded to doses
 * that are still in the future AND still untouched: a dose already taken is a fact about the
 * past, and an edit made today must not be able to erase it.
 */
const clearFutureDoses = async (medicationId, fromInstant = new Date()) =>
    MedicationDose.deleteMany({
        medicationId,
        status: 'scheduled',
        scheduledFor: { $gte: fromInstant },
    });

// ── Status ───────────────────────────────────────────────────────────────────────────

/**
 * GET /api/medications/status — what this server can actually do.
 *
 * The client draws the scan control only when `scan` is true, the same line `InputDock`
 * takes with the assistant's microphone: a camera button that appears live and fails on tap
 * is worse than one that arrives greyed with a reason.
 *
 * `interactionCheck` is true even without an API key, because the rule table is the half
 * that catches the dangerous pairs and it needs no model.
 */
exports.getStatus = async (req, res) => {
    res.json({
        scan: engine.isConfigured(),
        interactionCheck: true,
        aiReview: engine.isConfigured(),
        catalogueSize: catalogue.catalogueList().length,
        identifyModel: engine.isConfigured() ? engine.IDENTIFY_MODEL : null,
        reviewModel: engine.isConfigured() ? engine.REVIEW_MODEL : null,
        acceptedTypes: engine.ACCEPTED_MEDIA,
        maxBytes: MAX_BYTES,
        confidenceThreshold: engine.CONFIDENCE_THRESHOLD,
    });
};

// ── The catalogue ────────────────────────────────────────────────────────────────────

/** GET /api/medications/catalogue?q=&limit= — the design's search and A-Z browse. */
exports.searchCatalogue = async (req, res) => {
    try {
        const { q, limit } = req.query;
        const results = catalogue.search(q, Math.min(Number(limit) || 25, 100));
        res.json({ query: q || '', count: results.length, results });
    } catch (error) {
        console.error('❌ Catalogue search failed:', error);
        res.status(500).json({ message: 'Could not search the catalogue' });
    }
};

/** GET /api/medications/catalogue/:name — the plain-language entry for one drug. */
exports.getCatalogueEntry = async (req, res) => {
    try {
        const entry = catalogue.explain(req.params.name);
        if (!entry) {
            // 404 with the searched name, so the client can render the design's
            // "Medication Not found" screen with the term the person actually typed.
            return res.status(404).json({ message: 'Not in the catalogue', name: req.params.name });
        }

        // What this drug interacts with in food and drink — the design's "Drug interactions"
        // section on the detail screen, answered from the rule table rather than from prose
        // in the entry, so the two can never disagree.
        //
        // Only food rules: drug-to-drug findings depend on what else the person takes and
        // belong to `/check`, which knows their list. Answering them from a single drug
        // would either be a list of everything it could clash with (useless) or an empty
        // list read as safety (worse).
        const { findings } = catalogue.runRules([{ name: entry.key }], []);
        res.json({
            ...entry,
            foodInteractions: findings.filter((f) => f.kind === 'food'),
            safetyNote: catalogue.SAFETY_FOOTER,
        });
    } catch (error) {
        console.error('❌ Catalogue entry failed:', error);
        res.status(500).json({ message: 'Could not load that medication' });
    }
};

// ── The person's list ────────────────────────────────────────────────────────────────

/** GET /api/medications — the list, with the catalogue entry attached where we have one. */
exports.listMedications = async (req, res) => {
    try {
        const userId = req.auth.userId;
        const includeArchived = req.query.includeArchived === 'true';

        const medications = await Medication.find({
            userId,
            ...(includeArchived ? {} : { active: true }),
        }).sort({ active: -1, createdAt: -1 }).lean();

        res.json({
            medications: medications.map((m) => ({
                ...m,
                catalogue: catalogue.explain(m.name),
                needsRefill: schedule.needsRefill(m),
            })),
        });
    } catch (error) {
        console.error('❌ Listing medications failed:', error);
        res.status(500).json({ message: 'Could not load your medications' });
    }
};

/** Fields a client may set. Anything else is ignored rather than trusted. */
const pickWritable = (body) => {
    const out = {};
    const fields = [
        'name', 'brandName', 'strength', 'form', 'shape', 'colour', 'imprint',
        'frequency', 'times', 'daysOfWeek', 'intervalDays', 'startDay', 'endDay',
        'tzOffset', 'dose', 'withFood', 'remainingDoses', 'refillReminder',
        'refillThreshold', 'notes', 'remindersEnabled', 'imageUrl', 'source',
    ];
    for (const f of fields) if (body[f] !== undefined) out[f] = body[f];

    // Times are compared and sorted all over the schedule engine; normalise once, here.
    if (Array.isArray(out.times)) {
        out.times = [...new Set(out.times.filter(schedule.isTimeString))].sort();
    }
    if (Array.isArray(out.daysOfWeek)) {
        out.daysOfWeek = [...new Set(out.daysOfWeek.map(Number).filter((d) => d >= 0 && d <= 6))].sort();
    }
    return out;
};

/** POST /api/medications — add one. The only call that writes a medication. */
exports.createMedication = async (req, res) => {
    try {
        const userId = req.auth.userId;
        const body = pickWritable(req.body);

        if (!body.name || !String(body.name).trim()) {
            return res.status(400).json({ message: 'A medication name is required' });
        }
        if (body.startDay && !schedule.isDayString(body.startDay)) {
            return res.status(400).json({ message: 'startDay must be YYYY-MM-DD' });
        }
        if (body.endDay && !schedule.isDayString(body.endDay)) {
            return res.status(400).json({ message: 'endDay must be YYYY-MM-DD' });
        }
        if (body.startDay && body.endDay && body.endDay < body.startDay) {
            return res.status(400).json({ message: 'endDay cannot be before startDay' });
        }

        const tzOffset = Number(body.tzOffset ?? req.body.tzOffset) || 0;

        const medication = await Medication.create({
            ...body,
            userId,
            tzOffset,
            startDay: body.startDay || todayFor(tzOffset),
            identification: req.body.identification || undefined,
        });

        // Write the near-term doses now, so the schedule screen is populated the moment the
        // person lands on it after the design's "Medication successfully added" sheet.
        const from = todayFor(tzOffset);
        await materialise(medication, from, schedule.addDays(from, MATERIALISE_AHEAD_DAYS));

        // The list changed, so any stored check is now about a different set of medicines.
        await invalidateCheck(userId);

        console.log(`💊 Medication added: ${medication.name} for ${userId}`);
        res.status(201).json({
            medication: { ...medication.toObject(), catalogue: catalogue.explain(medication.name) },
        });
    } catch (error) {
        console.error('❌ Creating medication failed:', error);
        res.status(500).json({ message: 'Could not add that medication' });
    }
};

/** PUT /api/medications/:id */
exports.updateMedication = async (req, res) => {
    try {
        const { id } = req.params;
        if (!isObjectId(id)) return res.status(400).json({ message: 'Invalid medication id' });

        const medication = await Medication.findOne({ _id: id, userId: req.auth.userId });
        if (!medication) return res.status(404).json({ message: 'Medication not found' });

        const body = pickWritable(req.body);
        if (body.endDay && body.startDay && body.endDay < body.startDay) {
            return res.status(400).json({ message: 'endDay cannot be before startDay' });
        }

        // Did anything that changes when doses fall change?
        const scheduleKeys = ['frequency', 'times', 'daysOfWeek', 'intervalDays', 'startDay', 'endDay', 'tzOffset'];
        const scheduleChanged = scheduleKeys.some(
            (k) => body[k] !== undefined && JSON.stringify(body[k]) !== JSON.stringify(medication[k])
        );

        Object.assign(medication, body);
        // Validators run on save(); `findByIdAndUpdate` skips them, which is gotcha 10 in
        // CLAUDE.md and is exactly how enum fields elsewhere ended up with junk in them.
        await medication.save();

        if (scheduleChanged) {
            // Future untaken doses only. History stands.
            await clearFutureDoses(medication._id);
            const from = todayFor(medication.tzOffset);
            await materialise(medication, from, schedule.addDays(from, MATERIALISE_AHEAD_DAYS));
        }

        if (body.name) {
            await MedicationDose.updateMany({ medicationId: medication._id }, { medicationName: medication.name });
            await invalidateCheck(req.auth.userId);
        }

        res.json({
            medication: { ...medication.toObject(), catalogue: catalogue.explain(medication.name) },
            rescheduled: scheduleChanged,
        });
    } catch (error) {
        console.error('❌ Updating medication failed:', error);
        res.status(500).json({ message: 'Could not update that medication' });
    }
};

/**
 * DELETE /api/medications/:id — archive, or purge with `?purge=true`.
 *
 * The default archives. The design's "Delete Medication?" sheet says "delete", and for the
 * person it is one: it leaves their list. But taking the dose history with it would destroy
 * the answer to what they were taking when a symptom started, which is the question this
 * data exists to answer.
 */
exports.deleteMedication = async (req, res) => {
    try {
        const { id } = req.params;
        if (!isObjectId(id)) return res.status(400).json({ message: 'Invalid medication id' });

        const medication = await Medication.findOne({ _id: id, userId: req.auth.userId });
        if (!medication) return res.status(404).json({ message: 'Medication not found' });

        if (req.query.purge === 'true') {
            await MedicationDose.deleteMany({ medicationId: medication._id });
            await medication.deleteOne();
            await invalidateCheck(req.auth.userId);
            return res.json({ deleted: true, purged: true });
        }

        medication.active = false;
        medication.archivedAt = new Date();
        medication.remindersEnabled = false;
        await medication.save();

        // Stop reminding about a medication they have stopped, but keep what they took.
        await clearFutureDoses(medication._id);
        await invalidateCheck(req.auth.userId);

        res.json({ deleted: true, purged: false, archivedAt: medication.archivedAt });
    } catch (error) {
        console.error('❌ Deleting medication failed:', error);
        res.status(500).json({ message: 'Could not remove that medication' });
    }
};

// ── The schedule ─────────────────────────────────────────────────────────────────────

/**
 * GET /api/medications/schedule?day=&tzOffset= — the design's daily timeline.
 *
 * Doses for the day are materialised on read. That is a write on a GET, which is normally
 * worth avoiding, but the alternative is a nightly job that has to guess how far ahead to
 * generate for every user in the system — and a person who opens the app after two months
 * away would find an empty timeline until it next ran.
 */
exports.getSchedule = async (req, res) => {
    try {
        const userId = req.auth.userId;
        const tzOffset = Number(req.query.tzOffset) || 0;
        const day = schedule.isDayString(req.query.day) ? req.query.day : todayFor(tzOffset);

        await materialiseAll(userId, day, schedule.addDays(day, MATERIALISE_AHEAD_DAYS));

        const doses = await MedicationDose.find({ userId, day }).sort({ scheduledFor: 1 }).lean();

        const medIds = [...new Set(doses.map((d) => String(d.medicationId)))];
        const meds = await Medication.find({ _id: { $in: medIds } }).lean();
        const byId = new Map(meds.map((m) => [String(m._id), m]));

        res.json({
            day,
            doses: doses.map((d) => {
                const med = byId.get(String(d.medicationId));
                return {
                    ...d,
                    punctuality: schedule.punctuality(d),
                    medication: med ? {
                        _id: med._id,
                        name: med.name,
                        brandName: med.brandName,
                        strength: med.strength,
                        form: med.form,
                        shape: med.shape,
                        colour: med.colour,
                        dose: med.dose,
                        withFood: med.withFood,
                        plainName: catalogue.explain(med.name)?.plainName || null,
                    } : null,
                };
            }),
            adherence: schedule.adherence(doses),
        });
    } catch (error) {
        console.error('❌ Loading schedule failed:', error);
        res.status(500).json({ message: 'Could not load your schedule' });
    }
};

/**
 * GET /api/medications/calendar?from=&to= — the design's monthly grid.
 * One entry per day with a status, not a list of doses: the grid draws a tick, a cross or a
 * clock per square, and shipping every dose to draw thirty glyphs is wasted payload.
 */
exports.getCalendar = async (req, res) => {
    try {
        const userId = req.auth.userId;
        const tzOffset = Number(req.query.tzOffset) || 0;
        const today = todayFor(tzOffset);

        const from = schedule.isDayString(req.query.from) ? req.query.from : schedule.addDays(today, -30);
        const to = schedule.isDayString(req.query.to) ? req.query.to : schedule.addDays(today, 30);

        if (schedule.daysBetween(from, to) > 400) {
            return res.status(400).json({ message: 'Range too large — ask for a year at most' });
        }

        await materialiseAll(userId, today, to);

        const doses = await MedicationDose.find({ userId, day: { $gte: from, $lte: to } })
            .select('day status scheduledFor takenAt medicationId')
            .lean();

        res.json({
            from,
            to,
            days: schedule.byDay(doses),
            adherence: schedule.adherence(doses),
        });
    } catch (error) {
        console.error('❌ Loading calendar failed:', error);
        res.status(500).json({ message: 'Could not load your calendar' });
    }
};

/**
 * PATCH /api/medications/doses/:id — take, skip, or reschedule one dose.
 *
 * The three actions on the design's dose sheet. Taking a dose decrements the packet when the
 * person is tracking supply, which is what makes the refill reminder mean anything.
 */
exports.updateDose = async (req, res) => {
    try {
        const { id } = req.params;
        if (!isObjectId(id)) return res.status(400).json({ message: 'Invalid dose id' });

        const { action, at, note } = req.body;
        if (!['take', 'skip', 'reschedule', 'undo'].includes(action)) {
            return res.status(400).json({ message: 'action must be take, skip, reschedule or undo' });
        }

        const dose = await MedicationDose.findOne({ _id: id, userId: req.auth.userId });
        if (!dose) return res.status(404).json({ message: 'Dose not found' });

        const medication = await Medication.findById(dose.medicationId);
        const wasTaken = dose.status === 'taken';

        if (action === 'take') {
            dose.status = 'taken';
            dose.takenAt = at ? new Date(at) : new Date();
        } else if (action === 'skip') {
            dose.status = 'skipped';
            dose.takenAt = null;
        } else if (action === 'undo') {
            dose.status = 'scheduled';
            dose.takenAt = null;
            dose.rescheduledTo = null;
        } else if (action === 'reschedule') {
            if (!at) return res.status(400).json({ message: 'reschedule needs a new time in `at`' });
            const when = new Date(at);
            if (Number.isNaN(when.getTime())) return res.status(400).json({ message: 'Invalid date in `at`' });

            dose.rescheduledTo = when;
            dose.scheduledFor = when;
            dose.day = schedule.localDay(when, medication?.tzOffset ?? 0);
            dose.time = `${String(when.getUTCHours()).padStart(2, '0')}:${String(when.getUTCMinutes()).padStart(2, '0')}`;
            dose.status = 'scheduled';
            // A moved dose has not been announced yet, so let the reminder fire at the new time
            dose.remindedAt = null;
        }

        if (note !== undefined) dose.note = note;
        await dose.save();

        // Supply tracking. Only moves on the transition into or out of `taken`, so tapping
        // "Taken" twice cannot count two tablets out of the packet.
        if (medication && typeof medication.remainingDoses === 'number') {
            const nowTaken = dose.status === 'taken';
            if (!wasTaken && nowTaken) {
                medication.remainingDoses = Math.max(0, medication.remainingDoses - 1);
                await medication.save();
            } else if (wasTaken && !nowTaken) {
                medication.remainingDoses += 1;
                await medication.save();
            }
        }

        // Recomputed in the background so the score reflects this the next time the home
        // screen asks, rather than fifteen minutes later. Never awaited: a scoring failure
        // must not be able to fail the write the person actually made.
        scoreController.touch(req.auth.userId, 'log');

        res.json({
            dose: { ...dose.toObject(), punctuality: schedule.punctuality(dose) },
            remainingDoses: medication?.remainingDoses ?? null,
            needsRefill: medication ? schedule.needsRefill(medication) : false,
        });
    } catch (error) {
        console.error('❌ Updating dose failed:', error);
        res.status(500).json({ message: 'Could not update that dose' });
    }
};

// ── Insight ──────────────────────────────────────────────────────────────────────────

/**
 * GET /api/medications/insight?days= — the design's Medication Insight screen.
 * Most consumed, per-medication adherence, and a weekday breakdown.
 */
exports.getInsight = async (req, res) => {
    try {
        const userId = req.auth.userId;
        const days = Math.min(Math.max(Number(req.query.days) || 30, 7), 365);
        const tzOffset = Number(req.query.tzOffset) || 0;
        const today = todayFor(tzOffset);
        const from = schedule.addDays(today, -days);

        const doses = await MedicationDose.find({ userId, day: { $gte: from, $lte: today } }).lean();

        // Per medication
        const groups = new Map();
        for (const d of doses) {
            const key = String(d.medicationId);
            if (!groups.has(key)) groups.set(key, { name: d.medicationName, doses: [] });
            groups.get(key).doses.push(d);
        }

        const perMedication = [...groups.entries()]
            .map(([medicationId, g]) => ({
                medicationId,
                name: g.name,
                plainName: catalogue.explain(g.name)?.plainName || null,
                taken: g.doses.filter((d) => d.status === 'taken').length,
                adherence: schedule.adherence(g.doses),
            }))
            .sort((a, b) => b.taken - a.taken);

        // By weekday, for the design's bar chart. 0 = Sunday.
        const weekdays = Array.from({ length: 7 }, () => ({ taken: 0, late: 0, missed: 0 }));
        for (const d of doses) {
            const bucket = weekdays[schedule.weekdayOf(d.day)];
            if (d.status === 'taken') {
                if (schedule.punctuality(d) === 'late') bucket.late++;
                else bucket.taken++;
            } else if (d.status === 'scheduled' && new Date(d.scheduledFor) <= new Date()) {
                bucket.missed++;
            }
        }

        res.json({
            from,
            to: today,
            days,
            totalTaken: doses.filter((d) => d.status === 'taken').length,
            adherence: schedule.adherence(doses),
            mostConsumed: perMedication[0] || null,
            perMedication,
            weekdays,
        });
    } catch (error) {
        console.error('❌ Loading insight failed:', error);
        res.status(500).json({ message: 'Could not load your medication insight' });
    }
};

// ── Identification ───────────────────────────────────────────────────────────────────

/**
 * POST /api/medications/identify — photograph a pill or a packet.
 *
 * Writes nothing. Returns a draft the person confirms on the design's Scan Result screen,
 * and `POST /medications` is what actually saves it. The picture goes to Cloudflare
 * best-effort, exactly as the assistant does: losing a thumbnail must not cost an answer.
 */
exports.identifyMedication = async (req, res) => {
    const path = req.file?.path;
    try {
        if (!req.file) return res.status(400).json({ message: 'No image was uploaded' });

        if (!engine.isConfigured()) {
            return res.status(503).json({
                message: 'Medication scanning is not available on this server. You can still add a medication by hand.',
            });
        }
        if (!engine.ACCEPTED_MEDIA.includes(req.file.mimetype)) {
            return res.status(400).json({
                message: `Unsupported image type. Use one of: ${engine.ACCEPTED_MEDIA.join(', ')}`,
            });
        }
        if (req.file.size > MAX_BYTES) {
            return res.status(400).json({ message: 'That image is too large. 10MB is the limit.' });
        }

        const buffer = fs.readFileSync(path);
        const result = await engine.identify(buffer, req.file.mimetype, req.body.note);

        if (!result.ok) return res.status(502).json({ message: result.error });
        if (!result.data.detected) {
            // The design's "We couldn't find your medication" screen, with its two ways out.
            return res.status(200).json({
                detected: false,
                message: "We couldn't find a medicine in that photo.",
                hint: 'Try the box or the blister strip rather than a loose tablet — a printed name is far more reliable.',
            });
        }

        const imageUrl = await uploadImageOrNull(path);
        const draft = engine.toMedicationDraft(result.data);

        res.json({
            detected: true,
            draft: { ...draft, imageUrl },
            catalogue: result.data.catalogue,
            confidence: result.data.confidence,
            /** Below the threshold the client shows alternatives first, not a single answer. */
            needsConfirmation: (result.data.confidence ?? 0) < engine.CONFIDENCE_THRESHOLD,
            alternatives: result.data.alternatives || [],
            warnings: result.data.warnings || [],
            basis: result.data.basis,
            model: result.model,
        });
    } catch (error) {
        console.error('❌ Identification failed:', error);
        res.status(500).json({ message: 'Could not analyse that image' });
    } finally {
        if (path) fs.unlink(path, () => {});
    }
};

// ── Interaction checking ─────────────────────────────────────────────────────────────

/** A stored check is about a specific list. Mark it stale when the list moves. */
const invalidateCheck = async (userId) => {
    // Nothing is deleted — `MedicationCheck` is append-only. Staleness is derived by
    // comparing names at read time, so there is nothing to write here. The function exists
    // as the single place that documents that, and as the hook if a cache is ever added.
    return null;
};

const namesOf = (medications) => medications.map((m) => m.name.toLowerCase().trim()).sort();

/**
 * Run the check.
 *
 * The rule table runs first and always. The model is asked for prose and for anything the
 * table missed, and `mergeFindings` guarantees it cannot weaken what the table produced.
 * Without an API key this degrades to the rules alone rather than failing — the rules are
 * the part that catches warfarin and ibuprofen.
 */
const runCheck = async (userId, { includeConditions = true } = {}) => {
    const [medications, user] = await Promise.all([
        Medication.find({ userId, active: true }).lean(),
        User.findById(userId).select('healthAssessment').lean(),
    ]);

    const conditions = includeConditions ? conditionsOf(user) : [];
    const allergies = allergiesOf(user);

    const { findings, uncheckable, checkedCount } = catalogue.runRules(medications, conditions);

    let payload;
    let degraded = false;
    let model = null;

    if (engine.isConfigured() && medications.length) {
        const result = await engine.review({
            medications, findings, uncheckable, conditions, allergies,
        });
        if (result.ok) {
            payload = result.data;
            model = result.model;
        } else {
            console.warn('⚠️  Interaction review fell back to rules only:', result.error);
            payload = engine.ruleOnlyReview({ findings, uncheckable, checkedCount });
            degraded = true;
        }
    } else {
        payload = engine.ruleOnlyReview({ findings, uncheckable, checkedCount });
        degraded = !engine.isConfigured();
    }

    const check = await MedicationCheck.create({
        userId,
        medicationNames: namesOf(medications),
        summary: payload.summary,
        findings: payload.findings,
        uncheckable,
        checkedCount,
        timingAdvice: payload.timingAdvice,
        questionsForClinician: payload.questionsForClinician,
        worstSeverity: catalogue.worstSeverity(payload.findings),
        degraded,
        model,
        generatedAt: new Date(),
    });

    /**
     * Persist what the model worked out about drugs the catalogue could not classify.
     *
     * This is the one place model output influences a later deterministic run, so it is
     * deliberately narrow: classes are filtered against `KNOWN_CLASSES`, so a hallucinated
     * class name is dropped rather than stored, and it only ever *adds* coverage for a drug
     * that had none. It cannot reclassify a drug the catalogue already knows.
     */
    for (const c of payload.classifications || []) {
        if (!c.resolvedName || !c.classes?.length) continue;
        if (catalogue.lookup(c.name)) continue;
        const valid = c.classes.filter((cl) => catalogue.KNOWN_CLASSES.includes(cl));
        if (!valid.length) continue;
        console.log(`💊 Model classified uncatalogued drug "${c.name}" as ${valid.join(', ')} — consider a catalogue entry`);
    }

    return check;
};

/** POST /api/medications/check — run a fresh check. */
exports.runInteractionCheck = async (req, res) => {
    try {
        const check = await runCheck(req.auth.userId);
        res.json({ check: check.toObject(), safetyNote: catalogue.SAFETY_FOOTER, stale: false });
    } catch (error) {
        console.error('❌ Interaction check failed:', error);
        res.status(500).json({ message: 'Could not run the interaction check' });
    }
};

/**
 * GET /api/medications/check — the stored check, with staleness reported.
 *
 * Never runs a check implicitly. A GET that spends money and takes several seconds is a GET
 * that gets called from a `useFocusEffect` and bills for every tab switch. The client sees
 * `stale: true` and offers to re-run.
 */
exports.getInteractionCheck = async (req, res) => {
    try {
        const userId = req.auth.userId;

        const [check, medications] = await Promise.all([
            MedicationCheck.findOne({ userId }).sort({ generatedAt: -1 }).lean(),
            Medication.find({ userId, active: true }).select('name').lean(),
        ]);

        if (!check) {
            return res.json({
                check: null,
                stale: medications.length > 0,
                medicationCount: medications.length,
                safetyNote: catalogue.SAFETY_FOOTER,
            });
        }

        const current = namesOf(medications);
        const stale = JSON.stringify(current) !== JSON.stringify(check.medicationNames || []);

        res.json({ check, stale, medicationCount: medications.length, safetyNote: catalogue.SAFETY_FOOTER });
    } catch (error) {
        console.error('❌ Loading interaction check failed:', error);
        res.status(500).json({ message: 'Could not load your interaction check' });
    }
};

/**
 * POST /api/medications/check/preview — "what if I added this?"
 *
 * The design's flow puts a scan result in front of someone before it is on their list, and
 * "would this clash with what I already take" is the question that actually matters at that
 * moment. Rules only, no model call: it runs on every scan result and must be instant and
 * free. Writes nothing.
 */
exports.previewInteractions = async (req, res) => {
    try {
        const { name } = req.body;
        if (!name || !String(name).trim()) {
            return res.status(400).json({ message: 'A medication name is required' });
        }

        const userId = req.auth.userId;
        const [existing, user] = await Promise.all([
            Medication.find({ userId, active: true }).select('name').lean(),
            User.findById(userId).select('healthAssessment').lean(),
        ]);

        const conditions = conditionsOf(user);
        const candidate = { name: String(name).trim() };

        const before = catalogue.runRules(existing, conditions);
        const after = catalogue.runRules([...existing, candidate], conditions);

        // Only what this addition introduces. Showing findings they already had would bury
        // the one thing they are being asked to decide about.
        const beforeKeys = new Set(before.findings.map((f) => `${f.id}::${[...f.between].sort().join('|')}`));
        const introduced = after.findings.filter(
            (f) => !beforeKeys.has(`${f.id}::${[...f.between].sort().join('|')}`)
        );

        res.json({
            name: candidate.name,
            known: Boolean(catalogue.lookup(candidate.name)),
            catalogue: catalogue.explain(candidate.name),
            introduced,
            worstSeverity: catalogue.worstSeverity(introduced),
            /**
             * True when we could not classify the candidate at all. The client must not
             * render an empty `introduced` as reassurance in that case — nothing was tested.
             */
            uncheckable: !catalogue.lookup(candidate.name),
            safetyNote: catalogue.SAFETY_FOOTER,
        });
    } catch (error) {
        console.error('❌ Interaction preview failed:', error);
        res.status(500).json({ message: 'Could not check that medication' });
    }
};

// ── Import from the health assessment ────────────────────────────────────────────────

/**
 * POST /api/medications/import — offer the health assessment's answers as real medications.
 *
 * One direction only. The assessment is a snapshot of what someone typed during onboarding;
 * this collection is the living record. Writing back would let a scan quietly rewrite an
 * answer a clinician may have reviewed.
 *
 * Returns what it would import when called with `{ dryRun: true }`, so the client can show
 * the list and let the person choose rather than silently populating their schedule.
 */
exports.importFromAssessment = async (req, res) => {
    try {
        const userId = req.auth.userId;
        const tzOffset = Number(req.body.tzOffset) || 0;

        const [user, existing] = await Promise.all([
            User.findById(userId).select('healthAssessment').lean(),
            Medication.find({ userId }).select('name').lean(),
        ]);

        const have = new Set(existing.map((m) => catalogue.slug(m.name)));
        const candidates = (user?.healthAssessment?.medications || [])
            .filter((m) => m.isCurrentlyTaking !== false && m.name)
            .filter((m) => !have.has(catalogue.slug(m.name)))
            .map((m) => ({
                name: m.name.trim(),
                strength: m.dosage || null,
                notes: m.notes || null,
                catalogue: catalogue.explain(m.name),
            }));

        if (req.body.dryRun) {
            return res.json({ candidates, count: candidates.length });
        }

        const names = Array.isArray(req.body.names) ? req.body.names.map(catalogue.slug) : null;
        const chosen = names ? candidates.filter((c) => names.includes(catalogue.slug(c.name))) : candidates;

        const created = [];
        for (const c of chosen) {
            const med = await Medication.create({
                userId,
                name: c.name,
                strength: c.strength,
                notes: c.notes,
                form: c.catalogue?.form || 'tablet',
                // Deliberately `as_needed`: the assessment records what someone takes, not
                // when. Inventing a 9am daily dose would produce a reminder for a schedule
                // nobody entered, and a wrong reminder is how people mute the real ones.
                frequency: 'as_needed',
                startDay: todayFor(tzOffset),
                tzOffset,
                source: 'assessment',
                remindersEnabled: false,
            });
            created.push(med);
        }

        console.log(`💊 Imported ${created.length} medications from the assessment for ${userId}`);
        res.status(201).json({ imported: created.length, medications: created });
    } catch (error) {
        console.error('❌ Importing medications failed:', error);
        res.status(500).json({ message: 'Could not import your medications' });
    }
};

// Exported for the reminder job and the tests
exports._materialise = materialise;
exports._materialiseAll = materialiseAll;
exports._runCheck = runCheck;
exports._clearFutureDoses = clearFutureDoses;
