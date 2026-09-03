/**
 * Clinician scope and the access log.
 *
 * These two are the security model of the doctor workspace. Every other protection in this
 * API assumes `requireSelf` — that a caller only ever reaches their own data. The clinician
 * workspace breaks that assumption on purpose, so what replaces it has to be tested rather
 * than described.
 *
 * The failure being prevented: a professional token walking `/reviews/patient/:id/context`
 * by id and reading every medical record in the product, leaving no trace.
 */
const mongoose = require('mongoose');
const User = require('../models/userModel');
const Interpretation = require('../models/Interpretation');
const AccessLog = require('../models/AccessLog');
const Biomarker = require('../models/Biomarker');
const { requireReviewScope } = require('../middleware/reviewScope');
const { getPatientContext, getQueue } = require('../controllers/reviewController');
const { recordAccess } = require('../utils/accessLog');

const mockRes = () => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
};

const patientFor = async (suffix) => (await User.create({
    username: `pt${suffix}`,
    email: `pt${suffix}@example.com`,
    password: 'x',
    firstName: 'Pat',
    lastName: String(suffix),
    dob: '1985-03-14',
    healthAssessment: { conditions: [{ name: 'Hypertension', severity: 'moderate' }] },
}))._id;

const CONTENT = {
    summary: 'Cardiometabolic pattern.',
    risks: [{ condition: 'Prediabetes', level: 'moderate', basis: 'biomarker', rationale: 'HbA1c.' }],
};

const clinician = (id) => ({
    userId: String(id),
    role: 'professional',
    email: 'doc@example.com',
});

describe('requireReviewScope', () => {
    it('lets a clinician reach a patient whose interpretation is in the queue', async () => {
        const patientId = await patientFor(1);
        await Interpretation.create({
            userId: patientId,
            content: CONTENT,
            review: { status: 'pending' },
        });

        const next = jest.fn();
        const res = mockRes();
        await requireReviewScope(
            { auth: clinician(new mongoose.Types.ObjectId()), params: { userId: String(patientId) } },
            res,
            next
        );

        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
    });

    it('lets a clinician reach a patient they have already reviewed', async () => {
        const patientId = await patientFor(2);
        const professionalId = new mongoose.Types.ObjectId();
        await Interpretation.create({
            userId: patientId,
            content: CONTENT,
            review: { status: 'approved', professionalId, reviewedAt: new Date() },
        });

        const next = jest.fn();
        await requireReviewScope(
            { auth: clinician(professionalId), params: { userId: String(patientId) } },
            mockRes(),
            next
        );

        expect(next).toHaveBeenCalled();
    });

    it('refuses a patient this clinician has no reason to read', async () => {
        const patientId = await patientFor(3);
        // Reviewed, but by somebody else — so this clinician has no standing.
        await Interpretation.create({
            userId: patientId,
            content: CONTENT,
            review: {
                status: 'approved',
                professionalId: new mongoose.Types.ObjectId(),
                reviewedAt: new Date(),
            },
        });

        const next = jest.fn();
        const res = mockRes();
        await requireReviewScope(
            { auth: clinician(new mongoose.Types.ObjectId()), params: { userId: String(patientId) } },
            res,
            next
        );

        expect(next).not.toHaveBeenCalled();
        // 404 rather than 403: a 403 would confirm the patient exists, turning this into a
        // way to ask "is this person a LabTrack patient?" one id at a time.
        expect(res.status).toHaveBeenCalledWith(404);
    });

    it('refuses a patient with no interpretations at all', async () => {
        const patientId = await patientFor(4);

        const next = jest.fn();
        const res = mockRes();
        await requireReviewScope(
            { auth: clinician(new mongoose.Types.ObjectId()), params: { userId: String(patientId) } },
            res,
            next
        );

        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(404);
    });

    it('lets an admin through, matching the bypass ownership.js already grants them', async () => {
        const patientId = await patientFor(5);

        const next = jest.fn();
        await requireReviewScope(
            {
                auth: { userId: String(new mongoose.Types.ObjectId()), role: 'admin' },
                params: { userId: String(patientId) },
            },
            mockRes(),
            next
        );

        expect(next).toHaveBeenCalled();
    });

    it('refuses a patient role outright', async () => {
        const res = mockRes();
        const next = jest.fn();
        await requireReviewScope(
            {
                auth: { userId: String(new mongoose.Types.ObjectId()), role: 'user' },
                params: { userId: String(new mongoose.Types.ObjectId()) },
            },
            res,
            next
        );

        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(403);
    });
});

describe('access logging', () => {
    it('records who read which patient record', async () => {
        const patientId = await patientFor(6);
        const professionalId = new mongoose.Types.ObjectId();
        await Interpretation.create({
            userId: patientId,
            content: CONTENT,
            review: { status: 'pending' },
        });

        await getPatientContext(
            { auth: clinician(professionalId), params: { userId: String(patientId) } },
            mockRes()
        );

        const entries = await AccessLog.find({ patientId }).lean();
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
            actorRole: 'professional',
            resource: 'patient_context',
            action: 'read',
        });
        expect(String(entries[0].actorId)).toBe(String(professionalId));
    });

    it('logs identifiers, never the record that was read', async () => {
        const patientId = await patientFor(7);
        await Biomarker.create({
            userId: patientId,
            name: 'ferritin',
            value: 12,
            measuredAt: new Date('2026-06-09'),
        });
        await Interpretation.create({
            userId: patientId,
            content: CONTENT,
            review: { status: 'pending' },
        });

        await getPatientContext(
            { auth: clinician(new mongoose.Types.ObjectId()), params: { userId: String(patientId) } },
            mockRes()
        );

        // An audit trail that copies the record it audits doubles the special-category data
        // to protect and becomes the easier of the two to steal.
        const raw = JSON.stringify(await AccessLog.find({ patientId }).lean());
        expect(raw).not.toContain('Hypertension');
        expect(raw).not.toContain('ferritin');
        expect(raw).not.toContain('Cardiometabolic');
    });

    it('records opening the queue as one entry with a count, not one per patient', async () => {
        const a = await patientFor(8);
        const b = await patientFor(9);
        for (const userId of [a, b]) {
            await Interpretation.create({ userId, content: CONTENT, review: { status: 'pending' } });
        }

        await getQueue({ auth: clinician(new mongoose.Types.ObjectId()) }, mockRes());

        const entries = await AccessLog.find({ resource: 'queue' }).lean();
        expect(entries).toHaveLength(1);
        expect(entries[0].count).toBe(2);
    });

    it('does not log a patient reading their own record', async () => {
        const patientId = await patientFor(10);

        await recordAccess({
            actor: { userId: String(patientId), role: 'user' },
            patientId,
            resource: 'patient_context',
        });

        // requireSelf already governs that read; logging it would bury the staff reads the
        // log exists for.
        expect(await AccessLog.countDocuments({})).toBe(0);
    });

    it('never fails the read it is auditing', async () => {
        // Fail-open on purpose: a hiccup in the audit collection must not take the clinical
        // workspace down to protect a record of something that was going to be permitted.
        const spy = jest.spyOn(AccessLog, 'create').mockRejectedValueOnce(new Error('mongo down'));
        const errors = jest.spyOn(console, 'error').mockImplementation(() => {});

        await expect(
            recordAccess({
                actor: clinician(new mongoose.Types.ObjectId()),
                patientId: new mongoose.Types.ObjectId(),
                resource: 'patient_context',
            })
        ).resolves.toBeNull();

        // Fail-open, but never fail-silent.
        expect(errors).toHaveBeenCalled();

        spy.mockRestore();
        errors.mockRestore();
    });
});

describe('getPatientContext', () => {
    it('returns the clinical picture without credentials or identity fields', async () => {
        const patientId = await patientFor(11);
        await Interpretation.create({
            userId: patientId,
            content: CONTENT,
            review: { status: 'pending' },
        });

        const res = mockRes();
        await getPatientContext(
            { auth: clinician(new mongoose.Types.ObjectId()), params: { userId: String(patientId) } },
            res
        );

        const payload = res.json.mock.calls[0][0];
        expect(payload.patient.firstName).toBe('Pat');
        expect(payload.patient.healthAssessment).toBeDefined();

        const raw = JSON.stringify(payload);
        expect(raw).not.toContain('password');
        expect(raw).not.toContain('supabaseId');
        expect(raw).not.toContain('pushTokens');
    });

    it('404s for a patient who does not exist', async () => {
        const res = mockRes();
        await getPatientContext(
            {
                auth: clinician(new mongoose.Types.ObjectId()),
                params: { userId: String(new mongoose.Types.ObjectId()) },
            },
            res
        );

        expect(res.status).toHaveBeenCalledWith(404);
    });
});
