/**
 * Seed the three packages and the stand-alone bracelet — PLACEHOLDERS.
 *
 * The real tiers, prices and copy are not decided yet. These exist so the website's
 * /packages page, the app's package screen and the journey card all have something real to
 * lay out against, and so fulfilment can be exercised end to end in the Stripe sandbox.
 * Edit them in the staff portal (Products) once the tiers are settled; nothing reads these
 * values from code.
 *
 *   node scripts/seedPackages.js            # dry run: prints what it would write
 *   node scripts/seedPackages.js --apply    # upserts on `sku`
 *   node scripts/seedPackages.js --purge    # removes these four SKUs and stops
 *
 * What is load-bearing here is `includes`, not the copy: it decides which parcels an order
 * tracks (`utils/orderComponents.js`). The Basic package deliberately ships no bracelet —
 * somebody on it can buy one later from the app, which is what the `bracelet` row is.
 * Copy follows the codebase rule for placeholder health text: no numbers, no thresholds,
 * nothing that could be read as clinical advice.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Product = require('../models/Product');

const ROWS = [
    {
        sku: 'PKG-BASIC',
        name: 'Predyqt Basic',
        type: 'package',
        price: 149,
        description: 'A blood panel and your DNA, explained in plain words and turned into a plan.',
        includes: ['blood', 'dna'],
        package: {
            tier: 'Basic',
            tagline: 'Your blood and your DNA, read together',
            highlights: [
                'Home blood test kit',
                'Home DNA test kit',
                'A plain-language analysis of both',
                'A personal plan that updates as results arrive',
            ],
            rank: 1,
            featured: false,
        },
    },
    {
        sku: 'PKG-PLUS',
        name: 'Predyqt Plus',
        type: 'package',
        price: 249,
        description: 'Everything in Basic, plus the Predyqt bracelet, so your plan learns from every day.',
        includes: ['blood', 'dna', 'bracelet'],
        package: {
            tier: 'Plus',
            tagline: 'Results plus what your body does every day',
            highlights: [
                'Everything in Basic',
                'Predyqt bracelet: sleep, heart rate, oxygen and activity',
                'The app starts learning about you before your DNA is back',
            ],
            rank: 2,
            featured: true,
        },
    },
    {
        sku: 'PKG-COMPLETE',
        name: 'Predyqt Complete',
        type: 'package',
        price: 349,
        description: 'Plus, with a follow-up blood test to show how your plan is working.',
        includes: ['blood', 'dna', 'bracelet'],
        package: {
            tier: 'Complete',
            tagline: 'See whether the changes are working',
            highlights: [
                'Everything in Plus',
                'A follow-up blood test later in the year',
                'A clinician-reviewed analysis',
            ],
            rank: 3,
            featured: false,
        },
    },
    {
        sku: 'BRACELET',
        name: 'Predyqt Bracelet',
        type: 'device',
        price: 99,
        description: 'Records sleep, heart rate, blood oxygen and activity, and syncs with the app.',
        includes: ['bracelet'],
    },
];

const run = async () => {
    const apply = process.argv.includes('--apply');
    const purge = process.argv.includes('--purge');

    await connectDB();

    if (purge) {
        const result = await Product.deleteMany({ sku: { $in: ROWS.map((r) => r.sku) } });
        console.log(`🗑️  Removed ${result.deletedCount} seeded package product(s).`);
        return;
    }

    for (const row of ROWS) {
        const existing = await Product.findOne({ sku: row.sku }).select('_id price').lean();
        console.log(`${existing ? '↻ update' : '+ create'}  ${row.sku.padEnd(13)} ${row.name}  £${row.price}  [${row.includes.join(', ')}]`);
        if (apply) {
            await Product.updateOne({ sku: row.sku }, { $set: row }, { upsert: true, runValidators: true });
        }
    }

    if (!apply) console.log('\nDry run. Re-run with --apply to write.');
};

run()
    .catch((e) => { console.error('❌ Seeding packages failed:', e); process.exitCode = 1; })
    .finally(() => mongoose.disconnect());
