/**
 * The editorial and directory surfaces the staff portal manages.
 *
 * Two properties are asserted here that the patient-facing endpoints deliberately do not
 * have, and one that both must share.
 *
 * `listResources` hardcodes `status: 'published'`, which is correct for every screen a
 * patient sees and useless for editing: a draft would be invisible to the only person able
 * to publish it. The admin list shows all three statuses.
 *
 * `getSpecialities` serves the schema's enum rather than a copy. A speciality outside it
 * produces a referral `planGeneratorV2` can never resolve, and the way that happens in
 * practice is a client-side list drifting from the model.
 */
const Resource = require('../models/Resource');
const ResourceCategory = require('../models/ResourceCategory');
const Professional = require('../models/Professional');
const {
    listResourcesForAdmin,
    getResourceStats,
} = require('../controllers/resourceController');
const { getSpecialities } = require('../controllers/professionalController');

const mockRes = () => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
};

const next = () => jest.fn();

const makeResource = async (overrides = {}) => {
    const category = await ResourceCategory.findOneAndUpdate(
        { slug: 'sleep' },
        { $setOnInsert: { name: 'Sleep', slug: 'sleep', active: true } },
        { upsert: true, new: true }
    );

    return Resource.create({
        type: 'article',
        title: 'How sleep works',
        slug: `how-sleep-works-${Math.random().toString(36).slice(2, 8)}`,
        categoryId: category._id,
        status: 'draft',
        body: [{ type: 'paragraph', text: 'Sleep is restorative.' }],
        ...overrides,
    });
};

describe('listResourcesForAdmin', () => {
    it('shows drafts, which the patient-facing list can never return', async () => {
        await makeResource({ status: 'draft' });

        const res = mockRes();
        await listResourcesForAdmin({ query: {} }, res, next());

        const payload = res.json.mock.calls[0][0];
        expect(payload.total).toBe(1);
        expect(payload.items[0].status).toBe('draft');
    });

    it('returns every status when unfiltered', async () => {
        await makeResource({ status: 'draft' });
        await makeResource({ status: 'published' });
        await makeResource({ status: 'archived' });

        const res = mockRes();
        await listResourcesForAdmin({ query: {} }, res, next());

        const statuses = res.json.mock.calls[0][0].items.map((i) => i.status).sort();
        expect(statuses).toEqual(['archived', 'draft', 'published']);
    });

    it('filters by status', async () => {
        await makeResource({ status: 'draft' });
        await makeResource({ status: 'published' });

        const res = mockRes();
        await listResourcesForAdmin({ query: { status: 'published' } }, res, next());

        expect(res.json.mock.calls[0][0].total).toBe(1);
    });

    it('rejects a status outside the enum rather than ignoring the filter', async () => {
        const res = mockRes();
        await listResourcesForAdmin({ query: { status: 'live' } }, res, next());

        expect(res.status).toHaveBeenCalledWith(400);
    });

    it('rejects a type outside the enum', async () => {
        const res = mockRes();
        await listResourcesForAdmin({ query: { type: 'podcast' } }, res, next());

        expect(res.status).toHaveBeenCalledWith(400);
    });

    it('omits the body — a list screen renders none of it', async () => {
        await makeResource({ status: 'published' });

        const res = mockRes();
        await listResourcesForAdmin({ query: {} }, res, next());

        const serialised = JSON.stringify(res.json.mock.calls[0][0]);
        expect(serialised).not.toContain('Sleep is restorative');
    });
});

describe('getResourceStats', () => {
    it('reports every status and type, zeroes included', async () => {
        await makeResource({ status: 'published' });

        const res = mockRes();
        await getResourceStats({}, res, next());

        const payload = res.json.mock.calls[0][0];
        for (const value of Resource.schema.path('status').enumValues) {
            expect(payload.statuses).toHaveProperty(value);
        }
        for (const value of Resource.schema.path('type').enumValues) {
            expect(payload.types).toHaveProperty(value);
        }
        expect(payload.statuses.published).toBe(1);
        expect(payload.types.audio).toBe(0);
        expect(payload.total).toBe(1);
    });
});

describe('getSpecialities', () => {
    it('serves the schema enum, so a client cannot drift from the model', async () => {
        const res = mockRes();
        await getSpecialities({}, res);

        const { specialities } = res.json.mock.calls[0][0];
        const fromSchema = Professional.schema.path('speciality').caster.enumValues;

        expect(specialities).toHaveLength(fromSchema.length);
        expect([...specialities].sort()).toEqual([...fromSchema].sort());
    });

    it('offers the enum spelling, never the practitioner noun', async () => {
        const res = mockRes();
        await getSpecialities({}, res);

        const { specialities } = res.json.mock.calls[0][0];
        // "Cardiologist" looks right in a dropdown and matches no referral.
        expect(specialities).toContain('Cardiology');
        expect(specialities).not.toContain('Cardiologist');
        expect(specialities).toContain('Medical Genetics');
    });

    it('is sorted, because 48 unordered options is a list nobody can scan', async () => {
        const res = mockRes();
        await getSpecialities({}, res);

        const { specialities } = res.json.mock.calls[0][0];
        expect(specialities).toEqual([...specialities].sort((a, b) => a.localeCompare(b)));
    });
});
