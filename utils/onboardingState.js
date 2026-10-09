/**
 * Where somebody is in their first weeks, worked out from what they have actually done.
 *
 * The journey is: tell us about yourself, get a package, bring in any results you already
 * have, connect a device — and then wait, for about two weeks, while the kits travel to a
 * laboratory and back. Each arrival makes the analysis sharper, and the DNA report is the
 * last and largest of them.
 *
 * **Progress is derived, never stored.** Nothing here records "step 3 done". The profile is
 * done when the profile fields are filled in, the package when an order exists, the device
 * when a source is connected — so a bracelet paired from the profile screen, or a result
 * uploaded from the results tab, completes the journey exactly as if the journey had sent
 * them there. A stored flag would drift the first time somebody did a step from somewhere
 * else, which in an app with this many ways in is the first week. The same rule the score and
 * the achievements follow. Only *choices* are stored — skipped, welcomed, dismissed — on
 * `User.onboarding`, because nothing else records a decision.
 *
 * Pure: no database and no clock it was not handed, so `__tests__/onboarding.test.js` can
 * pin every state without one. `controllers/onboardingController.js` gathers the rows.
 */
const C = require('./orderComponents');
const { describeSlot } = require('./markets');

/** Visit states in which a technician is still coming. */
const VISIT_LIVE = ['held', 'booked', 'assigned', 'en_route', 'arrived'];

/** The four steps somebody is asked to take, in the order the welcome hub asks them. */
const STEPS = ['profile', 'package', 'results', 'device'];

/**
 * The profile fields every downstream feature leans on: the score's body pillar, the cycle
 * tracker's offer, hydration targets, reference ranges by age and sex, and the interpretation
 * itself. Two minutes of questions — the rest of the assessment is "complete your profile".
 */
const ESSENTIALS = ['dob', 'gender', 'height', 'weight'];

const filled = (v) => v !== null && v !== undefined && String(v).trim() !== '';

/** Statuses an order can be in and still be something the person is waiting on. */
const LIVE = (o) => !['cancelled', 'refunded'].includes(o?.status);
const PAID = (o) => o?.payment?.status === 'paid' || (LIVE(o) && o?.status !== 'pending_payment');

const profileStep = (user, skipped) => {
    const have = ESSENTIALS.filter((k) => filled(user?.[k])).length;
    if (have === ESSENTIALS.length) {
        return { key: 'profile', status: 'done', title: 'About you', detail: 'Your profile is set up', action: null };
    }
    if (skipped) {
        return {
            key: 'profile', status: 'skipped', title: 'About you',
            detail: 'Your age, height and weight make every reading more accurate',
            action: { label: 'Add them', route: '/health-assessment?mode=essentials' },
        };
    }
    return {
        key: 'profile',
        status: have ? 'in_progress' : 'todo',
        title: 'About you',
        detail: have ? `${have} of ${ESSENTIALS.length} basics answered` : 'Six quick questions, about two minutes',
        action: { label: have ? 'Finish' : 'Start', route: '/health-assessment?mode=essentials' },
    };
};

/**
 * Has the person answered past the essentials? The lifestyle half of the assessment is
 * optional and is offered as "complete your profile", never required: a bracelet measures
 * most of it better than a questionnaire, and the score already discards a reported value
 * once the same thing is measured.
 */
const answeredLifestyle = (user) => {
    const ha = user?.healthAssessment || {};
    const l = ha.lifestyle || {};
    return Boolean(
        filled(l.fitnessLevel) || filled(l.dietType) || (l.exerciseTypes || []).length ||
        (ha.conditions || []).length || (ha.medications || []).length
    );
};

/** Orders that ship something to be tested: a kit, not just a bracelet. */
const shipsTests = (order) =>
    (order.items || []).some((i) =>
        !(i.components || []).length || (i.components || []).some((c) => c.kind !== 'bracelet'));

/** Home-collection parcels on a paid order that are still waiting for a visit to be booked. */
const awaitingVisit = (order) => (order.items || []).some((i) =>
    (i.components || []).some((c) => c.method === 'home_collection' && c.status === 'placed'));

const packageStep = (orders, skipped, visits = []) => {
    const live = orders.filter((o) => LIVE(o) && shipsTests(o));
    const paid = live.find(PAID);
    // A visit that has to be chosen again — the slot filled while they paid, or nobody was in.
    // Superseded once a live visit covers the same order — the person has already rebooked.
    const shares = (a, b) => (a.orderIds || []).some((id) => (b.orderIds || []).map(String).includes(String(id)));
    const rebook = visits.find((v) => (v.status === 'needs_rebooking' || v.status === 'missed')
        && !visits.some((w) => VISIT_LIVE.includes(w.status) && shares(w, v)));
    if (rebook) {
        return {
            key: 'package', status: 'in_progress', title: 'Your collection visit',
            detail: rebook.status === 'missed' ? 'We missed you. Choose a new time' : 'Your time filled up. Choose a new one',
            // A visit that needs a new time is moved; a missed one is over, so a new one is booked.
            action: {
                label: 'Choose a time',
                route: rebook.status === 'missed'
                    ? `/collection/book?orderId=${(rebook.orderIds || [])[0]}`
                    : `/collection/${rebook._id}`,
            },
            orderId: paid ? String(paid._id) : undefined,
        };
    }
    const unbooked = live.filter(PAID).find((o) => awaitingVisit(o)
        && !visits.some((v) => VISIT_LIVE.includes(v.status) && (v.orderIds || []).map(String).includes(String(o._id))));
    if (unbooked) {
        return {
            key: 'package', status: 'in_progress', title: 'Your collection visit',
            detail: 'Choose when a technician should come to collect your samples',
            action: { label: 'Book a visit', route: `/collection/book?orderId=${unbooked._id}` },
            orderId: String(unbooked._id),
        };
    }
    if (paid) {
        const name = paid.items?.[0]?.name;
        return {
            key: 'package', status: 'done', title: 'Your tests',
            detail: name ? `${name} ordered` : 'Ordered',
            action: null,
            orderId: String(paid._id),
        };
    }
    const unpaid = live.find((o) => o.status === 'pending_payment');
    if (unpaid) {
        return {
            key: 'package', status: 'in_progress', title: 'Your tests',
            detail: 'Payment was not finished',
            action: { label: 'Finish payment', route: `/order-details?orderId=${unpaid._id}` },
            orderId: String(unpaid._id),
        };
    }
    return {
        key: 'package',
        status: skipped ? 'skipped' : 'todo',
        title: 'Your tests',
        detail: 'Choose a package, or enter the code from a kit you bought online',
        action: { label: 'See packages', route: '/packages' },
    };
};

const resultsStep = (resultsCount, skipped) => {
    if (resultsCount > 0) {
        return {
            key: 'results', status: 'done', title: 'Earlier results',
            detail: resultsCount === 1 ? '1 result added' : `${resultsCount} results added`,
            action: { label: 'Add another', route: '/add-result' },
        };
    }
    return {
        key: 'results',
        status: skipped ? 'skipped' : 'todo',
        title: 'Earlier results',
        detail: 'A blood test from the last year or two gives us a head start',
        action: { label: 'Add a result', route: '/add-result' },
    };
};

const SOURCE_LABEL = { jstyle_bracelet: 'Bracelet', apple_health: 'Apple Health', health_connect: 'Health Connect' };

/** The bracelet components on live, paid orders — the one this person is waiting on. */
const braceletsOrdered = (orders) =>
    orders.filter((o) => LIVE(o) && PAID(o))
        .flatMap((o) => (o.items || []).flatMap((i) => (i.components || []).filter((c) => c.kind === 'bracelet')));

const deviceStep = (sources, orders, skipped) => {
    const byVisit = braceletsOrdered(orders).some((c) => c.method === 'home_collection' && c.status !== 'delivered');
    const connected = sources.filter((s) => s.status === 'connected');
    const bracelet = connected.find((s) => s.platform === 'jstyle_bracelet');
    if (bracelet) {
        return { key: 'device', status: 'done', title: 'Your bracelet', detail: 'Connected and recording', action: null };
    }

    const store = connected.find((s) => SOURCE_LABEL[s.platform]);
    const coming = braceletsOrdered(orders);
    const arrived = coming.find((c) => c.status === 'delivered');
    const inTransit = coming.find((c) => c.status !== 'delivered');

    if (arrived) {
        return {
            key: 'device', status: 'todo', title: 'Your bracelet',
            detail: 'It has arrived — pair it to start recording',
            action: { label: 'Pair it', route: '/bracelet' },
        };
    }
    if (store) {
        // A phone health store is a real source, and counts. A bracelet on the way is still
        // shown in the kit tracker, so nothing is lost by calling this step done.
        return {
            key: 'device', status: 'done', title: 'Your data',
            detail: `${SOURCE_LABEL[store.platform]} connected`,
            action: inTransit ? null : { label: 'Add a bracelet', route: '/bracelet' },
        };
    }
    if (inTransit) {
        return {
            key: 'device', status: 'waiting', title: 'Your bracelet',
            detail: byVisit
                ? 'Your technician brings it to your visit. Connect your phone’s health app meanwhile'
                : 'On its way. Connect your phone’s health app meanwhile',
            action: { label: 'Connect health app', route: '/activity/sources' },
        };
    }
    return {
        key: 'device',
        status: skipped ? 'skipped' : 'todo',
        title: 'Your data',
        detail: 'Pair a Predyqt bracelet, or connect your phone’s health app',
        action: { label: 'Connect', route: '/bracelet' },
    };
};

/**
 * What to say under a parcel while it waits. A visit's parcels are about the visit — when it
 * is, or that it needs booking — and, once collected, about the lab, like a posted kit.
 */
const waitFor = (c, visitLabel) => {
    if (C.isDone(c)) return null;
    if (c.method === 'home_collection') {
        if (c.status === 'placed') return 'Book a visit and a technician will collect it.';
        if (c.status === 'visit_booked') {
            const when = visitLabel ? `Technician visit ${visitLabel}.` : 'Technician visit booked.';
            return c.kind === 'bracelet' ? `${when} They will bring it with them.` : when;
        }
        if (c.status === 'collected') return 'Collected and on its way to the lab.';
    }
    return C.KIND_META[c.kind]?.wait || null;
};

/** Every component on live, paid orders, shaped for the tracker. */
const kitsFrom = (orders, visitLabel) =>
    orders.filter((o) => LIVE(o) && PAID(o)).flatMap((o) =>
        (o.items || []).flatMap((item) =>
            (item.components || []).map((c) => {
                const stages = C.stagesFor(c);
                const at = stages.indexOf(c.status);
                const last = (c.statusHistory || [])[c.statusHistory.length - 1];
                return {
                    orderId: String(o._id),
                    itemId: String(item._id),
                    componentId: c._id ? String(c._id) : null,
                    kind: c.kind,
                    label: C.KIND_META[c.kind]?.label || c.kind,
                    product: item.name,
                    status: c.status,
                    statusLabel: C.labelFor(c),
                    progress: C.progressOf(c),
                    done: C.isDone(c),
                    wait: waitFor(c, visitLabel),
                    stages: stages.map((s, i) => ({ key: s, label: C.labelFor(c, s), reached: i <= at })),
                    updatedAt: last?.at || o.updatedAt || o.createdAt || null,
                };
            })));

const KIT_ORDER = { dna: 0, blood: 1, bracelet: 2 };

/**
 * What the analysis has read, and what it is still waiting for.
 *
 * `waitingFor` is the honest sentence the card prints under an analysis written before the
 * DNA arrived: "this will be updated when your DNA results arrive", rather than letting a
 * first read pass for the whole one.
 */
const analysisFrom = (analysis, kits) => {
    const covers = analysis?.covers || [];
    const includesDna = covers.some((c) => c.kind === 'dna_report' || c.kind === 'genotype_file');
    const includesBlood = covers.some((c) => c.kind === 'test_result');
    const waitingFor = [...new Set(kits.filter((k) => !k.done && k.kind !== 'bracelet').map((k) => k.kind))];
    return {
        exists: Boolean(analysis),
        generatedAt: analysis?.generatedAt || null,
        includesDna,
        includesBlood,
        waitingFor,
    };
};

/**
 * @param {object} input
 * @param {object} input.user           lean User: profile fields, healthAssessment, onboarding
 * @param {object[]} input.orders       lean Orders claimed by this user, any status
 * @param {number} input.resultsCount   TestResult rows
 * @param {object[]} input.sources      lean ConnectedSource rows
 * @param {object|null} input.analysis  the newest Interpretation, or null
 * @param {object} [input.learned]      counts for the "what we know so far" line
 */
const deriveJourney = ({ user, orders = [], resultsCount = 0, sources = [], analysis = null, learned = {}, visits = [] }) => {
    const ob = user?.onboarding || {};
    const skipped = ob.skipped || {};

    // The next visit a technician is coming to, labelled in its market's own clock.
    const upcoming = visits
        .filter((v) => VISIT_LIVE.includes(v.status) && v.status !== 'held')
        .sort((a, b) => new Date(a.slot.start) - new Date(b.slot.start))[0] || null;
    const visit = upcoming
        ? {
            _id: String(upcoming._id),
            status: upcoming.status,
            start: upcoming.slot.start,
            label: describeSlot(new Date(upcoming.slot.start), new Date(upcoming.slot.end), upcoming.timezone),
            route: `/collection/${upcoming._id}`,
        }
        : null;

    const steps = [
        profileStep(user, skipped.profile),
        packageStep(orders, skipped.package, visits),
        resultsStep(resultsCount, skipped.results),
        deviceStep(sources, orders, skipped.device),
    ];
    const byKey = Object.fromEntries(steps.map((s) => [s.key, s]));

    const kits = kitsFrom(orders, visit?.label).sort((a, b) => (KIT_ORDER[a.kind] ?? 9) - (KIT_ORDER[b.kind] ?? 9));
    const inFlight = kits.filter((k) => !k.done);
    const resolved = (s) => s.status === 'done' || s.status === 'skipped' || s.status === 'waiting';
    const allResolved = steps.every(resolved);

    /**
     * Stage, in the order a person moves through it.
     *
     *  - `setting_up`  something on the list is still theirs to do
     *  - `waiting`     everything they can do is done; parcels or a lab are the holdup
     *  - `ready`       every kit has come back — the full analysis is the last thing to show
     *  - `complete`    nothing to show; the card retires
     */
    let stage;
    if (!allResolved || steps.some((s) => s.status === 'in_progress')) stage = 'setting_up';
    else if (inFlight.length) stage = 'waiting';
    else if (kits.some((k) => k.kind !== 'bracelet')) stage = 'ready';
    else stage = 'complete';

    const next = steps.find((s) => s.status === 'todo' || s.status === 'in_progress') || null;

    return {
        stage,
        /**
         * The welcome hub is for somebody who has not told us about themselves yet. A person
         * with a filled-in profile — everybody who used the app before this existed — is never
         * sent there, whatever else they have or have not done.
         */
        showWelcome: !ob.welcomedAt && byKey.profile.status !== 'done',
        showJourney: !ob.dismissedAt && stage !== 'complete',
        welcomedAt: ob.welcomedAt || null,
        steps,
        next: next ? { key: next.key, ...next.action } : null,
        progress: {
            done: steps.filter((s) => s.status === 'done').length,
            total: steps.length,
        },
        profileMore: byKey.profile.status === 'done' && !answeredLifestyle(user)
            ? { title: 'Complete your health profile', detail: 'Medications, conditions and habits', route: '/health-assessment/review' }
            : null,
        kits,
        visit,
        analysis: analysisFrom(analysis, kits),
        learned: {
            results: resultsCount,
            nights: learned.nights || 0,
            activities: learned.activities || 0,
            days: learned.days || 0,
        },
    };
};

module.exports = { deriveJourney, STEPS, ESSENTIALS };
