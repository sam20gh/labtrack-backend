const mongoose = require('mongoose');

/**
 * A technician who visits customers to collect samples and hand over bracelets.
 *
 * Like `Professional`, a directory record *linked* to a login rather than being one: the person
 * signs in through Supabase with the `technician` role and resolves to a `User`, and `userId`
 * joins the two. An administrator creates the profile with the technician's email before or
 * after inviting them; the first request they make links it (`utils/roster.resolveTechnician`),
 * the lesson `resolveProfessional` records about looking a profile up by the wrong id.
 *
 * One market each. Shifts are in **the market's own clock** — a Dubai technician's 08:00 is
 * Dubai's — so they line up with the slots customers book, which are in that clock too.
 */
const ShiftSchema = new mongoose.Schema({
    /** Local weekday, 0 = Sunday. */
    day: { type: Number, min: 0, max: 6, required: true },
    /** Minutes after local midnight; end may be 1440. */
    startMinute: { type: Number, min: 0, max: 1439, required: true },
    endMinute: { type: Number, min: 1, max: 1440, required: true },
}, { _id: false });

const TechnicianSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', unique: true, sparse: true },
    /** How a new profile finds its login: the email the invite went to. */
    email: { type: String, required: true, lowercase: true, trim: true, unique: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, trim: true },
    market: { type: String, required: true },
    /** Service areas they cover. Empty means every area in their market. */
    areas: { type: [String], default: [] },
    /** How many visits they can take in one slot. Almost always one: they have to travel. */
    visitsPerSlot: { type: Number, min: 1, max: 5, default: 1 },
    shifts: { type: [ShiftSchema], default: [] },
    /** Inclusive local dates, YYYY-MM-DD. */
    timeOff: {
        type: [{ from: { type: String, required: true }, to: { type: String, required: true }, note: { type: String } }],
        default: [],
    },
    active: { type: Boolean, default: true, index: true },
}, { timestamps: true });

TechnicianSchema.index({ market: 1, active: 1 });

module.exports = mongoose.model('Technician', TechnicianSchema);
