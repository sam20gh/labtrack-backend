/**
 * Phase 3 — migrate `AIFeedback` rows into `Interpretation` snapshots.
 *
 * The logic lives here rather than in the script so it can be driven by tests against an
 * in-memory database. `scripts/backfillInterpretations.js` is the CLI wrapper.
 *
 * Re-runnable: `Interpretation.migratedFrom` carries a unique index, so a second pass skips
 * rows already migrated rather than duplicating them. That is deliberate — a backfill you
 * are afraid to run twice is one you cannot fix a bug in.
 *
 * The interesting step is amendment recovery. Where an `AIFeedback` row's source is a DNA
 * report whose `aiInterpretation.raw` *differs* from the feedback copy, that difference is a
 * clinician's edit that the patient-facing read has never been able to see. The migration
 * lifts it into `amended.content`, which is the point at which those corrections finally
 * reach the person they are about.
 */
const AIFeedback = require('../models/AIFeedback');
const Interpretation = require('../models/Interpretation');
const TestResult = require('../models/testResultModel');
const DnaReport = require('../models/DnaReport');
const { requiresReview } = require('../config/clinicalPolicy');

/** Which collection does this id belong to? The old `testID` did not record it. */
const resolveSource = async (testID) => {
    if (!testID) return null;

    const result = await TestResult.findById(testID).lean();
    if (result) {
        return {
            ref: { kind: 'test_result', id: result._id, date: result.patient?.date_of_test },
            dnaReport: null,
        };
    }

    const dna = await DnaReport.findById(testID).lean();
    if (dna) {
        return {
            ref: { kind: 'dna_report', id: dna._id, date: dna.reportDate },
            dnaReport: dna,
        };
    }

    // Orphan — the source document was deleted. The interpretation is still the person's
    // record, so it migrates with an empty `covers` rather than being dropped.
    return null;
};

/**
 * Did a clinician change this interpretation?
 *
 * Compares the DNA report's stored copy against the AIFeedback copy. `submitReview` writes
 * amendments to the former and nothing syncs them, so any difference is an edit.
 */
const findAmendment = (dnaReport, aiContent) => {
    const raw = dnaReport?.aiInterpretation?.raw;
    if (!raw) return null;
    if (JSON.stringify(raw) === JSON.stringify(aiContent)) return null;

    return {
        content: raw,
        at: dnaReport.specialistReview?.reviewedAt || dnaReport.aiInterpretation?.generatedAt || null,
        by: dnaReport.specialistReview?.professionalId || null,
    };
};

/**
 * @param {{ dry?: boolean, log?: Function }} options
 * @returns {Promise<{migrated:number, skipped:number, unparseable:number, orphaned:number, amendmentsRecovered:number}>}
 */
const backfill = async ({ dry = false, log = console.log } = {}) => {
    const DRY = dry;
    const warn = (msg) => log(msg);
    // Oldest first so `supersedes` can be chained as we go.
    const rows = await AIFeedback.find().sort({ createdAt: 1 }).lean();
    log(`\n${DRY ? '🔍 DRY RUN — ' : ''}${rows.length} AIFeedback rows to consider\n`);

    const stats = {
        migrated: 0, skipped: 0, unparseable: 0, orphaned: 0, amendmentsRecovered: 0,
    };
    /** Newest migrated interpretation per user, for the supersedes chain. */
    const lastPerUser = new Map();

    for (const row of rows) {
        const id = String(row._id);

        if (await Interpretation.exists({ migratedFrom: row._id })) {
            stats.skipped++;
            continue;
        }

        let content;
        try {
            content = JSON.parse(row.feedback);
        } catch (err) {
            // Known to exist in live data. Logged loudly and left behind rather than
            // silently dropped — someone should look at these.
            warn(`  ⚠️  ${id} — unparseable feedback, left in place (${err.message})`);
            stats.unparseable++;
            continue;
        }

        const source = await resolveSource(row.testID);
        if (!source) {
            warn(`  ⚠️  ${id} — source ${row.testID} not found in either collection; migrating with no covers`);
            stats.orphaned++;
        }

        const amendment = findAmendment(source?.dnaReport, content);
        if (amendment) stats.amendmentsRecovered++;

        const userKey = String(row.userID);
        const doc = {
            userId: row.userID,
            generatedAt: row.createdAt,
            model: source?.dnaReport?.aiInterpretation?.model || null,
            covers: source ? [source.ref] : [],
            content,
            supersedes: lastPerUser.get(userKey) || null,
            review: amendment
                ? {
                    status: 'amended',
                    professionalId: amendment.by,
                    reviewedAt: amendment.at,
                    notes: source?.dnaReport?.specialistReview?.notes,
                    edits: source?.dnaReport?.specialistReview?.edits || [],
                }
                : { status: requiresReview(content) ? 'pending' : 'not_required' },
            amended: amendment || undefined,
            migratedFrom: row._id,
        };

        if (DRY) {
            log(
                `  would migrate ${id} → user ${userKey}` +
                ` · ${doc.covers.length ? doc.covers[0].kind : 'no source'}` +
                ` · review ${doc.review.status}` +
                (amendment ? ' · ✚ amendment recovered' : '')
            );
            // Chain dry-run ids too, so the printed supersedes ordering is realistic.
            lastPerUser.set(userKey, `dry:${id}`);
        } else {
            const created = await Interpretation.create(doc);
            lastPerUser.set(userKey, created._id);
        }
        stats.migrated++;
    }

    log(`
${DRY ? 'Would migrate' : 'Migrated'}:        ${stats.migrated}
Already migrated:     ${stats.skipped}
Unparseable (left):   ${stats.unparseable}
Orphaned sources:     ${stats.orphaned}
Amendments recovered: ${stats.amendmentsRecovered}${stats.amendmentsRecovered ? '  ← corrections patients could not see' : ''}
`);

    return stats;
};

module.exports = { backfill, resolveSource, findAmendment };
