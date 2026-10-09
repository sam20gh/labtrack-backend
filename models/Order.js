const mongoose = require('mongoose');
const { KINDS, COMPONENT_STATUSES } = require('../utils/orderComponents');

/**
 * A home-collection order for tests or scans.
 *
 * Closes the loop the plan opens: a PlanItem recommends a test, the user orders it here,
 * and when the lab returns a result it is attached back to both the order and the plan
 * item. Line items snapshot name and price at purchase time — a later catalogue price
 * change must not rewrite what someone was charged.
 */
/**
 * One thing a line ships — a blood kit, a DNA kit, a bracelet — on its own timeline.
 *
 * A package used to be one `status` for three parcels. See `utils/orderComponents.js` for the
 * stages and why the order's own status is a roll-up of these.
 */
const ComponentSchema = new mongoose.Schema({
    kind: { type: String, enum: KINDS, required: true },
    /** How it reaches the lab — decides its stages. See `utils/orderComponents.stagesFor`. */
    method: { type: String, enum: ['post', 'home_collection'], default: 'post' },
    status: { type: String, enum: COMPONENT_STATUSES, default: 'placed' },
    statusHistory: [{
        status: { type: String },
        at: { type: Date, default: Date.now },
        note: { type: String },
    }],
    trackingReference: { type: String },
    /** What the lab returned for this kit. Exactly one of these, and only on `resulted`. */
    testResultId: { type: mongoose.Schema.Types.ObjectId, ref: 'TestResult' },
    dnaReportId: { type: mongoose.Schema.Types.ObjectId, ref: 'DnaReport' },
    genotypeFileId: { type: mongoose.Schema.Types.ObjectId, ref: 'GenotypeFile' },
}, { _id: true });

const OrderItemSchema = new mongoose.Schema({
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    name: { type: String, required: true },
    price: { type: Number, required: true },
    quantity: { type: Number, default: 1, min: 1 },
    /** The plan item this line fulfils, when ordered from the timeline. */
    planItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'PlanItem' },
    /** Snapshotted from `Product.includes` at purchase. Empty for a product that ships nothing tracked. */
    components: { type: [ComponentSchema], default: [] },
}, { _id: true });

const OrderSchema = new mongoose.Schema({
    /**
     * Null only on a website purchase nobody has claimed yet. The website sells a package
     * before the buyer has an account, so the order is held against `guestEmail` until an
     * account claims it — by signing in with that verified email, or by entering `claimCode`.
     * See `utils/claimOrders.js`.
     */
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        index: true,
        required: function () { return !this.guestEmail; },
    },

    /** Where it was bought. `web` orders start unclaimed. */
    source: { type: String, enum: ['app', 'web'], default: 'app' },
    /** The buyer's email on a website purchase, lowercased. Kept after claiming, for support. */
    guestEmail: { type: String, lowercase: true, trim: true },
    /**
     * Eight characters printed on the thank-you page and in the box. The fallback for a buyer
     * who signs up with a different email than they paid with, or bought for somebody else.
     */
    claimCode: { type: String, uppercase: true, trim: true },
    claimedAt: { type: Date },

    items: {
        type: [OrderItemSchema],
        validate: [(v) => Array.isArray(v) && v.length > 0, 'An order needs at least one item'],
    },

    currency: { type: String, default: 'GBP' },

    /**
     * How the order is fulfilled, in which market, and — for a technician visit — the visit
     * and its price. `fee` is in the order's currency and is already inside `total`.
     * Absent on every order placed before markets existed, which all went by post.
     */
    fulfilment: {
        method: { type: String, enum: ['post', 'home_collection'], default: 'post' },
        market: { type: String },
        fee: { type: Number, default: 0, min: 0 },
        visitId: { type: mongoose.Schema.Types.ObjectId, ref: 'CollectionVisit' },
    },
    subtotal: { type: Number, required: true, min: 0 },
    total: { type: Number, required: true, min: 0 },

    /**
     * Fulfilment lifecycle for a home-collection kit. `resulted` is terminal-happy:
     * the sample was processed and a TestResult exists.
     */
    status: {
        type: String,
        enum: ['pending_payment', 'placed', 'kit_sent', 'sample_received', 'processing', 'resulted', 'cancelled', 'refunded'],
        default: 'placed',
        index: true,
    },

    /** Payment is not wired yet (provider undecided) — kept nullable on purpose. */
    payment: {
        provider: { type: String },
        reference: { type: String },
        status: { type: String, enum: ['unpaid', 'paid', 'refunded', 'failed'], default: 'unpaid' },
        paidAt: { type: Date },
        /** A website purchase's Stripe Checkout Session — what the thank-you page looks up. */
        checkoutSessionId: { type: String },
    },

    shippingAddress: {
        line1: { type: String },
        line2: { type: String },
        city: { type: String },
        postcode: { type: String },
        country: { type: String },
    },

    trackingReference: { type: String },
    /** Every status change, so support can answer "where is my kit?". */
    statusHistory: [{
        status: { type: String },
        at: { type: Date, default: Date.now },
        note: { type: String },
    }],

    /** Result of this order, once the lab returns it. */
    testResultId: { type: mongoose.Schema.Types.ObjectId, ref: 'TestResult' },
    dnaReportId: { type: mongoose.Schema.Types.ObjectId, ref: 'DnaReport' },
}, { timestamps: true });

OrderSchema.index({ userId: 1, createdAt: -1 });
OrderSchema.index({ claimCode: 1 }, { unique: true, partialFilterExpression: { claimCode: { $type: 'string' } } });
OrderSchema.index({ guestEmail: 1 }, { partialFilterExpression: { guestEmail: { $type: 'string' } } });
OrderSchema.index({ 'payment.checkoutSessionId': 1 }, { sparse: true });

/** Record a transition and keep `status` and `statusHistory` in step. */
OrderSchema.methods.transitionTo = function (status, note) {
    this.status = status;
    this.statusHistory.push({ status, at: new Date(), note });
    return this;
};

module.exports = mongoose.model('Order', OrderSchema);
