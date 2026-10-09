/**
 * What an order actually ships, as a table.
 *
 * A package is three things on three timelines. The bracelet goes in the post the day it is
 * paid for and is on somebody's wrist within the week; the blood kit goes out, comes back and
 * results in about a week; the DNA kit goes out, comes back, and the laboratory takes about two
 * weeks more. One `Order.status` cannot say "bracelet delivered, blood kit at the lab, DNA still
 * processing" — and that sentence is the whole of what somebody waiting on a package wants to
 * know. So each line carries one **component** per thing it ships, each with its own status, and
 * the order's own status is a roll-up of them that the fulfilment queue sorts on.
 *
 * A product says what it ships through `Product.includes`. A product with none (every product
 * that predates this) gets no components, and its order moves on the order-level status exactly
 * as before — nothing about an existing order changes.
 *
 * Pure: no database, no clock it was not handed. `__tests__/onboarding.test.js` holds it.
 */

/** The things a product can ship. Order matters: it is the order a package lists them in. */
const KINDS = ['blood', 'dna', 'bracelet'];

/**
 * Each kind's stages, in order. Kits share the order-level vocabulary on purpose, so a
 * component status and an order status that mean the same thing are spelled the same way.
 * A bracelet has no laboratory: it is dispatched and then it is delivered, and whether it is
 * *paired* is a fact about the account (a `ConnectedSource`), never a stored status.
 */
const STAGES = {
    blood: ['placed', 'kit_sent', 'sample_received', 'processing', 'resulted'],
    dna: ['placed', 'kit_sent', 'sample_received', 'processing', 'resulted'],
    bracelet: ['placed', 'dispatched', 'delivered'],
};

/**
 * The same parcels when a technician visits instead (`Order.fulfilment.method:
 * 'home_collection'`). Nothing is posted: the kit is booked into a visit, the sample is
 * collected at the door and labelled with our barcode, and the bracelet is handed over in
 * person. From the laboratory onwards the stages are the same as by post, so everything
 * downstream — results, re-analysis, the tracker — reads them identically.
 *
 * `visit_booked` and `collected` are set by the visit (`utils/collectionCentre.js`), never by
 * the per-parcel admin endpoint: a kit marked collected without a barcode is a tube nobody
 * can find.
 */
const VISIT_STAGES = {
    blood: ['placed', 'visit_booked', 'collected', 'sample_received', 'processing', 'resulted'],
    dna: ['placed', 'visit_booked', 'collected', 'sample_received', 'processing', 'resulted'],
    bracelet: ['placed', 'visit_booked', 'delivered'],
};

/** Stages set only by a visit, never by hand. */
const VISIT_OWNED = ['visit_booked', 'collected'];

/** The stages one component goes through, by its kind and how its order is fulfilled. */
const stagesFor = (component) =>
    (component?.method === 'home_collection' ? VISIT_STAGES : STAGES)[component?.kind] || [];

/** The last stage of each kind — the one that means "nothing left to wait for". */
const DONE = { blood: 'resulted', dna: 'resulted', bracelet: 'delivered' };

/** Every status a component may hold, for the schema enum. */
const COMPONENT_STATUSES = [...new Set([...Object.values(STAGES), ...Object.values(VISIT_STAGES)].flat())];

/**
 * What a person is told about each kind, for the app's tracker and the portal's queue.
 * `wait` is the honest version of an ETA: nothing here knows a courier's or a laboratory's
 * timetable, so it states the usual wait rather than computing a date it cannot back.
 */
const KIND_META = {
    blood: {
        label: 'Blood test',
        wait: 'Results usually arrive within a week of the lab receiving your sample.',
    },
    dna: {
        label: 'DNA test',
        wait: 'The lab usually takes about two weeks once it has your sample.',
    },
    bracelet: {
        label: 'Health bracelet',
        wait: 'Usually with you within 3 to 5 working days.',
    },
};

const STAGE_LABEL = {
    placed: 'Ordered',
    kit_sent: 'Kit on its way',
    sample_received: 'Sample at the lab',
    processing: 'Being analysed',
    resulted: 'Results ready',
    dispatched: 'On its way',
    delivered: 'Delivered',
    visit_booked: 'Visit booked',
    collected: 'Collected',
};

/** Where a visit changes what a stage is called: a bracelet is handed over, not delivered. */
const labelFor = (component, status = component?.status) =>
    (component?.method === 'home_collection' && status === 'delivered' ? 'Handed over' : STAGE_LABEL[status] || status);

/** Keep only kinds this table knows, once each, in table order. */
const normaliseIncludes = (values) => {
    const list = Array.isArray(values) ? values : [];
    return KINDS.filter((k) => list.includes(k));
};

/** The components a newly ordered product starts with. */
const componentsFor = (product, at = new Date(), method = 'post') =>
    normaliseIncludes(product?.includes).map((kind) => ({
        kind,
        method,
        status: 'placed',
        statusHistory: [{ status: 'placed', at }],
    }));

/** Forward one stage at a time, like the order-level table. Nothing moves backwards. */
const nextStage = (component) => {
    const stages = stagesFor(component);
    const i = stages.indexOf(component?.status);
    return i >= 0 && i < stages.length - 1 ? stages[i + 1] : null;
};

const isDone = (component) => component?.status === DONE[component?.kind];

/** 0..1 through a component's own stages, for a progress bar. */
const progressOf = (component) => {
    const stages = stagesFor(component);
    if (!stages.length) return 0;
    const i = stages.indexOf(component.status);
    return i < 0 ? 0 : i / (stages.length - 1);
};

/**
 * The order-level status implied by its components.
 *
 * The order reads as its **least advanced** component, because the fulfilment queue's question
 * is "is there anything on this order still to do", and an order whose DNA kit is still at the
 * lab is not finished however long ago the bracelet arrived. A bracelet maps onto the order
 * vocabulary as dispatched → `kit_sent`, delivered → `resulted`.
 *
 * Returns null when there are no components, so the caller leaves the status alone.
 */
const ORDER_RANK = ['placed', 'kit_sent', 'sample_received', 'processing', 'resulted'];
// A booked visit has not shipped anything yet; a collected sample is on its way to the lab,
// which is what `kit_sent` means to the fulfilment queue.
const AS_ORDER = {
    placed: 'placed', dispatched: 'kit_sent', delivered: 'resulted',
    visit_booked: 'placed', collected: 'kit_sent',
};

const rollupStatus = (components) => {
    if (!Array.isArray(components) || !components.length) return null;
    let lowest = ORDER_RANK.length - 1;
    for (const c of components) {
        const mapped = AS_ORDER[c.status] ?? c.status;
        const rank = ORDER_RANK.indexOf(mapped);
        if (rank >= 0 && rank < lowest) lowest = rank;
    }
    return ORDER_RANK[lowest];
};

module.exports = {
    KINDS,
    STAGES,
    VISIT_STAGES,
    VISIT_OWNED,
    stagesFor,
    labelFor,
    DONE,
    COMPONENT_STATUSES,
    KIND_META,
    STAGE_LABEL,
    normaliseIncludes,
    componentsFor,
    nextStage,
    isDone,
    progressOf,
    rollupStatus,
};
