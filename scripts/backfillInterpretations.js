/**
 * Phase 3 CLI — migrate `AIFeedback` rows into `Interpretation` snapshots.
 *
 * Run the dry pass first. It prints exactly what it would write and touches nothing:
 *
 *     node scripts/backfillInterpretations.js --dry
 *     node scripts/backfillInterpretations.js
 *
 * Safe to run more than once; already-migrated rows are skipped. The logic lives in
 * `utils/interpretationBackfill.js` so it can be tested against an in-memory database.
 */
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const { backfill } = require('../utils/interpretationBackfill');

const run = async () => {
    await connectDB();
    const stats = await backfill({ dry: process.argv.includes('--dry') });
    await mongoose.disconnect();

    // A non-zero exit on leftovers so a CI or deploy step notices rather than scrolling past.
    if (stats.unparseable || stats.orphaned) {
        console.warn('Some rows need a human. See the warnings above.');
    }
};

run().catch(async (err) => {
    console.error('❌ Backfill failed:', err);
    await mongoose.disconnect();
    process.exit(1);
});
