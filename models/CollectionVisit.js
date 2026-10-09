const mongoose = require('mongoose');

/**
 * A technician's visit to collect samples — and hand over a bracelet — at a booked time.
 *
 * Not an `Appointment`. That model is a consultation with a clinician, read by the diary, the
 * portal's clinician screens and the reminder sweep; a visit has an address, items to collect,
 * barcodes and (soon) a technician and a route. Folding one into the other would make every
 * reader of either filter out the other.
 *
 * The lifecycle:
 *
 *   held            a slot is reserved for 15 minutes while the customer pays
 *   booked          paid, and the slot is theirs
 *   needs_rebooking the hold lapsed and the slot filled before the payment landed, or a
 *                   visit was missed — the customer is asked to choose again
 *   assigned        a technician has it (phase 3b: a Technician; today a name the portal typed)
 *   en_route / arrived   the technician app's states (phase 4)
 *   completed       every task was done or explicitly not done
 *   missed          nobody was in
 *   cancelled       the customer or an administrator cancelled it
 *   expired         a hold that was never paid for; its place went back to the slot
 *
 * `tasks` are one per thing to do at the door, pointing at the order component it fulfils, so
 * completing a task moves exactly that parcel on (`utils/collectionCentre.completeVisit`).
 */
const STATUSES = ['held', 'booked', 'needs_rebooking', 'assigned', 'en_route', 'arrived', 'completed', 'missed', 'cancelled', 'expired'];
/** States in which the visit holds a place in its slot. */
const HOLDING = ['held', 'booked', 'assigned', 'en_route', 'arrived'];

const TaskSchema = new mongoose.Schema({
    kind: { type: String, enum: ['collect_blood', 'collect_dna', 'handover_bracelet'], required: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
    itemId: { type: mongoose.Schema.Types.ObjectId, required: true },
    componentId: { type: mongoose.Schema.Types.ObjectId, required: true },
    status: { type: String, enum: ['pending', 'done', 'not_done'], default: 'pending' },
    /** The label on the tube or the bracelet box — our own pre-printed barcode. */
    barcode: { type: String, uppercase: true, trim: true },
    note: { type: String },
    at: { type: Date },
}, { _id: true });

const CollectionVisitSchema = new mongoose.Schema({
    /** Null on a website order nobody has claimed in the app yet; set when it is claimed. */
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    orderIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Order' }],
    market: { type: String, required: true },
    /** The market's timezone at booking, so labels never depend on today's settings. */
    timezone: { type: String, required: true },

    slot: {
        start: { type: Date, required: true },
        end: { type: Date, required: true },
    },
    status: { type: String, enum: STATUSES, default: 'held', index: true },
    holdExpiresAt: { type: Date },

    /**
     * Where to go. Shaped for the UAE, where a postcode does not exist and a building name,
     * an area and a landmark are how a door is actually found. `makani` is Dubai's
     * ten-digit building number, which pins an entrance exactly. `lat`/`lng` are optional
     * today and what route planning (phase 4) will need.
     */
    address: {
        building: { type: String, required: true },
        street: { type: String },
        area: { type: String, required: true },
        city: { type: String, required: true },
        landmark: { type: String },
        makani: { type: String },
        country: { type: String },
        lat: { type: Number },
        lng: { type: Number },
    },
    contactName: { type: String },
    phone: { type: String, required: true },
    accessNotes: { type: String },

    /** The technician doing the visit. */
    technicianId: { type: mongoose.Schema.Types.ObjectId, ref: 'Technician', index: true },
    /** Phase 3a's typed name. Kept for visits assigned before technicians existed; read-only. */
    assignee: { name: { type: String }, phone: { type: String } },

    /**
     * The visit pass. Shown to the customer as a QR code and as these characters; the
     * technician scans or types it at the door, which proves they are at the right door with
     * the right person before a single tube is labelled. Six characters from the claim-code
     * alphabet (no 0/O, 1/I/L): read aloud over a doorstep, it has to survive.
     */
    passCode: { type: String },
    /**
     * How identity was checked before anything was collected: the pass was scanned, or the
     * technician confirmed name and date of birth by hand (a customer with a flat battery).
     * A visit cannot be recorded without one or the other.
     */
    identity: {
        method: { type: String, enum: ['pass', 'manual'] },
        at: { type: Date },
        by: { type: String },
    },

    tasks: { type: [TaskSchema], default: [] },
    /** Blood panels that need fasting — read from the products, said in every reminder. */
    requiresFasting: { type: Boolean, default: false },

    remindedAt: { type: Date },
    cancelledBy: { type: String, enum: ['customer', 'admin', 'system'] },
    statusHistory: [{
        status: { type: String },
        at: { type: Date, default: Date.now },
        note: { type: String },
        by: { type: String },
    }],
}, { timestamps: true });

CollectionVisitSchema.index({ market: 1, 'slot.start': 1 });
CollectionVisitSchema.index({ status: 1, holdExpiresAt: 1 });
CollectionVisitSchema.index({ orderIds: 1 });

CollectionVisitSchema.methods.transitionTo = function (status, note, by) {
    this.status = status;
    this.statusHistory.push({ status, at: new Date(), note, by });
    return this;
};

CollectionVisitSchema.statics.STATUSES = STATUSES;
CollectionVisitSchema.statics.HOLDING = HOLDING;

module.exports = mongoose.model('CollectionVisit', CollectionVisitSchema);
