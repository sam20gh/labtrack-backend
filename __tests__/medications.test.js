/**
 * The medication record itself: materialising doses, recording them, and what survives.
 *
 * Three properties that would each be a real defect if they broke:
 *
 *   - **Materialising is idempotent.** The timeline writes doses on read, so it runs
 *     constantly and from more than one device. If it were not idempotent, opening the
 *     screen twice would duplicate a day's doses and halve the person's adherence.
 *   - **History is immutable.** Changing a schedule or stopping a medication must never
 *     rewrite what someone is recorded as having taken.
 *   - **Taking a dose counts down the packet exactly once.** Double-tapping "Taken" must
 *     not remove two tablets from the count that drives the refill reminder.
 */
const mongoose = require('mongoose');
const Medication = require('../models/Medication');
const MedicationDose = require('../models/MedicationDose');
const MedicationCheck = require('../models/MedicationCheck');
const User = require('../models/userModel');
const controller = require('../controllers/medicationController');
const catalogue = require('../utils/medicationCatalogue');

const makeUser = (over = {}) => User.create({
    username: `u${new mongoose.Types.ObjectId()}`,
    email: `${new mongoose.Types.ObjectId()}@example.com`,
    supabaseId: String(new mongoose.Types.ObjectId()),
    ...over,
});

const makeMedication = (userId, over = {}) => Medication.create({
    userId,
    name: 'atorvastatin',
    frequency: 'daily',
    times: ['09:00'],
    startDay: '2026-03-02',
    tzOffset: 0,
    ...over,
});

/** Minimal req/res doubles, matching how the other controller tests drive handlers. */
const mockRes = () => {
    const res = { statusCode: 200, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    return res;
};

describe('materialise', () => {
    it('writes one dose per scheduled occurrence', async () => {
        const user = await makeUser();
        const med = await makeMedication(user._id);

        await controller._materialise(med, '2026-03-02', '2026-03-05');

        const doses = await MedicationDose.find({ medicationId: med._id }).sort({ scheduledFor: 1 });
        expect(doses).toHaveLength(4);
        expect(doses.map((d) => d.day)).toEqual(['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05']);
    });

    it('is idempotent — the timeline is read repeatedly and must not duplicate', async () => {
        const user = await makeUser();
        const med = await makeMedication(user._id);

        await controller._materialise(med, '2026-03-02', '2026-03-05');
        await controller._materialise(med, '2026-03-02', '2026-03-05');
        await controller._materialise(med, '2026-03-01', '2026-03-08');

        expect(await MedicationDose.countDocuments({ medicationId: med._id })).toBe(7);
    });

    it('does not resurrect or overwrite a dose already acted on', async () => {
        const user = await makeUser();
        const med = await makeMedication(user._id);

        await controller._materialise(med, '2026-03-02', '2026-03-03');
        const first = await MedicationDose.findOne({ medicationId: med._id }).sort({ scheduledFor: 1 });
        first.status = 'taken';
        first.takenAt = new Date('2026-03-02T09:05:00Z');
        await first.save();

        await controller._materialise(med, '2026-03-02', '2026-03-03');

        const after = await MedicationDose.findById(first._id);
        expect(after.status).toBe('taken');
        expect(await MedicationDose.countDocuments({ medicationId: med._id })).toBe(2);
    });

    it('writes nothing for an as-needed medication', async () => {
        const user = await makeUser();
        const med = await makeMedication(user._id, { frequency: 'as_needed' });

        await controller._materialise(med, '2026-03-02', '2026-03-30');
        expect(await MedicationDose.countDocuments({ medicationId: med._id })).toBe(0);
    });
});

describe('clearFutureDoses', () => {
    it('removes untouched future doses but keeps everything already recorded', async () => {
        const user = await makeUser();
        const med = await makeMedication(user._id);
        await controller._materialise(med, '2026-03-02', '2026-03-10');

        // Mark the first two as taken
        const early = await MedicationDose.find({ medicationId: med._id }).sort({ scheduledFor: 1 }).limit(2);
        for (const d of early) {
            d.status = 'taken';
            d.takenAt = d.scheduledFor;
            await d.save();
        }

        await controller._clearFutureDoses(med._id, new Date('2026-03-04T00:00:00Z'));

        const remaining = await MedicationDose.find({ medicationId: med._id }).sort({ scheduledFor: 1 });
        // The two taken survive; 03-03 is before the cutoff and untouched, so it survives too
        expect(remaining.every((d) => d.day <= '2026-03-03')).toBe(true);
        expect(remaining.filter((d) => d.status === 'taken')).toHaveLength(2);
    });
});

describe('taking a dose', () => {
    const runUpdate = async (userId, doseId, body) => {
        const res = mockRes();
        await controller.updateDose(
            { params: { id: String(doseId) }, body, auth: { userId } },
            res
        );
        return res;
    };

    it('records the dose and counts one out of the packet', async () => {
        const user = await makeUser();
        const med = await makeMedication(user._id, { remainingDoses: 10, refillReminder: true });
        await controller._materialise(med, '2026-03-02', '2026-03-02');
        const dose = await MedicationDose.findOne({ medicationId: med._id });

        const res = await runUpdate(user._id, dose._id, { action: 'take' });

        expect(res.body.dose.status).toBe('taken');
        expect(res.body.remainingDoses).toBe(9);
    });

    it('does not count twice when "taken" is tapped again', async () => {
        const user = await makeUser();
        const med = await makeMedication(user._id, { remainingDoses: 10 });
        await controller._materialise(med, '2026-03-02', '2026-03-02');
        const dose = await MedicationDose.findOne({ medicationId: med._id });

        await runUpdate(user._id, dose._id, { action: 'take' });
        const res = await runUpdate(user._id, dose._id, { action: 'take' });

        expect(res.body.remainingDoses).toBe(9);
    });

    it('puts the tablet back when the person undoes it', async () => {
        const user = await makeUser();
        const med = await makeMedication(user._id, { remainingDoses: 10 });
        await controller._materialise(med, '2026-03-02', '2026-03-02');
        const dose = await MedicationDose.findOne({ medicationId: med._id });

        await runUpdate(user._id, dose._id, { action: 'take' });
        const res = await runUpdate(user._id, dose._id, { action: 'undo' });

        expect(res.body.dose.status).toBe('scheduled');
        expect(res.body.remainingDoses).toBe(10);
    });

    it('records a skip without touching the packet', async () => {
        const user = await makeUser();
        const med = await makeMedication(user._id, { remainingDoses: 10 });
        await controller._materialise(med, '2026-03-02', '2026-03-02');
        const dose = await MedicationDose.findOne({ medicationId: med._id });

        const res = await runUpdate(user._id, dose._id, { action: 'skip' });

        expect(res.body.dose.status).toBe('skipped');
        expect(res.body.remainingDoses).toBe(10);
    });

    it('flags a refill once the packet reaches the threshold', async () => {
        const user = await makeUser();
        const med = await makeMedication(user._id, {
            remainingDoses: 5, refillThreshold: 4, refillReminder: true,
        });
        await controller._materialise(med, '2026-03-02', '2026-03-02');
        const dose = await MedicationDose.findOne({ medicationId: med._id });

        const res = await runUpdate(user._id, dose._id, { action: 'take' });
        expect(res.body.needsRefill).toBe(true);
    });

    it('refuses an action it does not know rather than guessing', async () => {
        const user = await makeUser();
        const med = await makeMedication(user._id);
        await controller._materialise(med, '2026-03-02', '2026-03-02');
        const dose = await MedicationDose.findOne({ medicationId: med._id });

        const res = await runUpdate(user._id, dose._id, { action: 'destroy' });
        expect(res.statusCode).toBe(400);
    });

    it('will not let one person act on another\'s dose', async () => {
        const owner = await makeUser();
        const stranger = await makeUser();
        const med = await makeMedication(owner._id);
        await controller._materialise(med, '2026-03-02', '2026-03-02');
        const dose = await MedicationDose.findOne({ medicationId: med._id });

        const res = await runUpdate(stranger._id, dose._id, { action: 'take' });
        expect(res.statusCode).toBe(404);
    });
});

describe('removing a medication', () => {
    it('archives by default and keeps the dose history', async () => {
        const user = await makeUser();
        const med = await makeMedication(user._id);
        await controller._materialise(med, '2026-03-02', '2026-03-10');

        const taken = await MedicationDose.findOne({ medicationId: med._id }).sort({ scheduledFor: 1 });
        taken.status = 'taken';
        taken.takenAt = taken.scheduledFor;
        await taken.save();

        const res = mockRes();
        await controller.deleteMedication(
            { params: { id: String(med._id) }, query: {}, auth: { userId: user._id } },
            res
        );

        expect(res.body.purged).toBe(false);
        const after = await Medication.findById(med._id);
        expect(after.active).toBe(false);
        expect(after.remindersEnabled).toBe(false);

        // What was taken survives; only untouched future doses go
        expect(await MedicationDose.countDocuments({ medicationId: med._id, status: 'taken' })).toBe(1);
    });

    it('purges everything only when explicitly asked', async () => {
        const user = await makeUser();
        const med = await makeMedication(user._id);
        await controller._materialise(med, '2026-03-02', '2026-03-10');

        const res = mockRes();
        await controller.deleteMedication(
            { params: { id: String(med._id) }, query: { purge: 'true' }, auth: { userId: user._id } },
            res
        );

        expect(res.body.purged).toBe(true);
        expect(await Medication.findById(med._id)).toBeNull();
        expect(await MedicationDose.countDocuments({ medicationId: med._id })).toBe(0);
    });
});

describe('the interaction check', () => {
    it('stores findings, and names what it could not check', async () => {
        const user = await makeUser({
            healthAssessment: { conditions: [{ name: 'Peptic ulcer disease', status: 'Active' }] },
        });
        await makeMedication(user._id, { name: 'warfarin' });
        await makeMedication(user._id, { name: 'ibuprofen' });
        await makeMedication(user._id, { name: 'Zolpidemol' });

        // No API key in tests, so this exercises the rule-only path deliberately
        const check = await controller._runCheck(user._id);

        expect(check.worstSeverity).toBe('severe');
        expect(check.findings.some((f) => f.id === 'anticoagulant-nsaid')).toBe(true);
        expect(check.uncheckable).toEqual(['Zolpidemol']);
        expect(check.checkedCount).toBe(2);
        expect(check.degraded).toBe(true);
    });

    it('picks up a condition from the health assessment', async () => {
        const user = await makeUser({
            healthAssessment: { conditions: [{ name: 'Chronic kidney disease', status: 'Active' }] },
        });
        await makeMedication(user._id, { name: 'ibuprofen' });

        const check = await controller._runCheck(user._id);
        expect(check.findings.some((f) => f.kind === 'condition')).toBe(true);
    });

    it('ignores a resolved condition', async () => {
        const user = await makeUser({
            healthAssessment: { conditions: [{ name: 'Peptic ulcer disease', status: 'Resolved' }] },
        });
        await makeMedication(user._id, { name: 'ibuprofen' });

        const check = await controller._runCheck(user._id);
        expect(check.findings.some((f) => f.id === 'nsaid-ulcer')).toBe(false);
    });

    it('never reports a severity when nothing fired', async () => {
        const user = await makeUser();
        await makeMedication(user._id, { name: 'paracetamol' });

        const check = await controller._runCheck(user._id);
        expect(check.findings).toHaveLength(0);
        expect(check.worstSeverity).toBeNull();
        // And the stored summary refuses to call it an all-clear
        expect(check.summary).toMatch(/not the same as being cleared/i);
    });

    it('excludes an archived medication from the check', async () => {
        const user = await makeUser();
        await makeMedication(user._id, { name: 'warfarin' });
        await makeMedication(user._id, { name: 'ibuprofen', active: false });

        const check = await controller._runCheck(user._id);
        expect(check.findings.some((f) => f.id === 'anticoagulant-nsaid')).toBe(false);
    });

    it('reports the stored check as stale once the list changes', async () => {
        const user = await makeUser();
        await makeMedication(user._id, { name: 'warfarin' });
        await controller._runCheck(user._id);

        await makeMedication(user._id, { name: 'ibuprofen' });

        const res = mockRes();
        await controller.getInteractionCheck({ auth: { userId: user._id } }, res);

        expect(res.body.stale).toBe(true);
        expect(res.body.check).not.toBeNull();
    });

    it('is append-only — a re-run does not overwrite what the person already read', async () => {
        const user = await makeUser();
        await makeMedication(user._id, { name: 'warfarin' });

        await controller._runCheck(user._id);
        await controller._runCheck(user._id);

        expect(await MedicationCheck.countDocuments({ userId: user._id })).toBe(2);
    });

    it('reading a check never runs one', async () => {
        const user = await makeUser();
        await makeMedication(user._id, { name: 'warfarin' });

        const res = mockRes();
        await controller.getInteractionCheck({ auth: { userId: user._id } }, res);

        expect(res.body.check).toBeNull();
        expect(res.body.stale).toBe(true);
        expect(await MedicationCheck.countDocuments({ userId: user._id })).toBe(0);
    });
});

describe('the preview', () => {
    const preview = async (userId, name) => {
        const res = mockRes();
        await controller.previewInteractions({ body: { name }, auth: { userId } }, res);
        return res.body;
    };

    it('reports only what the addition would introduce', async () => {
        const user = await makeUser();
        await makeMedication(user._id, { name: 'warfarin' });

        const body = await preview(user._id, 'ibuprofen');

        expect(body.introduced.some((f) => f.id === 'anticoagulant-nsaid')).toBe(true);
        // Warfarin's own food interactions were already there, so they are not "introduced"
        expect(body.introduced.some((f) => f.between.includes('Leafy greens and vitamin K'))).toBe(false);
    });

    it('flags a candidate it cannot classify, so an empty list is not read as safe', async () => {
        const user = await makeUser();
        await makeMedication(user._id, { name: 'warfarin' });

        const body = await preview(user._id, 'Zolpidemol');

        expect(body.known).toBe(false);
        expect(body.uncheckable).toBe(true);
        expect(body.introduced).toHaveLength(0);
    });

    it('writes nothing', async () => {
        const user = await makeUser();
        await makeMedication(user._id, { name: 'warfarin' });

        await preview(user._id, 'ibuprofen');

        expect(await Medication.countDocuments({ userId: user._id })).toBe(1);
        expect(await MedicationCheck.countDocuments({ userId: user._id })).toBe(0);
    });
});

describe('importing from the health assessment', () => {
    it('offers what the assessment holds without writing on a dry run', async () => {
        const user = await makeUser({
            healthAssessment: {
                medications: [
                    { name: 'Lipitor', dosage: '20mg', isCurrentlyTaking: true },
                    { name: 'Old thing', isCurrentlyTaking: false },
                ],
            },
        });

        const res = mockRes();
        await controller.importFromAssessment({ body: { dryRun: true }, auth: { userId: user._id } }, res);

        expect(res.body.candidates.map((c) => c.name)).toEqual(['Lipitor']);
        expect(await Medication.countDocuments({ userId: user._id })).toBe(0);
    });

    it('imports as when-needed, so no reminder is invented for a schedule nobody set', async () => {
        const user = await makeUser({
            healthAssessment: { medications: [{ name: 'Lipitor', isCurrentlyTaking: true }] },
        });

        const res = mockRes();
        await controller.importFromAssessment({ body: {}, auth: { userId: user._id } }, res);

        const created = await Medication.findOne({ userId: user._id });
        expect(created.frequency).toBe('as_needed');
        expect(created.remindersEnabled).toBe(false);
        expect(created.source).toBe('assessment');
        expect(await MedicationDose.countDocuments({ userId: user._id })).toBe(0);
    });

    it('does not offer something already on the list, under any of its names', async () => {
        const user = await makeUser({
            healthAssessment: { medications: [{ name: 'atorvastatin', isCurrentlyTaking: true }] },
        });
        await makeMedication(user._id, { name: 'atorvastatin' });

        const res = mockRes();
        await controller.importFromAssessment({ body: { dryRun: true }, auth: { userId: user._id } }, res);

        expect(res.body.candidates).toHaveLength(0);
    });

    it('leaves the assessment untouched — reconciliation runs one way only', async () => {
        const user = await makeUser({
            healthAssessment: { medications: [{ name: 'Lipitor', isCurrentlyTaking: true }] },
        });

        const res = mockRes();
        await controller.importFromAssessment({ body: {}, auth: { userId: user._id } }, res);

        const after = await User.findById(user._id);
        expect(after.healthAssessment.medications).toHaveLength(1);
        expect(after.healthAssessment.medications[0].name).toBe('Lipitor');
    });
});

describe('creating a medication', () => {
    const create = async (userId, body) => {
        const res = mockRes();
        await controller.createMedication({ body, auth: { userId } }, res);
        return res;
    };

    it('populates the near-term schedule immediately', async () => {
        const user = await makeUser();
        const res = await create(user._id, {
            name: 'atorvastatin', frequency: 'daily', times: ['09:00'], tzOffset: 0,
        });

        expect(res.statusCode).toBe(201);
        expect(await MedicationDose.countDocuments({ userId: user._id })).toBeGreaterThan(0);
    });

    it('rejects a nameless medication', async () => {
        const user = await makeUser();
        const res = await create(user._id, { frequency: 'daily' });
        expect(res.statusCode).toBe(400);
    });

    it('rejects an end date before the start', async () => {
        const user = await makeUser();
        const res = await create(user._id, {
            name: 'atorvastatin', startDay: '2026-03-10', endDay: '2026-03-01',
        });
        expect(res.statusCode).toBe(400);
    });

    it('discards a malformed dose time rather than storing it', async () => {
        const user = await makeUser();
        await create(user._id, {
            name: 'atorvastatin', frequency: 'daily', times: ['09:00', 'lunchtime', '25:00'],
        });

        const med = await Medication.findOne({ userId: user._id });
        expect(med.times).toEqual(['09:00']);
    });

    it('attaches the catalogue entry when the drug is known', async () => {
        const user = await makeUser();
        const res = await create(user._id, { name: 'atorvastatin' });
        expect(res.body.medication.catalogue.plainName).toBe('Cholesterol tablet');
    });

    it('accepts a drug the catalogue does not know', async () => {
        const user = await makeUser();
        const res = await create(user._id, { name: 'Zolpidemol' });
        expect(res.statusCode).toBe(201);
        expect(res.body.medication.catalogue).toBeNull();
    });
});
