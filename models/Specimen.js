const mongoose = require('mongoose');

/**
 * One sample in a labelled tube — the chain of custody from a person's arm to a result.
 *
 * Identified by **our own pre-printed barcode**, applied at the door. The barcode is the only
 * thing that ties a tube to a person once it leaves the visit, so it carries no personal data
 * (a label can be read by anybody who handles the bag) and it is unique for ever: a reused
 * barcode is two people's blood under one name.
 *
 * Every hop is an event — collected, received at the laboratory, rejected, resulted — and each
 * one moves the order component this specimen fulfils. Scans drive the tracking rather than
 * somebody remembering to click. The laboratory's own id (`accession`) and the result it
 * produced are filled in by the lab integration; see docs/LAB-INTEGRATION.md.
 */
const SpecimenSchema = new mongoose.Schema({
    barcode: { type: String, required: true, unique: true, uppercase: true, trim: true },
    kind: { type: String, enum: ['blood', 'dna'], required: true },

    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
    itemId: { type: mongoose.Schema.Types.ObjectId, required: true },
    componentId: { type: mongoose.Schema.Types.ObjectId, required: true },
    visitId: { type: mongoose.Schema.Types.ObjectId, ref: 'CollectionVisit' },

    /** Which laboratory it is destined for, by code (Market.labs). */
    lab: { type: String },
    /** The laboratory's own identifier for it, once they have registered it. */
    accession: { type: String },

    status: { type: String, enum: ['collected', 'received', 'rejected', 'resulted'], default: 'collected', index: true },
    events: [{
        type: { type: String, enum: ['collected', 'received', 'rejected', 'resulted'] },
        at: { type: Date, default: Date.now },
        by: { type: String },
        note: { type: String },
    }],

    testResultId: { type: mongoose.Schema.Types.ObjectId, ref: 'TestResult' },
    dnaReportId: { type: mongoose.Schema.Types.ObjectId, ref: 'DnaReport' },
}, { timestamps: true });

module.exports = mongoose.model('Specimen', SpecimenSchema);
