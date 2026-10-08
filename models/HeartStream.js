/**
 * A bracelet's continuous heart rate, kept per record so the band can be freed after a sync.
 *
 * The J-Style bands write continuous heart rate as fixed 24-byte records: a start time and
 * fifteen readings. Until 2026-10-08 the phone reduced a read to one spread per day and the
 * server `$set` it, which meant the series could never be deleted from the band — a delete
 * mid-day would leave only the afternoon to be posted next time, and that would overwrite
 * the morning. So every sync replayed weeks of it: ~860 packets, ~10 seconds.
 *
 * Here each record is one entry in `blocks`, keyed by its start instant in ms, holding
 * `[count, sum, min, max]` of its non-zero readings. One document per person per local day
 * rather than a row per record: a day is ~1,000 records, and a row each would be 365k rows a
 * year per person for a figure only ever read as a day. Re-sending a record `$set`s the same
 * key, so it is idempotent, and the day's spread is rebuilt from every key it holds — so a
 * day posted in pieces across syncs adds up to the whole day.
 */
const mongoose = require('mongoose');

const HeartStreamSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    /** Local calendar day of the records' start, as the phone resolved it. */
    day: { type: String, required: true },
    /** `{ [startMs]: [count, sum, min, max] }`. Mixed, so a key can be `$set` on its own. */
    blocks: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true, minimize: false });

HeartStreamSchema.index({ userId: 1, day: 1 }, { unique: true });

module.exports = mongoose.model('HeartStream', HeartStreamSchema);
