const mongoose = require('mongoose');
const { CODES, completeMarket } = require('../utils/markets');

/**
 * An administrator's settings for one market — how it is served, when technicians visit,
 * and what home collection costs. Only what was *changed* from `DEFAULT_MARKETS` matters;
 * `Market.resolve` merges a row over the defaults, and with no row the defaults apply and say
 * so (`source: 'default'`). See `utils/markets.js`.
 *
 * Edited in the portal under Markets. Changing hours or capacity never moves a visit already
 * booked: a booking is a promise made against the settings in force at the time, the rule
 * order prices and `MetricLog.category` already follow.
 */
const MarketSchema = new mongoose.Schema({
    code: { type: String, enum: CODES, required: true, unique: true },
    fulfilment: {
        post: { type: Boolean },
        homeCollection: { type: Boolean },
        default: { type: String, enum: ['post', 'home_collection'] },
    },
    /** Home-collection visit settings. Not `collection`, which Mongoose reserves. */
    visits: {
        /** In the market's currency. 0 is free. */
        price: { type: Number, min: 0 },
        /** Local weekdays visits run on, 0 = Sunday. */
        // Lists default to *absent*, not empty: an empty list stored by a partial save would
        // override the default and close the market every day of the week.
        days: { type: [{ type: Number, min: 0, max: 6 }], default: undefined },
        /** Minutes after local midnight. 0 and 1440 is around the clock. */
        openMinute: { type: Number },
        closeMinute: { type: Number },
        slotMinutes: { type: Number },
        capacityPerSlot: { type: Number },
        capacityMode: { type: String, enum: ['fixed', 'roster'] },
        leadHours: { type: Number },
        bookAheadDays: { type: Number },
        rescheduleCutoffHours: { type: Number },
        serviceAreas: { type: [String], default: undefined },
        /** Local dates with no visits, YYYY-MM-DD. */
        blackoutDates: { type: [String], default: undefined },
    },
    /** Which laboratory each kind of sample goes to, by lab code. */
    labs: {
        blood: { type: String },
        dna: { type: String },
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    history: {
        type: [{ at: { type: Date, default: Date.now }, by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, change: { type: Object } }],
        default: [],
    },
}, { timestamps: true });

/** The market in force for a code, complete — or null for a code we do not sell in. */
MarketSchema.statics.resolve = async function (code) {
    if (!CODES.includes(code)) return null;
    const row = await this.findOne({ code }).lean();
    return completeMarket(code, row);
};

MarketSchema.statics.resolveAll = async function () {
    const rows = await this.find({}).lean();
    const byCode = new Map(rows.map((r) => [r.code, r]));
    return CODES.map((code) => completeMarket(code, byCode.get(code)));
};

module.exports = mongoose.model('Market', MarketSchema);
