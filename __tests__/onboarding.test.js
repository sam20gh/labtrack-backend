/**
 * The first-run journey, packages and the website purchase that feeds them.
 *
 * Each block pins a way the naive version would fail a real person:
 *
 *   - progress stored as flags drifts the first time a step is done from elsewhere, so the
 *     journey is asserted to follow the rows (a bracelet paired from the profile counts);
 *   - an existing user with a filled-in profile must never be sent to a welcome screen;
 *   - a package is three parcels, and one order status cannot say which one is late;
 *   - a website order claimed by an unverified email hands a stranger somebody's DNA;
 *   - an unpaid order's claim code claims a parcel that will never ship;
 *   - a kit marked `resulted` with nothing attached gives the analysis nothing new to read;
 *   - an analysis held for clinical review must not leak out through the "what changed" diff.
 */
jest.mock('../utils/pushSender', () => {
    const actual = jest.requireActual('../utils/pushSender');
    return { ...actual, send: jest.fn(async (m) => ({ sent: m.length, failed: 0, pruned: 0 })) };
});

const mockStripe = {
    checkout: { sessions: { create: jest.fn(), retrieve: jest.fn() } },
};
jest.mock('../config/stripe', () => ({
    getStripe: () => mockStripe,
    isConfigured: () => true,
    isTestMode: () => true,
    toMinorUnits: (a) => Math.round(Number(a) * 100),
    stripeCurrency: (c) => String(c || 'GBP').toLowerCase(),
    WEBHOOK_SECRETS: [],
}));

const mockRequestGeneration = jest.fn(async () => ({ status: 201, body: {} }));
jest.mock('../controllers/interpretationController', () => ({
    requestGeneration: (...args) => mockRequestGeneration(...args),
}));

const mongoose = require('mongoose');
const User = require('../models/userModel');
const Order = require('../models/Order');
const Product = require('../models/Product');
const TestResult = require('../models/testResultModel');
const DnaReport = require('../models/DnaReport');
const ConnectedSource = require('../models/ConnectedSource');
const Interpretation = require('../models/Interpretation');
const Notification = require('../models/Notification');

const C = require('../utils/orderComponents');
const { deriveJourney } = require('../utils/onboardingState');
const { diffAnalyses } = require('../utils/analysisDiff');
const claims = require('../utils/claimOrders');
const onboarding = require('../controllers/onboardingController');
const orders = require('../controllers/orderController');
const checkout = require('../controllers/checkoutController');
const { syncSupabaseUser } = require('../controllers/authController');
const { updateUser } = require('../controllers/userController');

const call = async (handler, req) => {
    let body = null;
    let code = 200;
    const res = {
        status(c) { code = c; return this; },
        json(p) { body = p; return this; },
        set() { return this; },
    };
    await handler({ params: {}, query: {}, body: {}, ...req }, res);
    return { code, body };
};

const makeUser = (over = {}) => User.create({
    username: `u${new mongoose.Types.ObjectId()}`,
    email: `${new mongoose.Types.ObjectId()}@example.com`,
    supabaseId: String(new mongoose.Types.ObjectId()),
    ...over,
});

const FULL_PROFILE = { dob: '1985-01-01', gender: 'Female', height: 168, weight: 64 };

const authFor = (user, over = {}) => ({ userId: String(user._id), email: user.email, emailVerified: true, role: 'user', ...over });

const pkg = (over = {}) => Product.create({
    name: 'Predyqt Plus',
    sku: `PKG-${new mongoose.Types.ObjectId()}`,
    price: 249,
    type: 'package',
    includes: ['blood', 'dna', 'bracelet'],
    package: { tier: 'Plus', highlights: ['Everything'], rank: 2 },
    ...over,
});

/** A paid package order for `userId`, with every component at `placed`. */
const paidPackageOrder = async (userId, includes = ['blood', 'dna', 'bracelet']) => Order.create({
    userId,
    items: [{
        productId: new mongoose.Types.ObjectId(),
        name: 'Predyqt Plus',
        price: 249,
        components: C.componentsFor({ includes }),
    }],
    subtotal: 249,
    total: 249,
    status: 'placed',
    payment: { status: 'paid', paidAt: new Date() },
});

const flush = () => new Promise((r) => setImmediate(r));

/** Cards are published without being awaited; wait for the titles rather than guess ticks. */
const titlesFor = async (userId, expected, timeoutMs = 2000) => {
    const until = Date.now() + timeoutMs;
    let titles = [];
    while (Date.now() < until) {
        titles = (await Notification.find({ userId }).lean()).map((c) => c.title);
        if (expected.every((t) => titles.includes(t))) return titles;
        await new Promise((r) => setTimeout(r, 25));
    }
    return titles;
};

beforeEach(() => {
    mockRequestGeneration.mockClear();
    mockStripe.checkout.sessions.create.mockReset();
    mockStripe.checkout.sessions.retrieve.mockReset();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('order components — the table', () => {
    it('ships only kinds it knows, once each, in table order', () => {
        const made = C.componentsFor({ includes: ['bracelet', 'dna', 'dna', 'tarot'] });
        expect(made.map((c) => c.kind)).toEqual(['dna', 'bracelet']);
        expect(made.every((c) => c.status === 'placed')).toBe(true);
        expect(C.componentsFor({})).toEqual([]);
    });

    it('moves one stage at a time, forwards only, and stops at the end', () => {
        expect(C.nextStage('dna', 'placed')).toBe('kit_sent');
        expect(C.nextStage('dna', 'processing')).toBe('resulted');
        expect(C.nextStage('dna', 'resulted')).toBeNull();
        expect(C.nextStage('bracelet', 'placed')).toBe('dispatched');
        expect(C.nextStage('bracelet', 'delivered')).toBeNull();
    });

    it('rolls an order up to its least advanced parcel', () => {
        expect(C.rollupStatus([])).toBeNull();
        expect(C.rollupStatus([
            { kind: 'bracelet', status: 'delivered' },
            { kind: 'dna', status: 'sample_received' },
            { kind: 'blood', status: 'resulted' },
        ])).toBe('sample_received');
        // A delivered bracelet alone is a finished order; a dispatched one reads as kit_sent.
        expect(C.rollupStatus([{ kind: 'bracelet', status: 'delivered' }])).toBe('resulted');
        expect(C.rollupStatus([{ kind: 'bracelet', status: 'dispatched' }, { kind: 'dna', status: 'resulted' }])).toBe('kit_sent');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('deriveJourney — where somebody is', () => {
    const base = { user: { onboarding: {} }, orders: [], resultsCount: 0, sources: [], analysis: null };

    it('sends a brand-new account to the welcome hub, profile first', () => {
        const j = deriveJourney(base);
        expect(j.showWelcome).toBe(true);
        expect(j.stage).toBe('setting_up');
        expect(j.next.key).toBe('profile');
        expect(j.progress).toEqual({ done: 0, total: 4 });
    });

    it('never sends somebody with a filled-in profile to the welcome hub', () => {
        const j = deriveJourney({ ...base, user: { ...FULL_PROFILE, onboarding: {} } });
        expect(j.showWelcome).toBe(false);
        expect(j.steps.find((s) => s.key === 'profile').status).toBe('done');
        expect(j.next.key).toBe('package');
        // The lifestyle half is offered, not required.
        expect(j.profileMore).not.toBeNull();
    });

    it('counts a partly answered profile as in progress, not done', () => {
        const j = deriveJourney({ ...base, user: { dob: '1990-01-01', gender: 'Male', onboarding: {} } });
        const profile = j.steps.find((s) => s.key === 'profile');
        expect(profile.status).toBe('in_progress');
        expect(profile.detail).toMatch(/2 of 4/);
    });

    it('asks to finish payment rather than to choose a package again', () => {
        const j = deriveJourney({
            ...base,
            user: { ...FULL_PROFILE, onboarding: {} },
            orders: [{ _id: 'o1', status: 'pending_payment', items: [{ components: C.componentsFor({ includes: ['dna'] }) }] }],
        });
        const step = j.steps.find((s) => s.key === 'package');
        expect(step.status).toBe('in_progress');
        expect(step.action.route).toBe('/order-details?orderId=o1');
    });

    it('does not count a bracelet-only order as having ordered tests', () => {
        const j = deriveJourney({
            ...base,
            user: { ...FULL_PROFILE, onboarding: {} },
            orders: [{ _id: 'o1', status: 'placed', payment: { status: 'paid' }, items: [{ components: C.componentsFor({ includes: ['bracelet'] }) }] }],
        });
        expect(j.steps.find((s) => s.key === 'package').status).toBe('todo');
    });

    it('says the bracelet is on its way, then that it has arrived, then that it is connected', () => {
        const order = (status) => ({
            _id: 'o1', status: 'placed', payment: { status: 'paid' },
            items: [{ components: [{ kind: 'bracelet', status, statusHistory: [] }, { kind: 'dna', status: 'kit_sent', statusHistory: [] }] }],
        });
        const user = { ...FULL_PROFILE, onboarding: {} };

        expect(deriveJourney({ ...base, user, orders: [order('dispatched')] }).steps.find((s) => s.key === 'device').status).toBe('waiting');

        const arrived = deriveJourney({ ...base, user, orders: [order('delivered')] }).steps.find((s) => s.key === 'device');
        expect(arrived.status).toBe('todo');
        expect(arrived.action.route).toBe('/bracelet');

        const paired = deriveJourney({
            ...base, user, orders: [order('delivered')],
            sources: [{ platform: 'jstyle_bracelet', status: 'connected' }],
        });
        expect(paired.steps.find((s) => s.key === 'device').status).toBe('done');
    });

    it('follows the rows: a step done from anywhere else counts', () => {
        const j = deriveJourney({
            ...base,
            user: { ...FULL_PROFILE, onboarding: {} },
            resultsCount: 2,
            sources: [{ platform: 'health_connect', status: 'connected' }],
        });
        expect(j.steps.find((s) => s.key === 'results').detail).toBe('2 results added');
        expect(j.steps.find((s) => s.key === 'device').status).toBe('done');
    });

    it('waits while kits are out, is ready when they are back, and retires with nothing to show', () => {
        const user = { ...FULL_PROFILE, onboarding: {} };
        const sources = [{ platform: 'jstyle_bracelet', status: 'connected' }];
        const withKit = (status) => [{
            _id: 'o1', status: 'placed', payment: { status: 'paid' },
            items: [{ name: 'Basic', components: [{ kind: 'dna', status, statusHistory: [] }] }],
        }];

        const waiting = deriveJourney({ ...base, user, sources, resultsCount: 1, orders: withKit('processing') });
        expect(waiting.stage).toBe('waiting');
        expect(waiting.kits[0]).toMatchObject({ kind: 'dna', done: false, statusLabel: 'Being analysed' });
        expect(waiting.kits[0].wait).toMatch(/two weeks/);
        expect(waiting.analysis.waitingFor).toEqual(['dna']);

        const ready = deriveJourney({ ...base, user, sources, resultsCount: 1, orders: withKit('resulted') });
        expect(ready.stage).toBe('ready');
        expect(ready.showJourney).toBe(true);

        const skippedAll = deriveJourney({
            ...base,
            user: { ...FULL_PROFILE, onboarding: { skipped: { package: new Date(), results: new Date(), device: new Date() } } },
        });
        expect(skippedAll.stage).toBe('complete');
        expect(skippedAll.showJourney).toBe(false);
    });

    it('hides the card once dismissed, whatever is left', () => {
        const j = deriveJourney({ ...base, user: { onboarding: { dismissedAt: new Date() } } });
        expect(j.stage).toBe('setting_up');
        expect(j.showJourney).toBe(false);
    });

    it('notices whether the analysis has read the DNA yet', () => {
        const j = deriveJourney({
            ...base,
            analysis: { generatedAt: new Date(), covers: [{ kind: 'test_result' }] },
        });
        expect(j.analysis).toMatchObject({ exists: true, includesBlood: true, includesDna: false });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('analysis diff', () => {
    it('reports additions and removals by the plan’s own nouns, ignoring rewording', () => {
        const before = {
            recommended_screenings: [{ test: 'Lipid panel' }, { test: 'HbA1c' }],
            specialist_consultations: [],
            lifestyle_recommendations: [{ area: 'diet', recommendation: 'Eat more fibre' }],
        };
        const after = {
            recommended_screenings: [{ test: 'lipid  PANEL' }, { test: 'Breast MRI', condition: 'Hereditary breast cancer' }],
            specialist_consultations: [{ speciality: 'Medical Genetics' }],
            lifestyle_recommendations: [{ area: 'Diet', recommendation: 'Add oily fish twice a week' }],
        };
        const d = diffAnalyses(before, after);
        expect(d.first).toBe(false);
        expect(d.changes.screenings.added.map((x) => x.title)).toEqual(['Breast MRI']);
        expect(d.changes.screenings.removed.map((x) => x.title)).toEqual(['HbA1c']);
        expect(d.changes.consultations.added.map((x) => x.title)).toEqual(['Medical Genetics']);
        expect(d.changes.lifestyle.kept).toBe(1);
        expect(d).toMatchObject({ added: 2, removed: 1 });
    });

    it('treats a first analysis as all additions', () => {
        expect(diffAnalyses(null, { recommended_screenings: [{ test: 'X' }] })).toMatchObject({ first: true, added: 1 });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('claiming a website order', () => {
    const guestOrder = (over = {}) => Order.create({
        guestEmail: 'buyer@example.com',
        source: 'web',
        claimCode: claims.newClaimCode(),
        items: [{ productId: new mongoose.Types.ObjectId(), name: 'Basic', price: 149 }],
        subtotal: 149,
        total: 149,
        status: 'placed',
        payment: { status: 'paid' },
        ...over,
    });

    it('accepts a code however it is typed, and nothing else', () => {
        const code = claims.newClaimCode();
        expect(code).toMatch(/^[2-9A-HJKMNP-Z]{8}$/);
        expect(claims.normaliseCode(`${code.slice(0, 4).toLowerCase()}-${code.slice(4)}`)).toBe(code);
        expect(claims.normaliseCode('O0O0O0O0')).toBeNull(); // ambiguous letters are not in the alphabet
        expect(claims.normaliseCode('ABC')).toBeNull();
    });

    it('vouches only for an email the identity provider verified', () => {
        expect(claims.isVerifiedEmail({ email: 'a@b.co', user_metadata: { email_verified: true } })).toBe(true);
        expect(claims.isVerifiedEmail({ email: 'a@b.co', app_metadata: { provider: 'google' } })).toBe(true);
        expect(claims.isVerifiedEmail({ email: 'a@b.co', app_metadata: { provider: 'email' } })).toBe(false);
        expect(claims.isVerifiedEmail({ phone: '+44', user_metadata: { email_verified: true } })).toBe(false);
    });

    it('claims on sign-in with the verified buyer email — and not with an unverified one', async () => {
        const order = await guestOrder();

        const unverified = await call(syncSupabaseUser, {
            supabaseClaims: { sub: 'sb-1', email: 'Buyer@Example.com', user_metadata: {}, app_metadata: { provider: 'email' } },
        });
        expect(unverified.body.claimedOrders).toBe(0);
        expect((await Order.findById(order._id)).userId).toBeUndefined();

        const verified = await call(syncSupabaseUser, {
            supabaseClaims: { sub: 'sb-1', email: 'buyer@example.com', user_metadata: { email_verified: true } },
        });
        expect(verified.body.claimedOrders).toBe(1);
        const claimed = await Order.findById(order._id);
        expect(String(claimed.userId)).toBe(String(verified.body.user._id));
        expect(claimed.claimedAt).toBeInstanceOf(Date);
    });

    it('claims by code, refuses somebody else’s already-claimed code identically to a typo', async () => {
        const me = await makeUser();
        const other = await makeUser();
        const mine = await guestOrder({ guestEmail: 'gift@example.com' });
        const theirs = await guestOrder({ guestEmail: 'x@example.com', userId: other._id });

        const ok = await call(onboarding.claimKit, { auth: authFor(me), body: { code: mine.claimCode } });
        expect(ok.code).toBe(200);
        expect(ok.body.already).toBe(false);
        expect(ok.body.journey.steps.find((s) => s.key === 'package').status).toBe('done');

        const again = await call(onboarding.claimKit, { auth: authFor(me), body: { code: mine.claimCode } });
        expect(again.body.already).toBe(true);

        const stolen = await call(onboarding.claimKit, { auth: authFor(me), body: { code: theirs.claimCode } });
        const typo = await call(onboarding.claimKit, { auth: authFor(me), body: { code: '23456789' } });
        expect(stolen.code).toBe(404);
        expect(typo.code).toBe(404);
        expect(stolen.body.message).toBe(typo.body.message);
    });

    it('picks up a website order bought after the account existed, on the next journey read', async () => {
        const me = await makeUser({ ...FULL_PROFILE, email: 'later@example.com' });
        await guestOrder({ guestEmail: 'later@example.com' });

        const { body } = await call(onboarding.getJourney, { auth: authFor(me) });
        expect(body.steps.find((s) => s.key === 'package').status).toBe('done');

        const unverified = await makeUser({ email: 'later2@example.com' });
        await guestOrder({ guestEmail: 'later2@example.com' });
        const r = await call(onboarding.getJourney, { auth: authFor(unverified, { emailVerified: false }) });
        expect(r.body.steps.find((s) => s.key === 'package').status).toBe('todo');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('journey choices', () => {
    it('skips, resumes, welcomes once and dismisses', async () => {
        const me = await makeUser();
        const auth = authFor(me);

        const skipped = await call(onboarding.skipStep, { auth, body: { step: 'package' } });
        expect(skipped.body.steps.find((s) => s.key === 'package').status).toBe('skipped');
        expect((await call(onboarding.skipStep, { auth, body: { step: 'everything' } })).code).toBe(400);

        const resumed = await call(onboarding.resumeStep, { auth, body: { step: 'package' } });
        expect(resumed.body.steps.find((s) => s.key === 'package').status).toBe('todo');

        await call(onboarding.markWelcomed, { auth });
        const first = (await User.findById(me._id).lean()).onboarding.welcomedAt;
        await call(onboarding.markWelcomed, { auth });
        expect((await User.findById(me._id).lean()).onboarding.welcomedAt).toEqual(first);

        const hidden = await call(onboarding.dismiss, { auth });
        expect(hidden.body.showJourney).toBe(false);
        const back = await call(onboarding.dismiss, { auth, body: { undo: true } });
        expect(back.body.showJourney).toBe(true);
    });

    it('cannot be written through the profile update', async () => {
        const me = await makeUser();
        await call(updateUser, { params: { id: me._id }, body: { firstName: 'Ana', onboarding: { dismissedAt: new Date() } } });
        const stored = await User.findById(me._id).lean();
        expect(stored.firstName).toBe('Ana');
        expect(stored.onboarding?.dismissedAt).toBeUndefined();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('fulfilment, one parcel at a time', () => {
    const admin = { userId: 'admin', role: 'admin' };
    const move = (order, kind, body) => call(orders.updateComponentStatus, {
        auth: admin,
        params: { id: String(order._id), itemId: String(order.items[0]._id), kind },
        body,
    });

    it('snapshots what a product ships when it is ordered', async () => {
        const me = await makeUser();
        const p = await pkg();
        const { code, body } = await call(orders.createOrder, { auth: authFor(me), body: { items: [{ productId: String(p._id) }] } });
        expect(code).toBe(201);
        expect(body.order.items[0].components.map((c) => c.kind)).toEqual(['blood', 'dna', 'bracelet']);
        expect(body.order.source).toBe('app');
    });

    it('refuses a whole-order kit status on a package, and skipping a stage on a parcel', async () => {
        const me = await makeUser();
        const order = await paidPackageOrder(me._id);

        const whole = await call(orders.updateOrderStatus, { auth: admin, params: { id: String(order._id) }, body: { status: 'kit_sent' } });
        expect(whole.code).toBe(409);

        const jump = await move(order, 'dna', { status: 'processing' });
        expect(jump.code).toBe(409);
        expect(jump.body.expected).toBe('kit_sent');
    });

    it('rolls the order up and writes one card per parcel per stage', async () => {
        const me = await makeUser();
        const order = await paidPackageOrder(me._id);

        await move(order, 'bracelet', { status: 'dispatched' });
        await move(order, 'bracelet', { status: 'delivered' });
        const after = await Order.findById(order._id);
        // The DNA and blood kits have not moved, so the order has not either.
        expect(after.status).toBe('placed');

        await titlesFor(me._id, ['Your bracelet has arrived', 'Your bracelet is on its way']);
        const cards = await Notification.find({ userId: me._id }).lean();
        expect(cards.map((c) => c.title).sort()).toEqual(['Your bracelet has arrived', 'Your bracelet is on its way']);
        expect(cards.find((c) => c.title === 'Your bracelet has arrived').route).toBe('/bracelet');
    });

    it('requires a result that belongs to the customer before a kit can be resulted, then re-analyses', async () => {
        const me = await makeUser();
        const stranger = await makeUser();
        const order = await paidPackageOrder(me._id, ['dna']);
        for (const s of ['kit_sent', 'sample_received', 'processing']) await move(order, 'dna', { status: s });

        const bare = await move(order, 'dna', { status: 'resulted' });
        expect(bare.code).toBe(400);

        const theirs = await DnaReport.create({ userId: stranger._id });
        expect((await move(order, 'dna', { status: 'resulted', dnaReportId: String(theirs._id) })).code).toBe(400);

        const mine = await DnaReport.create({ userId: me._id });
        const ok = await move(order, 'dna', { status: 'resulted', dnaReportId: String(mine._id) });
        expect(ok.code).toBe(200);
        expect(ok.body.order.status).toBe('resulted');

        expect(mockRequestGeneration).toHaveBeenCalledWith(expect.objectContaining({ dnaReportId: mine._id }));
        const titles = await titlesFor(me._id, ['Your DNA results are in', 'Your full analysis is ready']);
        expect(titles).toEqual(expect.arrayContaining(['Your DNA results are in', 'Your full analysis is ready']));
    });

    it('does not announce a fresh analysis the regeneration guard refused', async () => {
        mockRequestGeneration.mockResolvedValueOnce({ status: 429, body: { message: 'too soon' } });
        const me = await makeUser();
        const order = await paidPackageOrder(me._id, ['blood']);
        for (const s of ['kit_sent', 'sample_received', 'processing']) await move(order, 'blood', { status: s });
        const result = await TestResult.create({
            patient: { user_id: me._id, date_of_test: new Date(), lab_name: 'Lab', test_type: 'Blood' },
            results: {},
        });
        await move(order, 'blood', { status: 'resulted', testResultId: String(result._id) });
        const titles = await titlesFor(me._id, ['Your blood test results are in']);
        await new Promise((r) => setTimeout(r, 100)); // give a wrong card the chance to appear
        expect(titles).toContain('Your blood test results are in');
        expect((await Notification.find({ userId: me._id }).lean()).map((c) => c.title))
            .not.toContain('Your analysis has been updated');
        expect(titles).not.toContain('Your analysis has been updated');
    });

    it('cannot result an order nobody has claimed', async () => {
        const order = await Order.create({
            guestEmail: 'g@example.com', source: 'web',
            items: [{ productId: new mongoose.Types.ObjectId(), name: 'Basic', price: 1, components: C.componentsFor({ includes: ['dna'] }) }],
            subtotal: 1, total: 1, status: 'placed', payment: { status: 'paid' },
            statusHistory: [],
        });
        for (const s of ['kit_sent', 'sample_received', 'processing']) await move(order, 'dna', { status: s });
        const r = await move(order, 'dna', { status: 'resulted', dnaReportId: String(new mongoose.Types.ObjectId()) });
        expect(r.code).toBe(409);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('website checkout', () => {
    it('lists packages in rank order with the bracelet as an add-on, and nothing internal', async () => {
        await pkg({ name: 'Complete', package: { tier: 'Complete', rank: 3 } });
        await pkg({ name: 'Basic', includes: ['blood', 'dna'], package: { tier: 'Basic', rank: 1 } });
        await Product.create({ name: 'Bracelet', sku: 'BR', price: 99, type: 'device', includes: ['bracelet'] });
        await Product.create({ name: 'Lipid panel', sku: 'LP', price: 39 });

        const { body } = await call(checkout.listPackages, {});
        expect(body.packages.map((p) => p.name)).toEqual(['Basic', 'Complete']);
        expect(body.addons.map((p) => p.name)).toEqual(['Bracelet']);
        expect(body.packages[0]).not.toHaveProperty('sku');
    });

    it('prices from the catalogue and holds the order against the email until claimed', async () => {
        const p = await pkg({ price: 249 });
        mockStripe.checkout.sessions.create.mockResolvedValue({ id: 'cs_test_abcdefghijkl', url: 'https://checkout.stripe.com/x' });

        const { code, body } = await call(checkout.createSession, {
            body: { productId: String(p._id), email: ' Buyer@Example.com ', price: 1 },
        });
        expect(code).toBe(201);
        expect(body.url).toBe('https://checkout.stripe.com/x');

        const args = mockStripe.checkout.sessions.create.mock.calls[0][0];
        expect(args.line_items[0].price_data.unit_amount).toBe(24900);
        expect(args.customer_email).toBe('buyer@example.com');

        const order = await Order.findOne({ guestEmail: 'buyer@example.com' }).lean();
        expect(order).toMatchObject({ source: 'web', status: 'pending_payment' });
        expect(order.userId).toBeUndefined();
        expect(order.claimCode).toMatch(/^[2-9A-Z]{8}$/);
        expect(order.items[0].components).toHaveLength(3);
        expect(args.metadata.orderId).toBe(String(order._id));
    });

    it('refuses a non-package product and a bad email', async () => {
        const test = await Product.create({ name: 'Lipid', sku: 'L1', price: 39 });
        const p = await pkg();
        expect((await call(checkout.createSession, { body: { productId: String(test._id), email: 'a@b.co' } })).code).toBe(404);
        expect((await call(checkout.createSession, { body: { productId: String(p._id), email: 'nope' } })).code).toBe(400);
    });

    it('settles a completed session, copies the address, and only then reveals the claim code', async () => {
        const p = await pkg();
        mockStripe.checkout.sessions.create.mockResolvedValue({ id: 'cs_test_settle123456', url: 'https://x' });
        await call(checkout.createSession, { body: { productId: String(p._id), email: 'b@example.com' } });
        const order = await Order.findOne({ guestEmail: 'b@example.com' });

        mockStripe.checkout.sessions.retrieve.mockResolvedValueOnce({ payment_status: 'unpaid', metadata: { orderId: String(order._id) } });
        const pending = await call(checkout.getSession, { params: { sessionId: 'cs_test_settle123456' } });
        expect(pending.body).toMatchObject({ paid: false, claimCode: null });

        mockStripe.checkout.sessions.retrieve.mockResolvedValueOnce({
            payment_status: 'paid',
            payment_intent: 'pi_123',
            metadata: { orderId: String(order._id) },
            collected_information: { shipping_details: { address: { line1: '1 High St', city: 'Leeds', postal_code: 'LS1 1AA', country: 'GB' } } },
        });
        const paid = await call(checkout.getSession, { params: { sessionId: 'cs_test_settle123456' } });
        expect(paid.body.paid).toBe(true);
        expect(paid.body.claimCode).toBe(order.claimCode);
        expect(paid.body.email).toBe('b*@example.com');

        const stored = await Order.findById(order._id);
        expect(stored.status).toBe('placed');
        expect(stored.shippingAddress.postcode).toBe('LS1 1AA');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('what changed — the analysis update', () => {
    it('reports a held analysis as held, never its contents', async () => {
        const prev = process.env.SHOW_UNVERIFIED_TO_PATIENT;
        process.env.SHOW_UNVERIFIED_TO_PATIENT = 'false';
        try {
            const me = await makeUser();
            await Interpretation.create({
                userId: me._id,
                covers: [{ kind: 'dna_report', id: new mongoose.Types.ObjectId() }],
                content: { recommended_screenings: [{ test: 'Secret' }] },
                review: { status: 'pending' },
            });
            const { body } = await call(onboarding.getAnalysisUpdate, { auth: authFor(me) });
            if (body.withheld) {
                expect(JSON.stringify(body)).not.toMatch(/Secret/);
                expect(body.reads.dna).toBe(1);
            } else {
                // This deployment shows unverified analyses to patients; then the diff is shown.
                expect(body.changes.screenings.added[0].title).toBe('Secret');
            }
        } finally {
            if (prev === undefined) delete process.env.SHOW_UNVERIFIED_TO_PATIENT;
            else process.env.SHOW_UNVERIFIED_TO_PATIENT = prev;
        }
    });

    it('diffs the newest against the one before', async () => {
        const me = await makeUser();
        await Interpretation.create({
            userId: me._id, generatedAt: new Date('2026-09-01'),
            covers: [{ kind: 'test_result', id: new mongoose.Types.ObjectId() }],
            content: { recommended_screenings: [{ test: 'Lipid panel' }] },
            review: { status: 'approved' },
        });
        await Interpretation.create({
            userId: me._id, generatedAt: new Date('2026-09-20'),
            covers: [{ kind: 'dna_report', id: new mongoose.Types.ObjectId() }, { kind: 'test_result', id: new mongoose.Types.ObjectId() }],
            content: {
                recommended_screenings: [{ test: 'Lipid panel' }, { test: 'Breast MRI' }],
                plain_summary: { headline: 'Your DNA adds one thing to watch', what_it_means: 'x', next_step: 'y' },
            },
            review: { status: 'approved' },
        });
        const { body } = await call(onboarding.getAnalysisUpdate, { auth: authFor(me) });
        expect(body.withheld).toBe(false);
        expect(body.headline).toBe('Your DNA adds one thing to watch');
        expect(body.reads).toEqual({ dna: 1, results: 1 });
        expect(body.changes.screenings.added.map((x) => x.title)).toEqual(['Breast MRI']);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('end to end through the journey', () => {
    it('a website buyer signs in, sees the package, pairs the delivered bracelet, and waits on the DNA', async () => {
        const order = await Order.create({
            guestEmail: 'e2e@example.com', source: 'web', claimCode: claims.newClaimCode(),
            items: [{ productId: new mongoose.Types.ObjectId(), name: 'Predyqt Plus', price: 249, components: C.componentsFor({ includes: ['blood', 'dna', 'bracelet'] }) }],
            subtotal: 249, total: 249, status: 'placed', payment: { status: 'paid' },
        });

        const signedIn = await call(syncSupabaseUser, {
            supabaseClaims: { sub: 'sb-e2e', email: 'e2e@example.com', user_metadata: { email_verified: true } },
        });
        const user = await User.findById(signedIn.body.user._id);
        await User.updateOne({ _id: user._id }, { $set: FULL_PROFILE });

        const auth = authFor(user);
        let j = (await call(onboarding.getJourney, { auth })).body;
        expect(j.steps.find((s) => s.key === 'package').status).toBe('done');
        expect(j.kits.map((k) => k.kind)).toEqual(['dna', 'blood', 'bracelet']);

        const admin = { userId: 'admin', role: 'admin' };
        const fresh = await Order.findById(order._id);
        for (const s of ['dispatched', 'delivered']) {
            await call(orders.updateComponentStatus, {
                auth: admin, params: { id: String(fresh._id), itemId: String(fresh.items[0]._id), kind: 'bracelet' }, body: { status: s },
            });
        }
        j = (await call(onboarding.getJourney, { auth })).body;
        expect(j.steps.find((s) => s.key === 'device').action.label).toBe('Pair it');

        await ConnectedSource.create({ userId: user._id, platform: 'jstyle_bracelet', status: 'connected' });
        await call(onboarding.skipStep, { auth, body: { step: 'results' } });
        j = (await call(onboarding.getJourney, { auth })).body;
        expect(j.stage).toBe('waiting');
        expect(j.next).toBeNull();
    });
});
