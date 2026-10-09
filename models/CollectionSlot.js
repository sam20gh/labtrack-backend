const mongoose = require('mongoose');

/**
 * How many visits hold one slot in one market — the counter that makes overbooking
 * impossible.
 *
 * A slot is taken with one conditional increment (`utils/collectionCentre.reserve`): match the
 * row only while `count` is under capacity and add one. When the slot is full the filter
 * matches nothing, the upsert tries to insert a second row for the same `{ market, start }`,
 * and the unique index refuses it. So two people tapping the last place at the same moment
 * get one booking and one "just taken" — with no transaction and no lock, on any number of
 * server instances.
 */
const CollectionSlotSchema = new mongoose.Schema({
    market: { type: String, required: true },
    start: { type: Date, required: true },
    count: { type: Number, default: 0, min: 0 },
}, { timestamps: true });

CollectionSlotSchema.index({ market: 1, start: 1 }, { unique: true });

module.exports = mongoose.model('CollectionSlot', CollectionSlotSchema);
