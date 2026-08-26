const mongoose = require('mongoose');

/**
 * A raw genotyping result and the panel extracted from it.
 *
 * Distinct from `DnaReport` on purpose. `DnaReport` models a curated clinical report — a
 * bounded list of mutations a human classified, each with a gene, an HGVS variant and an
 * ACMG significance. A genotyping array is the opposite shape: ~600k anonymous position
 * calls, no gene assignment, no significance, no curation. They are different kinds of
 * evidence, not the same evidence at different resolutions, and forcing one into the other
 * loses the distinction that keeps the product honest. `DnaReport` stays as it is and will
 * carry the targeted-sequencing upgrade when that lands.
 *
 * The raw file is NOT stored here. 609k calls exceed the 16 MB BSON ceiling on their own,
 * and almost none of them mean anything. `sourceFile.url` points at object storage; what
 * lives in Mongo is the bounded panel extraction, which is what the app actually reads.
 *
 * `findings` is embedded rather than a separate collection because it is small (tens of
 * rows, low hundreds at full panel size), always read together with the parent, and written
 * once atomically. That also matches how `DnaReport.mutations[]` already works.
 */

const FindingSchema = new mongoose.Schema({
    rsid: { type: String, required: true },
    gene: { type: String, uppercase: true, trim: true },
    /** e.g. 'C282Y', 'CYP2C19*17' — the lab/allele name where one exists. */
    alleleName: { type: String },
    name: { type: String, required: true },

    category: {
        type: String,
        enum: ['medication', 'nutrition', 'carrier', 'trait', 'risk'],
        required: true,
    },

    /**
     * Who may see this, and when. The safety mechanism of the whole model:
     *  - release   — shown as soon as it is extracted
     *  - clinician — withheld until an interpretation is signed off
     *  - opt_in    — hidden entirely until the user asks, with counselling copy
     *  - suppressed— stored for completeness, never displayed (see MTHFR / D4)
     */
    tier: {
        type: String,
        enum: ['release', 'clinician', 'opt_in', 'suppressed'],
        required: true,
        index: true,
    },

    /**
     * `not_covered` is a first-class outcome, not an error. A variant the chip does not
     * carry must never render as a negative result — collapsing "we looked and found
     * nothing" into "we never looked" is the most common way a genetics report misleads.
     */
    status: {
        type: String,
        enum: ['called', 'not_covered', 'no_call', 'rejected_indel', 'unmatched', 'ambiguous'],
        required: true,
        index: true,
    },

    /** Alleles sorted alphabetically (AG, never GA), or a diplotype like 'ε3/ε4'. */
    genotype: { type: String },

    tone: { type: String, enum: ['typical', 'reduced', 'increased', 'carrier', 'attention'] },
    label: { type: String },
    detail: { type: String },
    evidence: { type: String },
    counselling: { type: String },

    /** Canonical biomarker name this finding adjusts, linking the card to its trend screen. */
    affectsBiomarker: { type: String },

    /** Set when the panel can only give a partial answer, e.g. a missing star allele. */
    incomplete: { type: String },
    suppressionReason: { type: String },

    /** True when the call matched only after reverse-complementing — vendor strand differs. */
    strandFlipped: { type: Boolean, default: false },
    /** A/T and C/G sites read identically on both strands, so orientation is unverifiable. */
    strandAmbiguous: { type: Boolean, default: false },

    /** For derived results (APOE), the calls it was resolved from. */
    derivedFrom: { type: Object },
}, { _id: false });

/** A coverage gap stated explicitly on the report, snapshotted at extraction time. */
const NotTestedSchema = new mongoose.Schema({
    key: { type: String, required: true },
    title: { type: String, required: true },
    genes: [{ type: String }],
    detail: { type: String, required: true },
    /** Product slug this gap can be closed by, where one exists. */
    upgrade: { type: String },
}, { _id: false });

const GenotypeFileSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** Set when the sample arrived through a LabTrack order rather than a seed or import. */
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },

    labName: { type: String },
    /**
     * What instrument produced this. An array cannot answer the questions a targeted panel
     * can, and the interpretation has to know which it is looking at.
     */
    assayType: {
        type: String,
        enum: ['array', 'targeted_panel', 'exome', 'genome'],
        default: 'array',
        required: true,
    },

    vendor: { type: String },
    chip: { type: String },
    /**
     * Which probe manifest produced this sample. Without it we cannot say honestly what the
     * test did and did not examine — and when the lab revises the chip, every historical
     * report's coverage caveats become wrong unless the version is pinned per sample.
     */
    chipManifestVersion: { type: String },
    referenceBuild: { type: String },

    sourceFile: {
        url: { type: String },
        originalName: { type: String },
        sizeBytes: { type: Number },
        checksum: { type: String },
    },

    qc: {
        totalCalls: { type: Number },
        noCalls: { type: Number },
        callRate: { type: Number },
        indelCalls: { type: Number },
        inferredSex: { type: String, enum: ['male', 'female', 'undetermined'] },
        xHeterozygosity: { type: Number },
        yCalls: { type: Number },
        hasMitochondrial: { type: Boolean, default: false },
    },

    /** Panel version the findings were produced by, so a stale extraction can be re-run. */
    panelVersion: { type: String, required: true },
    findings: [FindingSchema],
    notTested: [NotTestedSchema],

    /**
     * Risk-bearing results stay hidden until the user explicitly asks for them. This is the
     * enforcement point for APOE and anything else unactionable and distressing — the
     * controller filters on it, so an opt_in finding cannot reach a response by accident.
     */
    consent: {
        riskResultsOptIn: { type: Boolean, default: false },
        optedInAt: { type: Date },
    },

    status: {
        type: String,
        enum: ['received', 'extracting', 'extracted', 'failed'],
        default: 'received',
        index: true,
    },
    failureReason: { type: String },

    collectedAt: { type: Date },
    reportedAt: { type: Date },
}, { timestamps: true });

GenotypeFileSchema.index({ userId: 1, createdAt: -1 });

/** Did this sample pass the quality floor we would accept from a lab? */
GenotypeFileSchema.virtual('passedQc').get(function () {
    return typeof this.qc?.callRate === 'number' && this.qc.callRate >= 0.98;
});

GenotypeFileSchema.set('toJSON', { virtuals: true });
GenotypeFileSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('GenotypeFile', GenotypeFileSchema);
