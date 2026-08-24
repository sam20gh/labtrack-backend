/**
 * Seed the orderable product catalogue.
 *
 * Idempotent — keyed on `sku`, so re-running updates rather than duplicating.
 *
 *   node scripts/seedProducts.js
 *
 * ## Why the names are short
 *
 * `planGeneratorV2.matchProduct()` matches bidirectionally on substring: a screening is
 * linked to a product when either name contains the other. Model output is descriptive
 * ("Bilateral breast MRI with contrast", "DEXA bone density scan"), so a SHORT canonical
 * product name is far more likely to be contained within it than a long one is to contain
 * it. "Breast MRI" matches the first; "Bilateral Breast MRI With Contrast Imaging" would
 * match almost nothing.
 *
 * Prices are indicative UK private-pay rates and should be replaced with real partner
 * pricing before launch.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Product = require('../models/Product');

const PRODUCTS = [
    // --- Blood panels ------------------------------------------------------
    { sku: 'CBC-0001', name: 'Complete Blood Count (CBC)', type: 'Blood Test', price: 49.99,
      description: 'Full blood count covering red and white cells, haemoglobin, haematocrit, and platelets.' },
    { sku: 'BLD-LIPID', name: 'Lipid Panel', type: 'Blood Test', price: 44.99,
      description: 'Total cholesterol, LDL, HDL, and triglycerides — the core cardiovascular risk markers.' },
    { sku: 'BLD-LIVER', name: 'Liver Function Test', type: 'Blood Test', price: 44.99,
      description: 'ALT, AST, ALP, GGT, bilirubin, albumin and total protein.' },
    { sku: 'BLD-KIDNEY', name: 'Kidney Function Test', type: 'Blood Test', price: 44.99,
      description: 'Creatinine, urea, eGFR and electrolytes.' },
    { sku: 'BLD-THYROID', name: 'Thyroid Panel', type: 'Blood Test', price: 54.99,
      description: 'TSH and Free T4 to assess thyroid function.' },
    { sku: 'BLD-HBA1C', name: 'HbA1c', type: 'Blood Test', price: 34.99,
      description: 'Average blood glucose over the past two to three months. Used to screen for and monitor diabetes.' },
    { sku: 'BLD-GLUCOSE', name: 'Fasting Glucose', type: 'Blood Test', price: 24.99,
      description: 'Fasting blood glucose measurement.' },
    { sku: 'BLD-VITD', name: 'Vitamin D', type: 'Blood Test', price: 39.99,
      description: '25-hydroxyvitamin D, the standard measure of vitamin D status.' },
    { sku: 'BLD-B12', name: 'Vitamin B12', type: 'Blood Test', price: 34.99,
      description: 'Serum B12, with folate where indicated.' },
    { sku: 'BLD-FERRITIN', name: 'Ferritin', type: 'Blood Test', price: 34.99,
      description: 'Iron stores. Low ferritin is the earliest sign of iron deficiency.' },
    { sku: 'BLD-IRON', name: 'Iron Studies', type: 'Blood Test', price: 49.99,
      description: 'Serum iron, ferritin, transferrin saturation and total iron binding capacity.' },
    { sku: 'BLD-CRP', name: 'C-Reactive Protein', type: 'Blood Test', price: 29.99,
      description: 'Inflammatory marker, measured at high sensitivity for cardiovascular risk.' },
    { sku: 'BLD-PSA', name: 'PSA Test', type: 'Blood Test', price: 44.99,
      description: 'Prostate-specific antigen, used in prostate cancer surveillance.' },
    { sku: 'BLD-CA125', name: 'CA-125', type: 'Blood Test', price: 59.99,
      description: 'Ovarian cancer marker, used alongside transvaginal ultrasound in high-risk surveillance.' },
    { sku: 'BLD-HORMONE', name: 'Hormone Panel', type: 'Blood Test', price: 89.99,
      description: 'Reproductive and adrenal hormone profile.' },
    { sku: 'BLD-FULL', name: 'Comprehensive Health Panel', type: 'Blood Test', price: 149.99,
      description: 'Full blood count, metabolic panel, lipids, liver, kidney, thyroid and key vitamins in one draw.' },

    // --- Imaging -----------------------------------------------------------
    { sku: 'IMG-BREASTMRI', name: 'Breast MRI', type: 'Scan', price: 649.00,
      description: 'Contrast-enhanced breast MRI. First-line surveillance for BRCA carriers and other high-risk groups.' },
    { sku: 'IMG-MAMMO', name: 'Mammography', type: 'Scan', price: 189.00,
      description: 'Digital mammography with tomosynthesis where available.' },
    { sku: 'IMG-TVUS', name: 'Transvaginal Ultrasound', type: 'Scan', price: 279.00,
      description: 'Pelvic ultrasound of the ovaries and uterus. Paired with CA-125 in ovarian surveillance.' },
    { sku: 'IMG-ABDOUS', name: 'Abdominal Ultrasound', type: 'Scan', price: 249.00,
      description: 'Ultrasound of the liver, gallbladder, pancreas, kidneys and spleen.' },
    { sku: 'IMG-DEXA', name: 'Bone Density Scan', type: 'Scan', price: 199.00,
      description: 'DEXA scan measuring bone mineral density to assess osteoporosis risk.' },
    { sku: 'IMG-MRI', name: 'MRI Scan', type: 'Scan', price: 599.00,
      description: 'Magnetic resonance imaging of a specified region.' },
    { sku: 'IMG-CT', name: 'CT Scan', type: 'Scan', price: 499.00,
      description: 'Computed tomography of a specified region.' },
    { sku: 'IMG-EUS', name: 'Endoscopic Ultrasound', type: 'Scan', price: 899.00,
      description: 'Endoscopic ultrasound, used in pancreatic surveillance for high-risk individuals.' },
    { sku: 'IMG-CARDIAC', name: 'Cardiac Calcium Score', type: 'Scan', price: 329.00,
      description: 'CT coronary calcium score for cardiovascular risk stratification.' },

    // --- Procedures and examinations ---------------------------------------
    { sku: 'PRC-COLONOSCOPY', name: 'Colonoscopy', type: 'Procedure', price: 1250.00,
      description: 'Diagnostic colonoscopy with polyp removal where indicated.' },
    { sku: 'PRC-GASTROSCOPY', name: 'Gastroscopy', type: 'Procedure', price: 950.00,
      description: 'Upper GI endoscopy examining the oesophagus, stomach and duodenum.' },
    { sku: 'EXM-BREAST', name: 'Clinical Breast Exam', type: 'Examination', price: 95.00,
      description: 'Clinical breast examination by a specialist clinician.' },
    { sku: 'EXM-SKIN', name: 'Skin Examination', type: 'Examination', price: 145.00,
      description: 'Full-body dermatological skin examination with dermoscopy of suspicious lesions.' },
    { sku: 'EXM-CERVICAL', name: 'Cervical Screening', type: 'Examination', price: 125.00,
      description: 'Cervical smear with HPV testing.' },
    { sku: 'EXM-HEALTH', name: 'Health Assessment', type: 'Examination', price: 249.00,
      description: 'In-person review with a clinician covering history, examination and results.' },

    // --- Genetic -----------------------------------------------------------
    { sku: 'DNA-HEALTH', name: 'DNA Health Screen', type: 'DNA Test', price: 299.00,
      description: 'Whole-panel genetic screen covering hereditary disease risk, carrier status and pharmacogenomics.' },
    { sku: 'DNA-BRCA', name: 'BRCA1/BRCA2 Genetic Test', type: 'DNA Test', price: 349.00,
      description: 'Targeted BRCA1 and BRCA2 sequencing for hereditary breast and ovarian cancer risk.' },
    { sku: 'DNA-CANCER', name: 'Hereditary Cancer Panel', type: 'DNA Test', price: 449.00,
      description: 'Multi-gene panel covering the major hereditary cancer syndromes, including Lynch and HBOC.' },
    { sku: 'DNA-CARDIO', name: 'Cardiac Genetic Panel', type: 'DNA Test', price: 399.00,
      description: 'Genetic screen for inherited cardiac conditions and familial hypercholesterolaemia.' },
    { sku: 'DNA-PGX', name: 'Pharmacogenomic Test', type: 'DNA Test', price: 249.00,
      description: 'How your genetics affect your response to common medications.' },

    // --- Other -------------------------------------------------------------
    { sku: 'URINE-TEST-001', name: 'Urinalysis Panel', type: 'Urine Test', price: 29.99,
      description: 'Urine analysis covering protein, glucose, blood and infection markers.' },
];

(async () => {
    await connectDB();

    let created = 0;
    let updated = 0;

    for (const product of PRODUCTS) {
        const existing = await Product.findOne({ sku: product.sku });
        if (existing) {
            // Preserve any image already uploaded for this product
            await Product.updateOne(
                { sku: product.sku },
                { $set: { ...product, image: existing.image ?? product.image } },
                { runValidators: true }
            );
            updated++;
        } else {
            await Product.create(product);
            created++;
        }
    }

    const total = await Product.countDocuments();
    const byType = await Product.aggregate([
        { $group: { _id: '$type', count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
    ]);

    console.log(`\n✅ Products seeded`);
    console.log(`   created: ${created}   updated: ${updated}   total: ${total}`);
    for (const t of byType) console.log(`   ${String(t._id).padEnd(14)} ${t.count}`);
    console.log('');

    await mongoose.disconnect();
})().catch(async (err) => {
    console.error('❌ Seed failed:', err.message);
    await mongoose.disconnect();
    process.exit(1);
});
