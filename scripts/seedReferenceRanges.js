/**
 * Seed the reference-range catalogue.
 *
 * Idempotent — re-running updates existing rows rather than duplicating them, keyed on
 * (biomarker, sex, ageMin, ageMax).
 *
 *   node scripts/seedReferenceRanges.js
 *
 * These are widely-published adult ranges intended to make the flagging pipeline testable.
 * Ranges vary between laboratories and authorities: before this drives anything a user
 * sees clinically, they should be reviewed against the labs LabTrack actually partners
 * with, and `source` updated accordingly.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const ReferenceRange = require('../models/ReferenceRange');

const SOURCE = 'LabTrack seed (common adult reference intervals) — verify per partner lab';

const RANGES = [
    // --- Iron studies -------------------------------------------------------
    {
        biomarker: 'ferritin', displayName: 'Ferritin', unit: 'ng/mL',
        sex: 'male', ageMin: 18, ageMax: 200, min: 30, max: 400, criticalMin: 10,
        geneModifiers: [{
            gene: 'HFE',
            max: 200,
            rationale: 'HFE variants raise iron-overload risk, so a tighter ferritin ceiling is monitored',
        }],
    },
    {
        biomarker: 'ferritin', displayName: 'Ferritin', unit: 'ng/mL',
        sex: 'female', ageMin: 18, ageMax: 200, min: 15, max: 200, criticalMin: 10,
        geneModifiers: [{
            gene: 'HFE',
            max: 150,
            rationale: 'HFE variants raise iron-overload risk, so a tighter ferritin ceiling is monitored',
        }],
    },
    { biomarker: 'haemoglobin', displayName: 'Haemoglobin', unit: 'g/dL', sex: 'male', ageMin: 18, ageMax: 200, min: 13.0, max: 17.0, criticalMin: 8.0, criticalMax: 20.0 },
    { biomarker: 'haemoglobin', displayName: 'Haemoglobin', unit: 'g/dL', sex: 'female', ageMin: 18, ageMax: 200, min: 11.5, max: 15.5, criticalMin: 8.0, criticalMax: 20.0 },

    // --- Lipids -------------------------------------------------------------
    { biomarker: 'total_cholesterol', displayName: 'Total Cholesterol', unit: 'mmol/L', sex: 'any', ageMin: 18, ageMax: 200, max: 5.0 },
    { biomarker: 'ldl_cholesterol', displayName: 'LDL Cholesterol', unit: 'mmol/L', sex: 'any', ageMin: 18, ageMax: 200, max: 3.0, criticalMax: 5.0 },
    { biomarker: 'hdl_cholesterol', displayName: 'HDL Cholesterol', unit: 'mmol/L', sex: 'male', ageMin: 18, ageMax: 200, min: 1.0 },
    { biomarker: 'hdl_cholesterol', displayName: 'HDL Cholesterol', unit: 'mmol/L', sex: 'female', ageMin: 18, ageMax: 200, min: 1.2 },
    { biomarker: 'triglycerides', displayName: 'Triglycerides', unit: 'mmol/L', sex: 'any', ageMin: 18, ageMax: 200, max: 1.7, criticalMax: 10.0 },

    // --- Glycaemic ----------------------------------------------------------
    { biomarker: 'hba1c', displayName: 'HbA1c', unit: 'mmol/mol', sex: 'any', ageMin: 18, ageMax: 200, max: 42, criticalMax: 86 },
    { biomarker: 'fasting_glucose', displayName: 'Fasting Glucose', unit: 'mmol/L', sex: 'any', ageMin: 18, ageMax: 200, min: 3.9, max: 5.5, criticalMin: 2.5, criticalMax: 20.0 },

    // --- Thyroid ------------------------------------------------------------
    { biomarker: 'tsh', displayName: 'TSH', unit: 'mIU/L', sex: 'any', ageMin: 18, ageMax: 200, min: 0.4, max: 4.0, criticalMax: 20.0 },
    { biomarker: 'free_t4', displayName: 'Free T4', unit: 'pmol/L', sex: 'any', ageMin: 18, ageMax: 200, min: 9.0, max: 25.0 },

    // --- Renal / hepatic ----------------------------------------------------
    { biomarker: 'creatinine', displayName: 'Creatinine', unit: 'µmol/L', sex: 'male', ageMin: 18, ageMax: 200, min: 59, max: 104 },
    { biomarker: 'creatinine', displayName: 'Creatinine', unit: 'µmol/L', sex: 'female', ageMin: 18, ageMax: 200, min: 45, max: 84 },
    { biomarker: 'egfr', displayName: 'eGFR', unit: 'mL/min/1.73m²', sex: 'any', ageMin: 18, ageMax: 200, min: 90, criticalMin: 15 },
    { biomarker: 'alt', displayName: 'ALT', unit: 'U/L', sex: 'any', ageMin: 18, ageMax: 200, max: 40 },
    { biomarker: 'ast', displayName: 'AST', unit: 'U/L', sex: 'any', ageMin: 18, ageMax: 200, max: 40 },

    // --- Vitamins -----------------------------------------------------------
    { biomarker: 'vitamin_d', displayName: 'Vitamin D (25-OH)', unit: 'nmol/L', sex: 'any', ageMin: 18, ageMax: 200, min: 50, max: 125, criticalMin: 25 },
    { biomarker: 'vitamin_b12', displayName: 'Vitamin B12', unit: 'pmol/L', sex: 'any', ageMin: 18, ageMax: 200, min: 148, max: 664 },

    // --- Cancer markers -----------------------------------------------------
    {
        biomarker: 'psa', displayName: 'PSA', unit: 'ng/mL',
        sex: 'male', ageMin: 18, ageMax: 49, max: 2.5,
        geneModifiers: [{
            gene: 'BRCA2',
            max: 2.0,
            rationale: 'BRCA2 carriers face elevated prostate cancer risk; surveillance threshold lowered',
        }],
    },
    { biomarker: 'psa', displayName: 'PSA', unit: 'ng/mL', sex: 'male', ageMin: 50, ageMax: 59, max: 3.5 },
    { biomarker: 'psa', displayName: 'PSA', unit: 'ng/mL', sex: 'male', ageMin: 60, ageMax: 200, max: 4.5 },
];

(async () => {
    await connectDB();

    let created = 0;
    let updated = 0;

    for (const range of RANGES) {
        const key = {
            biomarker: range.biomarker,
            sex: range.sex,
            ageMin: range.ageMin,
            ageMax: range.ageMax,
        };
        const result = await ReferenceRange.updateOne(
            key,
            { $set: { ...range, source: SOURCE, isActive: true } },
            { upsert: true, runValidators: true }
        );
        if (result.upsertedCount) created++;
        else updated++;
    }

    const total = await ReferenceRange.countDocuments({ isActive: true });
    const distinct = await ReferenceRange.distinct('biomarker');

    console.log(`\n✅ Reference ranges seeded`);
    console.log(`   created: ${created}   updated: ${updated}`);
    console.log(`   active rows: ${total}   distinct biomarkers: ${distinct.length}`);
    console.log(`   ${distinct.sort().join(', ')}\n`);

    await mongoose.disconnect();
})().catch(async (err) => {
    console.error('❌ Seed failed:', err.message);
    await mongoose.disconnect();
    process.exit(1);
});
