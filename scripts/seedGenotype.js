/**
 * Seed a genotyping result for one user from a raw export.
 *
 * Idempotent — re-running replaces that user's seeded sample rather than stacking copies,
 * keyed on (userId, sourceFile.originalName).
 *
 *   node scripts/seedGenotype.js <userId> [pathToCsv]
 *   node scripts/seedGenotype.js 6a8b5f3f436f39c65fc6dd9a
 *
 * This exists so the app can be finished against real data before the lab contract is
 * settled. Two things it deliberately does NOT do, because they are contract decisions
 * rather than engineering ones (see docs — WO-32, D1/D2):
 *
 *   - it does not upload the raw file to object storage, so `sourceFile.url` is null and
 *     re-extraction reads from the local path instead;
 *   - it does not claim a manifest version the lab has not given us. `chipManifestVersion`
 *     is recorded as unverified, which is what makes the coverage statements honest.
 *
 * ⚠️ The panel this extracts with has not been clinically reviewed. `tier` is what keeps
 * that safe: only `release` entries reach a user without a clinician signing off.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const User = require('../models/userModel');
const GenotypeFile = require('../models/GenotypeFile');
const { parseGenotypeFile, extractFindings, summarise, PANEL_VERSION, NOT_TESTED } = require('../utils/genotypeParser');

const DEFAULT_CSV = '/Users/sam/Desktop/LabTrack/Design/MyHeritage_raw_dna_data.csv';

const sha256 = (filePath) => new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
        .on('data', (chunk) => hash.update(chunk))
        .on('end', () => resolve(hash.digest('hex')))
        .on('error', reject);
});

(async () => {
    const [, , userIdArg, csvArg] = process.argv;
    const userId = userIdArg;
    const csvPath = csvArg || DEFAULT_CSV;

    if (!userId) {
        console.error('❌ Usage: node scripts/seedGenotype.js <userId> [pathToCsv]');
        process.exit(1);
    }
    if (!mongoose.Types.ObjectId.isValid(userId)) {
        console.error(`❌ Not a valid ObjectId: ${userId}`);
        process.exit(1);
    }
    if (!fs.existsSync(csvPath)) {
        console.error(`❌ No such file: ${csvPath}`);
        process.exit(1);
    }

    await connectDB();

    const user = await User.findById(userId).select('firstName lastName gender dob').lean();
    if (!user) {
        console.error(`❌ No user with _id ${userId}`);
        await mongoose.disconnect();
        process.exit(1);
    }

    console.log(`\n🧬 Seeding genotype for ${user.firstName} ${user.lastName} (${userId})`);
    console.log(`   source: ${csvPath}`);

    const t0 = Date.now();
    const { meta, qc, calls } = await parseGenotypeFile(csvPath);
    const findings = extractFindings(calls);
    const stats = summarise(findings);
    const elapsed = Date.now() - t0;

    const stat = fs.statSync(csvPath);
    const checksum = await sha256(csvPath);

    // Sex inferred from the file is a QC signal, not a correction to the profile. A mismatch
    // usually means a sample swap, which is a reason to reject rather than to overwrite.
    const profileSex = (user.gender || '').toLowerCase();
    const sexMismatch = profileSex && qc.inferredSex !== 'undetermined' && profileSex !== qc.inferredSex;

    const doc = {
        userId,
        labName: meta.vendor === 'MyHeritage' ? 'MyHeritage (sample)' : meta.vendor,
        assayType: 'array',
        vendor: meta.vendor,
        chip: meta.chip,
        // Honest placeholder: the real value is a contract deliverable we do not have yet.
        chipManifestVersion: 'unverified — manifest not supplied by lab',
        referenceBuild: meta.referenceBuild,
        sourceFile: {
            url: null,
            originalName: path.basename(csvPath),
            sizeBytes: stat.size,
            checksum,
        },
        qc,
        panelVersion: PANEL_VERSION,
        findings,
        notTested: NOT_TESTED,
        consent: { riskResultsOptIn: false, optedInAt: null },
        status: 'extracted',
        collectedAt: meta.generatedAt,
        reportedAt: meta.generatedAt,
    };

    const result = await GenotypeFile.findOneAndUpdate(
        { userId, 'sourceFile.originalName': doc.sourceFile.originalName },
        { $set: doc },
        { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
    );

    console.log(`\n📄 File`);
    console.log(`   vendor ${meta.vendor} · chip ${meta.chip} · ${meta.referenceBuild}`);
    console.log(`   ${qc.totalCalls.toLocaleString()} calls · call rate ${(qc.callRate * 100).toFixed(2)}%`);
    console.log(`   inferred sex ${qc.inferredSex} (X het ${(qc.xHeterozygosity * 100).toFixed(2)}%, ${qc.yCalls} Y calls)`);
    console.log(`   mitochondrial data: ${qc.hasMitochondrial ? 'yes' : 'no'}`);
    console.log(`   parsed in ${elapsed}ms`);

    if (sexMismatch) {
        console.log(`\n⚠️  Sex mismatch — profile says "${user.gender}", file infers "${qc.inferredSex}".`);
        console.log(`   Profile left unchanged. In production this is a sample-identity check that should reject.`);
    }
    if (!result.passedQc) {
        console.log(`\n⚠️  Call rate ${(qc.callRate * 100).toFixed(2)}% is below the 98% floor.`);
    }
    if (qc.indelCalls) {
        console.log(`\n⚠️  ${qc.indelCalls} insertion/deletion calls dropped — that channel is not reliable enough to report.`);
    }

    console.log(`\n🔬 Panel ${PANEL_VERSION}`);
    console.log(`   called ${stats.called} · not covered ${stats.notCovered} · rejected ${stats.rejected} · unmatched ${stats.unmatched} · suppressed ${stats.suppressed}`);
    console.log(`   by tier — release ${stats.byTier.release} · clinician ${stats.byTier.clinician} · opt-in ${stats.byTier.optIn}`);

    const flipped = findings.filter((f) => f.strandFlipped);
    const ambiguous = findings.filter((f) => f.strandAmbiguous);
    if (flipped.length) console.log(`   ${flipped.length} matched only after reverse-complementing: ${flipped.map((f) => f.rsid).join(', ')}`);
    if (ambiguous.length) console.log(`   ${ambiguous.length} palindromic (A/T or C/G) — strand unverifiable: ${ambiguous.map((f) => f.rsid).join(', ')}`);

    const unmatched = findings.filter((f) => f.status === 'unmatched');
    if (unmatched.length) {
        console.log(`\n⚠️  Not interpreted (unexpected genotype — check panel orientation):`);
        for (const f of unmatched) console.log(`   ${f.rsid} ${f.gene} → ${f.genotype}`);
    }

    console.log(`\n👁  Released to the user immediately (${stats.byTier.release}):`);
    for (const f of findings.filter((x) => x.tier === 'release' && x.status === 'called')) {
        console.log(`   ${f.gene.padEnd(9)} ${(f.genotype || '').padEnd(6)} ${f.name} — ${f.label}`);
    }
    console.log(`\n🔒 Held for clinician review (${stats.byTier.clinician}) · hidden until opt-in (${stats.byTier.optIn})`);
    console.log(`   ${NOT_TESTED.length} coverage gaps recorded and shown to the user`);

    console.log(`\n✅ GenotypeFile ${result._id}`);
    console.log(`   GET /api/genotypes/${result._id}\n`);

    await mongoose.disconnect();
})().catch(async (err) => {
    console.error('❌ Seed failed:', err.message);
    console.error(err.stack);
    try { await mongoose.disconnect(); } catch { /* already closed */ }
    process.exit(1);
});
