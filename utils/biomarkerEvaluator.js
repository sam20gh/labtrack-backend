/**
 * Turns a raw measurement into a flagged, personalised result.
 *
 * "Is 14.2 a good ferritin?" has no answer without knowing who the patient is. This module
 * selects the reference range for their sex and age, narrows it if their DNA report carries
 * a relevant variant, and records which range was used so the verdict stays explainable
 * years later.
 */
const ReferenceRange = require('../models/ReferenceRange');
const DnaReport = require('../models/DnaReport');

/** Whole years between a date of birth and a reference date. */
const calculateAge = (dob, at = new Date()) => {
    if (!dob) return null;
    const birth = new Date(dob);
    if (Number.isNaN(birth.getTime())) return null;

    let age = at.getFullYear() - birth.getFullYear();
    const beforeBirthday =
        at.getMonth() < birth.getMonth() ||
        (at.getMonth() === birth.getMonth() && at.getDate() < birth.getDate());
    return beforeBirthday ? age - 1 : age;
};

/**
 * Genes with a pathogenic or likely-pathogenic variant in the user's reports.
 *
 * Two filters, for different reasons:
 *   - Significance: variants of uncertain significance are excluded, because narrowing
 *     someone's "normal" band on a VUS acts on evidence that does not support it.
 *   - Report status: `parsing` and `failed` reports are excluded because their mutation
 *     list is incomplete or unreliable. `uploaded` IS included — mutations are lab
 *     findings, not model output, so they are trustworthy before interpretation runs.
 *     (Gating on `ai_interpreted` instead would silently disable gene personalisation
 *     for every report until the Phase 4 pipeline exists.)
 */
const actionableGenes = async (userId) => {
    const reports = await DnaReport.find({
        userId,
        status: { $nin: ['parsing', 'failed'] },
    }).select('mutations').lean();

    const genes = new Map();
    for (const report of reports) {
        for (const mutation of report.mutations || []) {
            if (['pathogenic', 'likely_pathogenic'].includes(mutation.significance)) {
                genes.set(mutation.gene, mutation.variant || null);
            }
        }
    }
    return genes;
};

/**
 * Apply any matching gene modifier to a base range.
 * A modifier without a `variant` applies to any variant in that gene.
 */
const applyGeneModifiers = (range, genes) => {
    if (!range?.geneModifiers?.length || !genes.size) {
        return { min: range?.min, max: range?.max, geneAdjusted: false, rationale: null };
    }

    for (const modifier of range.geneModifiers) {
        if (!genes.has(modifier.gene)) continue;
        const userVariant = genes.get(modifier.gene);
        if (modifier.variant && userVariant && modifier.variant !== userVariant) continue;

        return {
            min: modifier.min ?? range.min,
            max: modifier.max ?? range.max,
            geneAdjusted: true,
            rationale: modifier.rationale || `Adjusted for ${modifier.gene} variant`,
        };
    }

    return { min: range.min, max: range.max, geneAdjusted: false, rationale: null };
};

/** Classify a value against normal and critical bounds. */
const classify = (value, { min, max, criticalMin, criticalMax }) => {
    if (typeof criticalMin === 'number' && value < criticalMin) return 'critical_low';
    if (typeof criticalMax === 'number' && value > criticalMax) return 'critical_high';
    if (typeof min === 'number' && value < min) return 'low';
    if (typeof max === 'number' && value > max) return 'high';
    // A one-sided analyte with the present bound satisfied is normal
    if (typeof min === 'number' || typeof max === 'number') return 'normal';
    return 'unknown';
};

/**
 * Evaluate one measurement.
 *
 * @returns {Promise<{flag: string, appliedRange: object|null, rationale: string|null}>}
 *   `flag` is 'unknown' when no range matches — the value is still stored and trended,
 *   because an unflaggable measurement is still a data point.
 */
const evaluate = async ({ userId, name, value, user, measuredAt = new Date() }) => {
    const age = calculateAge(user?.dob, measuredAt);
    const sex = user?.gender ? String(user.gender).toLowerCase() : null;

    const range = await ReferenceRange.findForPatient({ biomarker: name, sex, age });
    if (!range) {
        return { flag: 'unknown', appliedRange: null, rationale: null };
    }

    const genes = await actionableGenes(userId);
    const { min, max, geneAdjusted, rationale } = applyGeneModifiers(range, genes);

    const flag = classify(value, {
        min,
        max,
        criticalMin: range.criticalMin,
        criticalMax: range.criticalMax,
    });

    return {
        flag,
        appliedRange: {
            min,
            max,
            unit: range.unit,
            referenceRangeId: range._id,
            geneAdjusted,
        },
        rationale,
    };
};

module.exports = { evaluate, calculateAge, classify, applyGeneModifiers, actionableGenes };
