const mongoose = require('mongoose');

/**
 * What counts as "normal" for a biomarker, given who the patient is.
 *
 * Reference ranges are not universal: ferritin differs by sex, creatinine by age and sex,
 * ALP by growth stage. Flagging a value against a single global range produces false alarms
 * for half the population, so ranges are selected by sex and age band.
 *
 * `geneModifiers` narrows a range for people carrying a specific variant — an HFE carrier's
 * "acceptable" ferritin ceiling is lower than the population's, and that is precisely the
 * kind of personalisation the DNA report exists to drive.
 */
const GeneModifierSchema = new mongoose.Schema({
    gene: { type: String, required: true },
    /** Optional: restrict to a specific variant. Empty means any variant in the gene. */
    variant: { type: String },
    /** Replacement bounds when the user carries this variant. */
    min: { type: Number },
    max: { type: Number },
    /** Surfaced to the user to explain why their range differs. */
    rationale: { type: String },
}, { _id: true });

const ReferenceRangeSchema = new mongoose.Schema({
    /** Canonical biomarker key — must match Biomarker.name exactly. */
    biomarker: { type: String, required: true, lowercase: true, trim: true, index: true },
    displayName: { type: String },
    unit: { type: String, required: true },

    /** 'any' matches every patient; a sex-specific row is preferred when one exists. */
    sex: { type: String, enum: ['male', 'female', 'any'], default: 'any' },

    /** Inclusive lower bound, exclusive upper bound, in years. */
    ageMin: { type: Number, default: 0 },
    ageMax: { type: Number, default: 200 },

    /** Normal band. Either bound may be absent for one-sided analytes (e.g. LDL). */
    min: { type: Number },
    max: { type: Number },

    /** Outside these, the result warrants urgent attention rather than a trend note. */
    criticalMin: { type: Number },
    criticalMax: { type: Number },

    geneModifiers: [GeneModifierSchema],

    /** Provenance matters clinically — ranges differ between authorities. */
    source: { type: String },
    notes: { type: String },
    isActive: { type: Boolean, default: true },
}, { timestamps: true });

// Range selection: biomarker + sex + age band, active rows only
ReferenceRangeSchema.index({ biomarker: 1, sex: 1, ageMin: 1, ageMax: 1, isActive: 1 });

/**
 * Best matching range for a patient, or null.
 * A sex-specific row beats 'any'; among equals the narrowest age band wins, since a
 * paediatric band should never lose to a 0-200 catch-all.
 */
ReferenceRangeSchema.statics.findForPatient = async function ({ biomarker, sex, age }) {
    const query = {
        biomarker: String(biomarker).toLowerCase(),
        isActive: true,
    };

    if (typeof age === 'number' && !Number.isNaN(age)) {
        query.ageMin = { $lte: age };
        query.ageMax = { $gte: age };
    }

    const normalisedSex = ['male', 'female'].includes(String(sex).toLowerCase())
        ? String(sex).toLowerCase()
        : null;
    query.sex = normalisedSex ? { $in: [normalisedSex, 'any'] } : 'any';

    const candidates = await this.find(query);
    if (!candidates.length) return null;

    return candidates.sort((a, b) => {
        // Prefer the sex-specific row
        const aSpecific = a.sex !== 'any' ? 0 : 1;
        const bSpecific = b.sex !== 'any' ? 0 : 1;
        if (aSpecific !== bSpecific) return aSpecific - bSpecific;
        // Then the tighter age band
        return (a.ageMax - a.ageMin) - (b.ageMax - b.ageMin);
    })[0];
};

module.exports = mongoose.model('ReferenceRange', ReferenceRangeSchema);
