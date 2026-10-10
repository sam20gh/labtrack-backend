const mongoose = require('mongoose');

/**
 * One bag of tubes handed to a laboratory (or its courier): which tubes, from whom, when.
 *
 * A technician scans every tube going into the bag, and the bag gets a code. The laboratory —
 * or, until its API exists, an administrator at the bench — receives the bag by that code, and
 * every tube in it moves to "at the lab" at once. A tube on the manifest that is not received is
 * then a named, findable gap rather than a vague "some samples went missing on Tuesday".
 *
 * One laboratory per bag: blood to one lab and DNA to another travel separately.
 */
const SampleManifestSchema = new mongoose.Schema({
    code: { type: String, required: true, unique: true },
    technicianId: { type: mongoose.Schema.Types.ObjectId, ref: 'Technician', required: true, index: true },
    market: { type: String, required: true },
    lab: { type: String, required: true },
    specimenIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Specimen' }],
    barcodes: [{ type: String }],
    handedOverAt: { type: Date, required: true },
    receivedAt: { type: Date },
    receivedBy: { type: String },
    /** Tubes on the manifest that the receiving end did not find in the bag. */
    missing: [{ type: String }],
}, { timestamps: true });

module.exports = mongoose.model('SampleManifest', SampleManifestSchema);
