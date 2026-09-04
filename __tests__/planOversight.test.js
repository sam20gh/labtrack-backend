/**
 * Plan-item oversight, for the staff portal's admin section.
 *
 * The plan is what the interpretation engine and the clinicians actually ordered, and until
 * this screen existed nothing could read it across users. Three things are asserted, and
 * the second is the one this was built for.
 *
 * 1. The list crosses the user boundary, so it must not carry a patient's medical record
 *    into an oversight table, and reading it must leave an audit entry.
 * 2. A recommendation with no purchasable product behind it is an item the person cannot
 *    act on. `buildPlanItems` reports that once, in a response field no client renders;
 *    derived from the stored row it stays true, and stays visible.
 * 3. Completion is null when nothing has come due — not zero. Nobody has failed at
 *    something nobody has been asked to do yet.
 */
const mongoose = require('mongoose');
const PlanItem = require('../models/PlanItem');
const User = require('../models/userModel');
const AccessLog = require('../models/AccessLog');
const {
    listAllPlanItems,
    getPlanItemStats,
} = require('../controllers/planItemController');

const mockRes = () => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
};

const admin = { userId: new mongoose.Types.ObjectId().toString(), email: 'ops@labtrack.io', role: 'admin' };
const req = (query = {}) => ({ query, auth: admin });

const patient = async (suffix) => User.create({
    username: `p${suffix}`,
    email: `p${suffix}@example.com`,
    password: 'x',
    firstName: 'Pat',
    lastName: String(suffix),
    healthAssessment: {
        // The thing an oversight table must never carry back to a browser.
        conditions: [{ name: 'Hypertension', severity: 'moderate' }],
    },
});

const days = (n) => new Date(Date.now() + n * 86400000);

const item = async (userId, overrides = {}) => PlanItem.create({
    userId,
    type: 'test',
    title: 'PSA Test',
    dueDate: days(30),
    status: 'upcoming',
    source: 'ai',
    productId: new mongoose.Types.ObjectId(),
    productName: 'PSA Test',
    ...overrides,
});

describe('listAllPlanItems', () => {
    it('returns items across every patient, most overdue first', async () => {
        const a = await patient(1);
        const b = await patient(2);
        await item(a._id, { dueDate: days(60), title: 'Later' });
        await item(b._id, { dueDate: days(-10), status: 'urgent', title: 'Overdue' });

        const res = mockRes();
        await listAllPlanItems(req(), res);

        const payload = res.json.mock.calls[0][0];
        expect(payload.total).toBe(2);
        expect(payload.items.map((i) => i.title)).toEqual(['Overdue', 'Later']);
        expect(payload.items[0].patient.email).toBe('p2@example.com');
    });

    it('carries no health assessment into the oversight table', async () => {
        const a = await patient(3);
        await item(a._id);

        const res = mockRes();
        await listAllPlanItems(req(), res);

        const serialised = JSON.stringify(res.json.mock.calls[0][0]);
        expect(serialised).not.toContain('Hypertension');
        expect(serialised).not.toContain('healthAssessment');
    });

    it('writes one audit entry with a count, not one per patient', async () => {
        const a = await patient(4);
        const b = await patient(5);
        await item(a._id);
        await item(b._id);

        await listAllPlanItems(req(), mockRes());

        const entries = await AccessLog.find({ resource: 'plan' }).lean();
        expect(entries).toHaveLength(1);
        expect(entries[0].count).toBe(2);
        // A listing names no single patient — that is what the count is for.
        expect(entries[0].patientId).toBeUndefined();
        expect(entries[0].actorRole).toBe('admin');
    });

    it('rejects an unknown status rather than silently matching nothing', async () => {
        const res = mockRes();
        await listAllPlanItems(req({ status: 'archived' }), res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json.mock.calls[0][0].message).toMatch(/Unknown status/);
    });

    it('an unmatched patient search returns nothing, never everything', async () => {
        const a = await patient(6);
        await item(a._id);

        const res = mockRes();
        await listAllPlanItems(req({ search: 'nobody@example.com' }), res);

        expect(res.json.mock.calls[0][0].total).toBe(0);
    });

    it('finds a patient by id, which is the only identifier the portal puts in a URL', async () => {
        const a = await patient(17);
        const b = await patient(18);
        await item(a._id, { title: 'PSA Test' });
        await item(b._id, { title: 'PSA Test' });

        const res = mockRes();
        await listAllPlanItems(req({ search: String(a._id) }), res);

        const payload = res.json.mock.calls[0][0];
        expect(payload.total).toBe(1);
        expect(payload.items[0].patient.email).toBe('p17@example.com');
    });

    it('searches the wording of a recommendation as well as the patient', async () => {
        const a = await patient(7);
        await item(a._id, { title: 'Colonoscopy', type: 'scan' });
        await item(a._id, { title: 'PSA Test' });

        const res = mockRes();
        await listAllPlanItems(req({ search: 'colonos' }), res);

        const payload = res.json.mock.calls[0][0];
        expect(payload.total).toBe(1);
        expect(payload.items[0].title).toBe('Colonoscopy');
    });

    it('combines the blocked filter with a search instead of one overwriting the other', async () => {
        const a = await patient(8);
        // Blocked, and matches the search.
        await item(a._id, { title: 'BRCA Genetic Test', productId: undefined, productName: undefined });
        // Blocked, but does not match the search.
        await item(a._id, { title: 'Colonoscopy', type: 'scan', productId: undefined, productName: undefined });
        // Matches the search, but is not blocked.
        await item(a._id, { title: 'BRCA Genetic Test' });

        const res = mockRes();
        await listAllPlanItems(req({ blocked: 'true', search: 'BRCA' }), res);

        const payload = res.json.mock.calls[0][0];
        expect(payload.total).toBe(1);
        expect(payload.items[0].blockedReason).toMatch(/No catalogue product/);
    });
});

describe('blocked items — the catalogue gap nothing else reports', () => {
    it('flags a test with no product and a consultation with no professional', async () => {
        const a = await patient(9);
        await item(a._id, { title: 'BRCA1/BRCA2 Genetic Test', productId: undefined, productName: undefined });
        await item(a._id, {
            type: 'consultation',
            title: 'Consult Cardiology',
            speciality: 'Cardiology',
            productId: undefined,
            productName: undefined,
        });

        const res = mockRes();
        await listAllPlanItems(req({ blocked: 'true' }), res);

        const payload = res.json.mock.calls[0][0];
        expect(payload.total).toBe(2);
        expect(payload.items.map((i) => i.blockedReason)).toEqual(
            expect.arrayContaining([
                'No catalogue product matches this test',
                'No professional listed under Cardiology',
            ])
        );
    });

    it('never reports lifestyle advice as a catalogue gap', async () => {
        const a = await patient(10);
        await item(a._id, {
            type: 'lifestyle',
            title: 'Limit alcohol',
            dueDate: new Date(),
            productId: undefined,
            productName: undefined,
        });

        const res = mockRes();
        await listAllPlanItems(req({ blocked: 'true' }), res);
        expect(res.json.mock.calls[0][0].total).toBe(0);

        const stats = mockRes();
        await getPlanItemStats(req(), stats);
        expect(stats.json.mock.calls[0][0].gaps.products).toHaveLength(0);
    });
});

describe('getPlanItemStats', () => {
    it('returns every enum value including the zeroes', async () => {
        const a = await patient(11);
        await item(a._id);

        const res = mockRes();
        await getPlanItemStats(req(), res);

        const payload = res.json.mock.calls[0][0];
        expect(payload.counts.status).toEqual(
            expect.objectContaining({ upcoming: 1, due: 0, urgent: 0, dismissed: 0 })
        );
        expect(payload.counts.type.lifestyle).toBe(0);
        expect(payload.counts.source.specialist).toBe(0);
    });

    it('reports completion as null when nothing has come due', async () => {
        const a = await patient(12);
        await item(a._id, { dueDate: days(30) });

        const res = mockRes();
        await getPlanItemStats(req(), res);

        expect(res.json.mock.calls[0][0].completion.rate).toBeNull();
    });

    it('measures completion only over items that have come due, and drops dismissed ones', async () => {
        const a = await patient(13);
        await item(a._id, { dueDate: days(-20), status: 'completed', completedAt: days(-19) });
        await item(a._id, { dueDate: days(-10), status: 'urgent' });
        // Neither a success nor a failure — a decision, so it leaves the denominator.
        await item(a._id, { dueDate: days(-5), status: 'dismissed' });
        // Not due yet, so not counted either way.
        await item(a._id, { dueDate: days(40) });

        const res = mockRes();
        await getPlanItemStats(req(), res);

        const { completion } = res.json.mock.calls[0][0];
        expect(completion.due).toBe(2);
        expect(completion.completed).toBe(1);
        expect(completion.rate).toBe(50);
    });

    it('counts a gap by people as well as by items', async () => {
        const a = await patient(14);
        const b = await patient(15);
        // One person's ten-year screening schedule is ten items and one patient.
        await item(a._id, { title: 'BRCA Genetic Test', productId: undefined });
        await item(a._id, { title: 'BRCA Genetic Test', dueDate: days(400), productId: undefined });
        await item(b._id, { title: 'BRCA Genetic Test', productId: undefined });

        const res = mockRes();
        await getPlanItemStats(req(), res);

        const gap = res.json.mock.calls[0][0].gaps.products[0];
        expect(gap).toEqual({ label: 'BRCA Genetic Test', count: 3, patients: 2 });
    });

    it('names no patient, and therefore writes no audit entry', async () => {
        const a = await patient(16);
        await item(a._id);

        const res = mockRes();
        await getPlanItemStats(req(), res);

        const serialised = JSON.stringify(res.json.mock.calls[0][0]);
        expect(serialised).not.toContain('p16@example.com');
        expect(await AccessLog.countDocuments({})).toBe(0);
    });
});

/**
 * The account list is where the oversight table links a patient row, and the link carries
 * an opaque id rather than an email — a query-string identifier ends up in server logs and
 * browser history, which is the portal's own rule 6. That only works if the search resolves
 * an id.
 */
describe('getAllUsers — an id is a search term', () => {
    const { getAllUsers } = require('../controllers/userController');

    it('resolves an account id, and still matches on email otherwise', async () => {
        const a = await patient(19);
        await patient(20);

        const byId = mockRes();
        await getAllUsers({ query: { search: String(a._id) } }, byId);
        expect(byId.json.mock.calls[0][0].total).toBe(1);
        expect(byId.json.mock.calls[0][0].items[0].email).toBe('p19@example.com');

        const byEmail = mockRes();
        await getAllUsers({ query: { search: 'p20@example.com' } }, byEmail);
        expect(byEmail.json.mock.calls[0][0].total).toBe(1);
    });
});
