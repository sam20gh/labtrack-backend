/**
 * Canonical biomarker names and units.
 *
 * This module exists because getting it wrong is dangerous, not merely untidy. Labs report
 * the same analyte under different names and different units:
 *
 *   - Glucose is printed as 5.0 mmol/L or 90 mg/dL — an 18× difference. Flagging 90 mg/dL
 *     against a mmol/L range (3.9–5.5) would report `critical_high` for a perfectly normal
 *     fasting glucose.
 *   - HbA1c comes as 42 mmol/mol (IFCC) or 6.0 % (DCCT/NGSP) — different scales entirely.
 *   - Ferritin as ng/mL or µg/L — numerically identical, but only if you know that.
 *
 * Every value is converted to the canonical unit for its analyte before it is compared to a
 * reference range. A value whose unit cannot be recognised is NOT silently assumed to be
 * canonical: it is returned unconverted and marked, so the caller can route it to human
 * confirmation rather than flag it against the wrong scale.
 */

/**
 * Canonical definition per analyte.
 * `aliases` are matched after lowercasing and stripping non-alphanumerics, so
 * "Serum Ferritin", "serum-ferritin", and "SERUM FERRITIN" all collapse to the same key.
 */
const BIOMARKERS = {
    ferritin: {
        displayName: 'Ferritin',
        unit: 'ng/mL',
        aliases: ['ferritin', 'serumferritin', 'sferritin'],
        units: { 'ng/ml': 1, 'µg/l': 1, 'ug/l': 1, 'mcg/l': 1, 'ngml': 1 },
    },
    haemoglobin: {
        displayName: 'Haemoglobin',
        unit: 'g/dL',
        aliases: ['haemoglobin', 'hemoglobin', 'hb', 'hgb'],
        units: { 'g/dl': 1, 'gdl': 1, 'g/l': 0.1, 'mmol/l': 1.611 },
    },
    total_cholesterol: {
        displayName: 'Total Cholesterol',
        unit: 'mmol/L',
        aliases: ['totalcholesterol', 'cholesterol', 'cholesteroltotal', 'tc'],
        units: { 'mmol/l': 1, 'mg/dl': 0.02586 },
    },
    ldl_cholesterol: {
        displayName: 'LDL Cholesterol',
        unit: 'mmol/L',
        aliases: ['ldlcholesterol', 'ldl', 'ldlc', 'lowdensitylipoprotein'],
        units: { 'mmol/l': 1, 'mg/dl': 0.02586 },
    },
    hdl_cholesterol: {
        displayName: 'HDL Cholesterol',
        unit: 'mmol/L',
        aliases: ['hdlcholesterol', 'hdl', 'hdlc', 'highdensitylipoprotein'],
        units: { 'mmol/l': 1, 'mg/dl': 0.02586 },
    },
    triglycerides: {
        displayName: 'Triglycerides',
        unit: 'mmol/L',
        aliases: ['triglycerides', 'trig', 'tg'],
        units: { 'mmol/l': 1, 'mg/dl': 0.01129 },
    },
    hba1c: {
        displayName: 'HbA1c',
        unit: 'mmol/mol',
        aliases: ['hba1c', 'a1c', 'glycatedhaemoglobin', 'glycatedhemoglobin', 'haemoglobina1c'],
        // DCCT % → IFCC mmol/mol is affine, not a simple ratio — see convert()
        units: { 'mmol/mol': 1, '%': 'dcct_to_ifcc' },
    },
    fasting_glucose: {
        displayName: 'Fasting Glucose',
        unit: 'mmol/L',
        aliases: ['fastingglucose', 'glucose', 'glucosefasting', 'fbg', 'fpg', 'bloodglucose'],
        units: { 'mmol/l': 1, 'mg/dl': 0.05551 },
    },
    tsh: {
        displayName: 'TSH',
        unit: 'mIU/L',
        aliases: ['tsh', 'thyroidstimulatinghormone', 'thyrotropin'],
        units: { 'miu/l': 1, 'uiu/ml': 1, 'µiu/ml': 1, 'mu/l': 1 },
    },
    free_t4: {
        displayName: 'Free T4',
        unit: 'pmol/L',
        aliases: ['freet4', 't4free', 'ft4', 'freethyroxine'],
        units: { 'pmol/l': 1, 'ng/dl': 12.87 },
    },
    creatinine: {
        displayName: 'Creatinine',
        unit: 'µmol/L',
        aliases: ['creatinine', 'serumcreatinine', 'creat'],
        units: { 'µmol/l': 1, 'umol/l': 1, 'mg/dl': 88.42 },
    },
    egfr: {
        displayName: 'eGFR',
        unit: 'mL/min/1.73m²',
        aliases: ['egfr', 'estimatedgfr', 'gfr'],
        units: { 'ml/min/1.73m²': 1, 'ml/min/1.73m2': 1, 'ml/min': 1 },
    },
    alt: {
        displayName: 'ALT',
        unit: 'U/L',
        aliases: ['alt', 'alanineaminotransferase', 'sgpt'],
        units: { 'u/l': 1, 'iu/l': 1 },
    },
    ast: {
        displayName: 'AST',
        unit: 'U/L',
        aliases: ['ast', 'aspartateaminotransferase', 'sgot'],
        units: { 'u/l': 1, 'iu/l': 1 },
    },
    vitamin_d: {
        displayName: 'Vitamin D (25-OH)',
        unit: 'nmol/L',
        aliases: ['vitamind', 'vitd', '25ohd', '25hydroxyvitamind', 'vitamind25oh'],
        units: { 'nmol/l': 1, 'ng/ml': 2.496 },
    },
    vitamin_b12: {
        displayName: 'Vitamin B12',
        unit: 'pmol/L',
        aliases: ['vitaminb12', 'b12', 'cobalamin'],
        units: { 'pmol/l': 1, 'pg/ml': 0.7378 },
    },
    psa: {
        displayName: 'PSA',
        unit: 'ng/mL',
        aliases: ['psa', 'prostatespecificantigen', 'psatotal', 'totalpsa'],
        units: { 'ng/ml': 1, 'µg/l': 1, 'ug/l': 1 },
    },
};

/** Strip everything that varies between labs so aliases can be matched. */
const slug = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Normalise a unit string for lookup, keeping the characters that distinguish units. */
const unitKey = (value) =>
    String(value ?? '').toLowerCase().replace(/\s/g, '').replace(/μ/g, 'µ');

// Reverse alias index, built once
const ALIAS_INDEX = new Map();
for (const [canonical, def] of Object.entries(BIOMARKERS)) {
    ALIAS_INDEX.set(slug(canonical), canonical);
    for (const alias of def.aliases) ALIAS_INDEX.set(slug(alias), canonical);
}

/**
 * Resolve a reported analyte name to a canonical key.
 * @returns {string|null} canonical key, or null when unrecognised.
 */
const resolveName = (reportedName) => ALIAS_INDEX.get(slug(reportedName)) ?? null;

/**
 * HbA1c: DCCT/NGSP percent → IFCC mmol/mol.
 * Affine, not proportional: mmol/mol = (% − 2.15) × 10.929
 */
const dcctToIfcc = (percent) => (percent - 2.15) * 10.929;

/**
 * Convert a value into the canonical unit for its analyte.
 *
 * @returns {{value:number, unit:string, converted:boolean, recognised:boolean}}
 *   `recognised: false` means the unit was not understood. The value is returned unchanged
 *   and MUST NOT be range-flagged — send it to human confirmation instead.
 */
const convert = (canonicalName, value, reportedUnit) => {
    const def = BIOMARKERS[canonicalName];
    const numeric = Number(value);

    if (!def || Number.isNaN(numeric)) {
        return { value: numeric, unit: reportedUnit ?? '', converted: false, recognised: false };
    }

    // No unit on the report: assume canonical, but say so rather than pretending certainty
    if (!reportedUnit) {
        return { value: numeric, unit: def.unit, converted: false, recognised: false };
    }

    const factor = def.units[unitKey(reportedUnit)];

    if (factor === undefined) {
        return { value: numeric, unit: reportedUnit, converted: false, recognised: false };
    }

    if (factor === 'dcct_to_ifcc') {
        return {
            value: Number(dcctToIfcc(numeric).toFixed(4)),
            unit: def.unit,
            converted: true,
            recognised: true,
        };
    }

    return {
        value: Number((numeric * factor).toFixed(6)),
        unit: def.unit,
        converted: factor !== 1,
        recognised: true,
    };
};

/**
 * Normalise one reported measurement.
 *
 * `needsReview` is set whenever the analyte or its unit was not recognised, so unrecognised
 * data reaches a human instead of being flagged against a range that may not apply.
 */
const normaliseMeasurement = ({ name, value, unit, ...rest }) => {
    const canonical = resolveName(name);

    if (!canonical) {
        // Unknown analyte: keep it (it is still a data point) but never range-flag it
        return {
            ...rest,
            name: slug(name).replace(/(.{1,60}).*/, '$1') || 'unknown',
            displayName: name,
            value: Number(value),
            unit: unit ?? '',
            recognised: false,
            needsReview: true,
            normalisationNote: `Unrecognised analyte "${name}" — stored without range evaluation`,
        };
    }

    const def = BIOMARKERS[canonical];
    const conversion = convert(canonical, value, unit);

    return {
        ...rest,
        name: canonical,
        displayName: def.displayName,
        value: conversion.value,
        unit: conversion.unit,
        originalValue: conversion.converted ? Number(value) : undefined,
        originalUnit: conversion.converted ? unit : undefined,
        recognised: conversion.recognised,
        needsReview: !conversion.recognised,
        normalisationNote: conversion.converted
            ? `Converted ${value} ${unit} → ${conversion.value} ${conversion.unit}`
            : conversion.recognised
                ? undefined
                : `Unrecognised unit "${unit ?? '(none)'}" for ${def.displayName} — not range-evaluated`,
    };
};

/** Catalogue for pickers and docs. */
const listBiomarkers = () =>
    Object.entries(BIOMARKERS).map(([name, def]) => ({
        name,
        displayName: def.displayName,
        unit: def.unit,
        acceptedUnits: Object.keys(def.units),
    }));

module.exports = {
    BIOMARKERS,
    resolveName,
    convert,
    normaliseMeasurement,
    listBiomarkers,
    slug,
};
