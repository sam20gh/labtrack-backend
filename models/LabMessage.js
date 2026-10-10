const mongoose = require('mongoose');

/**
 * Every message a laboratory has sent, by its own id — so a retry is answered with the first
 * answer and never applied twice, and support can see what arrived and what we said back.
 *
 * Holds identifiers and outcomes, never the result content: the result itself lives in
 * `TestResult` / `DnaReport`, and a second copy here would be health data with nothing asking
 * for it — the rule `AccessLog` follows.
 */
const LabMessageSchema = new mongoose.Schema({
    lab: { type: String, required: true },
    messageId: { type: String, required: true },
    kind: { type: String, enum: ['event', 'result'], required: true },
    barcode: { type: String },
    status: { type: Number, required: true },
    response: { type: Object },
    receivedAt: { type: Date, default: Date.now },
});

LabMessageSchema.index({ lab: 1, messageId: 1 }, { unique: true });

module.exports = mongoose.model('LabMessage', LabMessageSchema);
