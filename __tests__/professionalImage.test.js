/**
 * The directory photograph, and what a directory form may write.
 *
 * `profile_image` is drawn as a circular avatar on five mobile surfaces and is `required`
 * on the schema, so the two failure modes are opposite ends of the same field: a local file
 * path that renders on one machine and nowhere else, and a missing value whose only report
 * is a Mongoose validation message naming neither the cause nor the fix.
 *
 * The whitelist is the other half. `updateProfessional` used to hand `req.body` to
 * `findByIdAndUpdate` whole, and `userId` is the sparse-unique link deciding whose record a
 * clinician's reviews are attributed to — moving it from a directory form would move their
 * clinical sign-offs, silently.
 */
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const Professional = require('../models/Professional');
const {
    createProfessional,
    updateProfessional,
} = require('../controllers/professionalController');

const mockRes = () => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
};

const CF = 'https://imagedelivery.net/abc123/headshot/public';

const body = (overrides = {}) => ({
    firstname: 'Ada',
    lastname: 'Shah',
    username: `ada-${Math.random().toString(36).slice(2, 8)}`,
    password: 'secret',
    dob: '1980-04-01',
    address: '1 Clinic Road',
    postcode: 'W1 1AA',
    country: 'UK',
    speciality: ['Cardiology'],
    hourly_rate: 120,
    profile_image: CF,
    description: 'Consultant cardiologist.',
    ...overrides,
});

const create = async (overrides = {}) => {
    const res = mockRes();
    await createProfessional({ body: body(overrides) }, res);
    return { res, professional: res.json.mock.calls[0][0]?.professional };
};

describe('creating a professional', () => {
    it('stores the uploaded delivery URL', async () => {
        const { professional } = await create();

        expect(professional.profile_image).toBe(CF);
    });

    it('trims a pasted URL rather than storing the whitespace', async () => {
        const { professional } = await create({ profile_image: `  ${CF}  ` });

        expect(professional.profile_image).toBe(CF);
    });

    it('refuses a local file path — it renders on one device and nowhere else', async () => {
        const { res } = await create({
            profile_image: 'file:///var/mobile/Containers/cache/IMG_0001.jpg',
        });

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json.mock.calls[0][0].message).toMatch(/profile_image must be a URL/);
        expect(await Professional.countDocuments()).toBe(0);
    });

    it('refuses the server temp path multer writes, which is not servable either', async () => {
        const { res } = await create({ profile_image: 'uploads/05935a43c9ec1b7f0285f076' });

        expect(res.status).toHaveBeenCalledWith(400);
    });

    it('refuses a missing photograph with a sentence, not a validation error', async () => {
        const { res } = await create({ profile_image: undefined });

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json.mock.calls[0][0].message).toMatch(/upload one through/);
    });

    it('still accepts http, for directory photographs predating Cloudflare', async () => {
        const { professional } = await create({ profile_image: 'http://old.example.com/a.jpg' });

        expect(professional.profile_image).toBe('http://old.example.com/a.jpg');
    });

    it('never returns the password hash', async () => {
        const { professional } = await create();

        expect(professional.password).toBeUndefined();
    });
});

describe('updating a professional', () => {
    const stored = async () => (await create()).professional;

    it('replaces the photograph', async () => {
        const existing = await stored();
        const next = 'https://imagedelivery.net/abc123/new-headshot/public';

        const res = mockRes();
        await updateProfessional({ params: { id: existing._id }, body: { profile_image: next } }, res);

        expect(res.json.mock.calls[0][0].professional.profile_image).toBe(next);
    });

    it('refuses a file path instead of storing an avatar nobody can load', async () => {
        const existing = await stored();

        const res = mockRes();
        await updateProfessional(
            { params: { id: existing._id }, body: { profile_image: 'file:///tmp/a.jpg' } },
            res
        );

        expect(res.status).toHaveBeenCalledWith(400);
        const unchanged = await Professional.findById(existing._id);
        expect(unchanged.profile_image).toBe(CF);
    });

    it('leaves the photograph alone when the update does not mention it', async () => {
        const existing = await stored();

        const res = mockRes();
        await updateProfessional({ params: { id: existing._id }, body: { hourly_rate: 200 } }, res);
        const updated = res.json.mock.calls[0][0].professional;

        expect(updated.hourly_rate).toBe(200);
        expect(updated.profile_image).toBe(CF);
    });

    it('cannot reassign userId, which decides whose sign-offs a record carries', async () => {
        const existing = await stored();
        const hijack = new mongoose.Types.ObjectId();

        const res = mockRes();
        await updateProfessional(
            { params: { id: existing._id }, body: { firstname: 'Renamed', userId: hijack } },
            res
        );
        const updated = res.json.mock.calls[0][0].professional;

        expect(updated.firstname).toBe('Renamed');
        expect(updated.userId).toBeUndefined();
    });

    it('hashes a new password rather than storing what was typed', async () => {
        const existing = await stored();

        const res = mockRes();
        await updateProfessional(
            { params: { id: existing._id }, body: { password: 'a-new-password' } },
            res
        );

        const record = await Professional.findById(existing._id);
        expect(record.password).not.toBe('a-new-password');
        expect(await bcrypt.compare('a-new-password', record.password)).toBe(true);
    });

    it('answers 404 for a professional that does not exist', async () => {
        const res = mockRes();
        await updateProfessional(
            { params: { id: new mongoose.Types.ObjectId() }, body: { hourly_rate: 1 } },
            res
        );

        expect(res.status).toHaveBeenCalledWith(404);
    });
});
