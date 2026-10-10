const mongoose = require('mongoose');

/**
 * The answer to every technician action that carried an `Idempotency-Key`, kept for a week.
 *
 * The technician app queues what it does while offline — a basement, a lift, a car park — and
 * sends the queue when signal returns. A request whose response was lost is sent again, and
 * "record this visit" must not be applied twice. So the first answer is stored against the
 * key and a repeat gets that answer back, untouched, without the action running again.
 */
const TechnicianActionSchema = new mongoose.Schema({
    technicianId: { type: mongoose.Schema.Types.ObjectId, ref: 'Technician', required: true },
    key: { type: String, required: true },
    route: { type: String },
    status: { type: Number, required: true },
    body: { type: Object },
    createdAt: { type: Date, default: Date.now, expires: 7 * 24 * 3600 },
});

TechnicianActionSchema.index({ technicianId: 1, key: 1 }, { unique: true });

module.exports = mongoose.model('TechnicianAction', TechnicianActionSchema);
