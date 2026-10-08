const mongoose = require('mongoose');
const { OTHER_CODES, DEFAULT_RATES, completeRates } = require('../utils/currency');

/**
 * The rates a GBP price is converted at, for every product that has no price of its own in
 * that currency. One row (`key: 'current'`), edited in the portal under Products.
 *
 * **Set by a person, never fetched.** A live FX feed would move every converted price a
 * little every day, so a basket priced at breakfast would charge something else at lunch,
 * and nothing would say why. A stored rate moves when somebody decides it should, and
 * `history` says who and when.
 *
 * Orders snapshot their line prices, so changing a rate never re-prices an order already
 * placed — the rule `Order.items[].price` already follows for catalogue edits.
 */
const rateFields = Object.fromEntries(OTHER_CODES.map((code) => [code, { type: Number, min: 0 }]));

const ExchangeRatesSchema = new mongoose.Schema({
    key: { type: String, default: 'current', unique: true },
    /** Units of each currency per 1 GBP. */
    rates: rateFields,
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    /** Every change, newest last, capped. Who moved a price is a question support gets. */
    history: {
        type: [{
            rates: rateFields,
            at: { type: Date, default: Date.now },
            by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        }],
        default: [],
    },
}, { timestamps: true });

/**
 * The rates in force, complete. With no row yet, the placeholders — and `source: 'default'`
 * so a screen can say they were never chosen.
 */
ExchangeRatesSchema.statics.current = async function () {
    const row = await this.findOne({ key: 'current' }).lean();
    if (!row) return { rates: { ...DEFAULT_RATES }, source: 'default', updatedAt: null };
    return { rates: completeRates(row.rates), source: 'set', updatedAt: row.updatedAt || null };
};

module.exports = mongoose.model('ExchangeRates', ExchangeRatesSchema);
