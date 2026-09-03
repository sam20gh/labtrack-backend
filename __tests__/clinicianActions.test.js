/**
 * The clinician's write surface: sign-off attribution, and the professional side of the
 * diary.
 *
 * Two defects motivated this work.
 *
 * `Professional` is a directory record; a portal clinician authenticates through Supabase
 * and resolves to a `User`. Nothing joined the two, so code needing "the Professional for
 * whoever is signed in" used `Professional.findById(req.auth.userId)` — correct for the
 * legacy tokens that carried a Professional id, and silently empty under Supabase, which is
 * indistinguishable from "this clinician has no profile".
 *
 * And booking was one-directional: the app created a row as `requested` and nothing could
 * ever answer it, so every appointment in the product sat unconfirmed forever.
 */
const mongoose = require('mongoose');
const User = require('../models/userModel');
const Professional = require('../models/Professional');
const Appointment = require('../models/Appointment');
const Interpretation = require('../models/Interpretation');
const AccessLog = require('../models/AccessLog');
const { resolveProfessional, actingProfessionalId } = require('../utils/resolveProfessional');
const {
    getProfessionalAppointments,
    setAppointmentStatusAsProfessional,
    proposeNewTime,
} = require('../controllers/appointmentController');
const PlanItem = require('../models/PlanItem');
const { getProfile, submitReview, getMyReviews, addPlanItem } = require('../controllers/reviewController');

const mockRes = () => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
};

const makeUser = async (suffix) => User.create({
    username: `u${suffix}`,
    email: `u${suffix}@example.com`,
    password: 'x',
    firstName: 'Doc',
    lastName: String(suffix),
});

const makeProfessional = async (suffix, userId) => Professional.create({
    userId,
    firstname: 'Doc',
    lastname: String(suffix),
    username: `doc${suffix}`,
    password: 'hashed',
    dob: new Date('1980-01-01'),
    address: '1 Road',
    postcode: 'E1 1AA',
    country: 'UK',
    speciality: ['Cardiology'],
    hourly_rate: 100,
    profile_image: 'https://imagedelivery.net/x/y/public',
    description: 'A clinician.',
});

const future = (days = 7) => new Date(Date.now() + days * 86_400_000);

describe('resolveProfessional', () => {
    it('finds the directory record linked to a Supabase account', async () => {
        const account = await makeUser(1);
        const professional = await makeProfessional(1, account._id);

        const found = await resolveProfessional({
            userId: String(account._id),
            role: 'professional',
            source: 'supabase',
        });

        expect(String(found._id)).toBe(String(professional._id));
    });

    it('returns null for an account with no directory record', async () => {
        const account = await makeUser(2);

        // The state that used to look like a broken profile: an administrator, or a
        // clinician nobody has linked yet.
        const found = await resolveProfessional({
            userId: String(account._id),
            role: 'admin',
            source: 'supabase',
        });

        expect(found).toBeNull();
    });

    it('still resolves a legacy token, whose subject is a Professional id', async () => {
        const professional = await makeProfessional(3, undefined);

        const found = await resolveProfessional({
            userId: String(professional._id),
            role: 'professional',
            source: 'legacy',
        });

        expect(String(found._id)).toBe(String(professional._id));
    });

    it('never treats a Supabase user id as a Professional id', async () => {
        const professional = await makeProfessional(4, undefined);

        // Same id, but presented as a Supabase subject. It must not match: that confusion
        // is the bug this module exists to remove.
        const found = await resolveProfessional({
            userId: String(professional._id),
            role: 'professional',
            source: 'supabase',
        });

        expect(found).toBeNull();
    });
});

describe('getProfile', () => {
    it('answers 200 with a null profile rather than 404 when nothing is linked', async () => {
        const account = await makeUser(5);
        const res = mockRes();

        await getProfile({ auth: { userId: String(account._id), role: 'admin', source: 'supabase' } }, res);

        expect(res.status).not.toHaveBeenCalledWith(404);
        expect(res.json.mock.calls[0][0]).toMatchObject({ professional: null, linked: false });
    });
});

describe('submitReview attribution', () => {
    it('records the linked Professional, not the login account', async () => {
        const patient = await makeUser(6);
        const account = await makeUser(7);
        const professional = await makeProfessional(7, account._id);
        const interpretation = await Interpretation.create({
            userId: patient._id,
            content: { summary: 'Original summary.' },
            review: { status: 'pending' },
        });

        await submitReview(
            {
                params: { reportId: interpretation._id },
                body: { approved: true, notes: 'Looks right.' },
                auth: { userId: String(account._id), role: 'professional', source: 'supabase' },
            },
            mockRes()
        );

        const saved = await Interpretation.findById(interpretation._id).lean();
        expect(String(saved.review.professionalId)).toBe(String(professional._id));
        expect(saved.review.status).toBe('approved');
    });

    it('preserves the original alongside an amendment', async () => {
        const patient = await makeUser(8);
        const account = await makeUser(9);
        await makeProfessional(9, account._id);
        const interpretation = await Interpretation.create({
            userId: patient._id,
            content: { summary: 'Model summary.' },
            review: { status: 'pending' },
        });

        await submitReview(
            {
                params: { reportId: interpretation._id },
                body: {
                    approved: true,
                    notes: 'Softened an overstatement.',
                    amendments: { summary: 'Clinician summary.' },
                },
                auth: { userId: String(account._id), role: 'professional', source: 'supabase' },
            },
            mockRes()
        );

        const saved = await Interpretation.findById(interpretation._id).lean();
        expect(saved.review.status).toBe('amended');
        // Append-only: what the model said stays readable beside the correction, which is
        // the evidence that review is working.
        expect(saved.content.summary).toBe('Model summary.');
        expect(saved.amended.content.summary).toBe('Clinician summary.');
        expect(saved.review.edits).toHaveLength(1);
        expect(saved.review.edits[0]).toMatchObject({ field: 'summary', previous: 'Model summary.' });
    });

    it('finds a clinician’s reviews recorded under either id', async () => {
        const patient = await makeUser(10);
        const account = await makeUser(11);
        const professional = await makeProfessional(11, account._id);

        // One recorded before linking, one after — a clinician may have reviewed either
        // side of being attached to a directory entry.
        await Interpretation.create({
            userId: patient._id,
            content: { summary: 'a' },
            review: { status: 'approved', professionalId: account._id, reviewedAt: new Date() },
        });
        await Interpretation.create({
            userId: patient._id,
            content: { summary: 'b' },
            review: { status: 'approved', professionalId: professional._id, reviewedAt: new Date() },
        });

        const res = mockRes();
        await getMyReviews(
            { auth: { userId: String(account._id), role: 'professional', source: 'supabase' } },
            res
        );

        expect(res.json.mock.calls[0][0].count).toBe(2);
    });
});

describe('addPlanItem — clinician-ordered follow-ups', () => {
    it('records the linked Professional as the orderer, not the login account', async () => {
        const patient = await makeUser(27);
        const account = await makeUser(28);
        const professional = await makeProfessional(28, account._id);
        const interpretation = await Interpretation.create({
            userId: patient._id,
            content: { summary: 'x' },
            review: { status: 'pending' },
        });

        const res = mockRes();
        await addPlanItem(
            {
                params: { reportId: interpretation._id },
                body: { type: 'consultation', title: 'See a cardiologist', speciality: 'Cardiology' },
                auth: { userId: String(account._id), role: 'professional', source: 'supabase' },
            },
            res
        );

        expect(res.status).toHaveBeenCalledWith(201);
        const item = res.json.mock.calls[0][0].item;
        expect(String(item.orderedByProfessionalId)).toBe(String(professional._id));
    });

    it('rejects a speciality outside the directory enum — the practitioner-noun trap', async () => {
        const patient = await makeUser(29);
        const interpretation = await Interpretation.create({
            userId: patient._id,
            content: { summary: 'x' },
            review: { status: 'pending' },
        });

        const res = mockRes();
        await addPlanItem(
            {
                params: { reportId: interpretation._id },
                body: {
                    type: 'consultation',
                    title: 'See a cardiologist',
                    // The practitioner noun, not the enum's "Cardiology". This is exactly
                    // the value that matches no referral and fails silently everywhere else.
                    speciality: 'Cardiologist',
                },
                auth: { userId: String(new mongoose.Types.ObjectId()), role: 'professional', source: 'supabase' },
            },
            res
        );

        expect(res.status).toHaveBeenCalledWith(400);
        expect(await PlanItem.countDocuments({})).toBe(0);
    });

    it('accepts a plan item with no speciality at all', async () => {
        const patient = await makeUser(30);
        const interpretation = await Interpretation.create({
            userId: patient._id,
            content: { summary: 'x' },
            review: { status: 'pending' },
        });

        const res = mockRes();
        await addPlanItem(
            {
                params: { reportId: interpretation._id },
                body: { type: 'test', title: 'Repeat lipid panel' },
                auth: { userId: String(new mongoose.Types.ObjectId()), role: 'professional', source: 'supabase' },
            },
            res
        );

        expect(res.status).toHaveBeenCalledWith(201);
    });
});

describe('the professional side of the diary', () => {
    const clinicianAuth = (userId) => ({
        userId: String(userId),
        role: 'professional',
        source: 'supabase',
        email: 'doc@example.com',
    });

    it('returns an empty diary, not an error, when no record is linked', async () => {
        const account = await makeUser(12);
        const res = mockRes();

        await getProfessionalAppointments({ auth: clinicianAuth(account._id), query: {} }, res);

        expect(res.status).not.toHaveBeenCalled();
        expect(res.json.mock.calls[0][0]).toMatchObject({ appointments: [], linked: false });
    });

    it('returns only this clinician’s appointments', async () => {
        const patient = await makeUser(13);
        const account = await makeUser(14);
        const mine = await makeProfessional(14, account._id);
        const theirs = await makeProfessional(15, undefined);

        await Appointment.create({
            userId: patient._id, professionalId: mine._id, scheduledFor: future(),
        });
        await Appointment.create({
            userId: patient._id, professionalId: theirs._id, scheduledFor: future(),
        });

        const res = mockRes();
        await getProfessionalAppointments({ auth: clinicianAuth(account._id), query: {} }, res);

        const { appointments } = res.json.mock.calls[0][0];
        expect(appointments).toHaveLength(1);
        expect(String(appointments[0].professionalId)).toBe(String(mine._id));
    });

    it('logs the diary read under its own resource label, not "queue"', async () => {
        const patient = await makeUser(29);
        const account = await makeUser(30);
        const mine = await makeProfessional(30, account._id);
        await Appointment.create({
            userId: patient._id, professionalId: mine._id, scheduledFor: future(),
        });

        await getProfessionalAppointments({ auth: clinicianAuth(account._id), query: {} }, mockRes());

        // Conflating "opened the review queue" and "opened my diary" under the same label
        // would blur exactly the distinction an access-log review depends on.
        const entries = await AccessLog.find({ actorId: account._id }).lean();
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ resource: 'appointments', count: 1 });
    });

    it('confirms a requested appointment — the loop that never closed', async () => {
        const patient = await makeUser(16);
        const account = await makeUser(17);
        const professional = await makeProfessional(17, account._id);
        const appointment = await Appointment.create({
            userId: patient._id, professionalId: professional._id, scheduledFor: future(),
        });

        await setAppointmentStatusAsProfessional(
            {
                params: { id: appointment._id },
                body: { status: 'confirmed' },
                auth: clinicianAuth(account._id),
            },
            mockRes()
        );

        expect(await Appointment.findById(appointment._id)).toHaveProperty('status', 'confirmed');
    });

    it('refuses an illegal transition', async () => {
        const patient = await makeUser(18);
        const account = await makeUser(19);
        const professional = await makeProfessional(19, account._id);
        const appointment = await Appointment.create({
            userId: patient._id,
            professionalId: professional._id,
            scheduledFor: future(),
            status: 'cancelled',
        });

        const res = mockRes();
        await setAppointmentStatusAsProfessional(
            {
                params: { id: appointment._id },
                body: { status: 'confirmed' },
                auth: clinicianAuth(account._id),
            },
            res
        );

        expect(res.status).toHaveBeenCalledWith(409);
    });

    it('404s on another clinician’s appointment, rather than 403', async () => {
        const patient = await makeUser(20);
        const account = await makeUser(21);
        await makeProfessional(21, account._id);
        const other = await makeProfessional(22, undefined);
        const appointment = await Appointment.create({
            userId: patient._id, professionalId: other._id, scheduledFor: future(),
        });

        const res = mockRes();
        await setAppointmentStatusAsProfessional(
            {
                params: { id: appointment._id },
                body: { status: 'confirmed' },
                auth: clinicianAuth(account._id),
            },
            res
        );

        // 403 would confirm the appointment exists, which is a way of enumerating ids.
        expect(res.status).toHaveBeenCalledWith(404);
    });

    it('proposing a time moves the row and drops it back to requested', async () => {
        const patient = await makeUser(23);
        const account = await makeUser(24);
        const professional = await makeProfessional(24, account._id);
        const appointment = await Appointment.create({
            userId: patient._id,
            professionalId: professional._id,
            scheduledFor: future(3),
            status: 'confirmed',
            reasonForVisit: 'Raised potassium',
        });

        const newTime = future(10);
        await proposeNewTime(
            {
                params: { id: appointment._id },
                body: { scheduledFor: newTime },
                auth: clinicianAuth(account._id),
            },
            mockRes()
        );

        const saved = await Appointment.findById(appointment._id);
        expect(saved.scheduledFor.toISOString()).toBe(newTime.toISOString());
        // A time the clinician chose is not a time the patient has agreed to.
        expect(saved.status).toBe('requested');
        // Moving rather than cancel-and-rebook keeps the context.
        expect(saved.reasonForVisit).toBe('Raised potassium');
    });

    it('refuses to propose a time in the past', async () => {
        const patient = await makeUser(25);
        const account = await makeUser(26);
        const professional = await makeProfessional(26, account._id);
        const appointment = await Appointment.create({
            userId: patient._id, professionalId: professional._id, scheduledFor: future(),
        });

        const res = mockRes();
        await proposeNewTime(
            {
                params: { id: appointment._id },
                body: { scheduledFor: new Date(Date.now() - 86_400_000) },
                auth: clinicianAuth(account._id),
            },
            res
        );

        expect(res.status).toHaveBeenCalledWith(400);
    });
});
