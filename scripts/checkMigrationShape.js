/**
 * Read-only sanity check for the Phase 3 dry run.
 *
 * Answers the question the dry-run counts leave open: is "0 amendments recovered" because
 * nothing is stranded, or because nothing has ever been reviewed? Those look identical in
 * the summary and mean very different things.
 */
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const AIFeedback = require('../models/AIFeedback');
const Interpretation = require('../models/Interpretation');
const DnaReport = require('../models/DnaReport');
const TestResult = require('../models/testResultModel');

const run = async () => {
    await connectDB();

    const [feedback, snapshots, dnaTotal, dnaReviewed, dnaWithRaw, results, users] = await Promise.all([
        AIFeedback.countDocuments(),
        Interpretation.countDocuments(),
        DnaReport.countDocuments(),
        DnaReport.countDocuments({ status: 'specialist_reviewed' }),
        DnaReport.countDocuments({ 'aiInterpretation.raw': { $exists: true } }),
        TestResult.countDocuments(),
        AIFeedback.distinct('userID'),
    ]);

    console.log(`
AIFeedback rows          ${feedback}
Interpretation snapshots ${snapshots}
Users with feedback      ${users.length}
TestResults              ${results}

DNA reports              ${dnaTotal}
  with stored raw        ${dnaWithRaw}
  specialist_reviewed    ${dnaReviewed}
`);

    if (dnaReviewed === 0) {
        console.log('→ No DNA report has been reviewed, so 0 amendments recovered is expected.');
        console.log('  The correction-loss defect is latent, not active. Phase 5 is pre-emptive.');
    } else {
        console.log(`→ ${dnaReviewed} reviewed report(s) but 0 amendments recovered.`);
        console.log('  Worth investigating: a correction may not be reaching aiInterpretation.raw.');
    }

    await mongoose.disconnect();
};

run().catch(async (e) => { console.error('❌', e.message); await mongoose.disconnect(); process.exit(1); });
