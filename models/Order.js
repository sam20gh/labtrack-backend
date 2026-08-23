const mongoose = require('mongoose');

/**
 * A home-collection order for tests or scans.
 *
 * Closes the loop the plan opens: a PlanItem recommends a test, the user orders it here,
 * and when the lab returns a result it is attached back to both the order and the plan
 * item. Line items snapshot name and price at purchase time — a later catalogue price
 * change must not rewrite what someone was charged.
 */
const OrderItemSchema = new mongoose.Schema({
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    name: { type: String, required: true },
    price: { type: Number, required: true },
    quantity: { type: Number, default: 1, min: 1 },
    /** The plan item this line fulfils, when ordered from the timeline. */
    planItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'PlanItem' },
}, { _id: true });

const OrderSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    items: {
        type: [OrderItemSchema],
        validate: [(v) => Array.isArray(v) && v.length > 0, 'An order needs at least one item'],
    },

    currency: { type: String, default: 'GBP' },
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

/** Record a transition and keep `status` and `statusHistory` in step. */
OrderSchema.methods.transitionTo = function (status, note) {
    this.status = status;
    this.statusHistory.push({ status, at: new Date(), note });
    return this;
};

module.exports = mongoose.model('Order', OrderSchema);
