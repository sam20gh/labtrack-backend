/**
 * Repair the biomarker collection.
 *
 *   node scripts/repairBiomarkers.js <userId>            # dry run — prints, writes nothing
 *   node scripts/repairBiomarkers.js <userId> --apply
 *   node scripts/repairBiomarkers.js --all --apply       # every user
 *   node scripts/repairBiomarkers.js --restore <file>    # undo, from a backup this wrote
 *
 * Three defects, all observed on live data, all of which corrupt what the person is shown
 * or what the interpretation engine reads:
 *
 *   1. **Mis-slugged catalogue analytes.** A lossy round-trip through the review screen
 *      stripped the separators from names like "Glycosylated Hemoglobin (HbA1c)" before the
 *      server saw them, so `resolveName` could not split on the parenthesis. The value was
 *      stored raw, in the reported unit, and never compared to a range. The client fix stops
 *      new ones; this repairs the rows already written by re-running the real normaliser and
 *      evaluator rather than patching a flag by hand.
 *
 *   2. **Duplicates.** The same analyte, value, and instant stored more than once, from a
 *      report ingested repeatedly. `interpretationController.gatherContext` feeds every one
 *      of them to the model, and its own comment records the consequence: it cannot tell
 *      five genuine draws from one draw entered five times. It also inflates
 *      `measurementCount`, so the results row offers a trend that is a flat line.
 *
 *   3. **Genotype rows.** `rs429358`-style identifiers are SNPs, not analytes. They reached
 *      the biomarker collection through the lab-report path, carry percentages rather than
 *      measurements, and have no unit, range, trend, or plain-language description.
 *
 * ── Two ordering decisions, both learned by getting them wrong ────────────────────────
 *
 * **Repair runs before dedup.** Five copies of one HbA1c reading were stored under two
 * different keys — one already repaired, four still slugged. Deduplicating first cannot see
 * them as the same measurement, because both the name and the value change during repair.
 * Normalise first, then collapse.
 *
 * **An orphan is never deleted for being an orphan.** Rows whose `testResultId` names a
 * deleted document used to be removed wholesale; that destroyed the sole copy of five real
 * results, including a raised triglycerides the person's own analysis had discussed. A
 * missing parent is a provenance gap, not evidence the blood was never drawn. Orphans are
 * now removed only when they are genuinely redundant — dedup prefers the copy with a live
 * parent — and any that survive are reported so the gap stays visible.
 *
 * Nothing is written without `--apply`, and everything `--apply` touches is journalled to
 * `scripts/backups/` first so it can be put back with `--restore`.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Biomarker = require('../models/Biomarker');
const TestResult = require('../models/testResultModel');
const User = require('../models/userModel');
const { evaluate } = require('../utils/biomarkerEvaluator');
const { normaliseMeasurement } = require('../utils/unitNormaliser');

/**
 * Mis-slugged keys mapped back to the name the lab almost certainly printed.
 *
 * Only entries whose meaning is unambiguous from the slug alone belong here. The original
 * string is unrecoverable — `TestResult.results` is keyed by the same slug — so this is a
 * deliberate, reviewable list rather than a guess made at runtime. Anything not listed is
 * left exactly as it is.
 */
const RESLUG = {
    glycosylatedhemoglobinhba1c: 'Glycosylated Hemoglobin (HbA1c)',
    glycatedhaemoglobinhba1c: 'Glycated Haemoglobin (HbA1c)',
    calculatedldl: 'LDL Cholesterol (Calculated)',
    ldlcholesterolcalculated: 'LDL Cholesterol (Calculated)',
};

/** A SNP identifier: `rs` followed by digits, optionally with the called genotype appended. */
const isGenotypeRow = (name) => /^\s*rs\d+/i.test(String(name || ''));

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const day = (d) => new Date(d).toISOString().slice(0, 10);

/** Identity of a measurement: same analyte, same value, same instant. */
const identity = (name, value, measuredAt) =>
    `${name}|${Number(value).toFixed(4)}|${new Date(measuredAt).getTime()}`;

const run = async (userId, apply, journal) => {
    const uid = new mongoose.Types.ObjectId(String(userId));
    const rows = await Biomarker.find({ userId: uid }).lean();
    if (!rows.length) return { before: 0, after: 0, repaired: 0, dupes: 0, snps: 0, orphans: 0 };

    const user = await User.findById(uid).select('dob gender email').lean();
    console.log(`\n═══ ${user?.email || userId} — ${plural(rows.length, 'measurement')}`);

    const liveIds = new Set(
        (await TestResult.find({ 'patient.user_id': uid }).select('_id').lean())
            .map((t) => String(t._id)),
    );
    const hasLiveParent = (r) => liveIds.has(String(r.testResultId));

    // ── 1. Genotype rows ──────────────────────────────────────────────────────────────
    // First, because they are not measurements and must take no part in anything below.
    const snps = rows.filter((r) => isGenotypeRow(r.name));
    if (snps.length) {
        console.log(`\n  1. Genotype rows — ${plural(snps.length, 'row')} that are not measurements`);
        for (const s of snps) console.log(`     ${s.name.padEnd(28)} ${s.value} ${s.unit}`);
        journal.push(...snps.map((r) => ({ action: 'delete', reason: 'genotype_row', document: r })));
        if (apply) await Biomarker.deleteMany({ _id: { $in: snps.map((s) => s._id) } });
    } else {
        console.log('\n  1. Genotype rows — none');
    }

    const measurements = rows.filter((r) => !isGenotypeRow(r.name));

    // ── 2. Mis-slugged catalogue analytes ─────────────────────────────────────────────
    // Re-runs the real normaliser and evaluator. Patching `flag` directly would leave the
    // value in the reported unit and the flag computed against a range in another one.
    const repairs = new Map();
    for (const row of measurements) {
        if (!RESLUG[row.name]) continue;

        const norm = normaliseMeasurement({
            name: RESLUG[row.name], value: row.value, unit: row.unit,
        });
        if (!norm.recognised) {
            console.log(`     ⚠ ${row.name} → still unrecognised, left alone`);
            continue;
        }

        const evaluation = await evaluate({
            userId: uid, name: norm.name, value: norm.value, user, measuredAt: row.measuredAt,
        });

        repairs.set(String(row._id), {
            name: norm.name,
            displayName: norm.displayName,
            value: norm.value,
            unit: norm.unit,
            flag: evaluation.flag,
            appliedRange: evaluation.appliedRange,
            needsReview: false,
            notes: `Repaired by scripts/repairBiomarkers.js — was stored as "${row.name}" `
                + `${row.value} ${row.unit} without range evaluation.`,
        });
    }

    if (repairs.size) {
        console.log(`\n  2. Mis-slugged — ${plural(repairs.size, 'row')}`);
        const seen = new Set();
        for (const row of measurements) {
            const fix = repairs.get(String(row._id));
            if (!fix || seen.has(row.name)) continue;
            seen.add(row.name);
            const n = measurements.filter((r) => r.name === row.name).length;
            console.log(
                `     ${row.name}${n > 1 ? ` (×${n})` : ''}\n`
                + `       → ${fix.name}  ${row.value} ${row.unit} → ${fix.value.toFixed(2)} ${fix.unit}`
                + `  flag: ${row.flag} → ${fix.flag}`,
            );
        }
    } else {
        console.log('\n  2. Mis-slugged — none');
    }

    /** How a row looks once repaired — the view every later phase reasons about. */
    const effective = (r) => ({ ...r, ...(repairs.get(String(r._id)) || {}) });

    // ── 3. Duplicates ─────────────────────────────────────────────────────────────────
    // Grouped on the *repaired* identity, which is the whole reason repair runs first: four
    // rows keyed `glycosylatedhemoglobinhba1c` and one keyed `hba1c` are one reading stored
    // five times, and only normalisation makes that visible.
    const groups = new Map();
    for (const r of measurements) {
        const e = effective(r);
        const k = identity(e.name, e.value, e.measuredAt);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
    }

    const drop = [];
    const dupeReport = [];
    for (const copies of groups.values()) {
        if (copies.length < 2) continue;
        // Prefer the copy whose report still exists — that is the one with provenance — and
        // among equals the oldest, which is the original ingestion.
        const ordered = [...copies].sort((a, b) => {
            const parent = Number(hasLiveParent(b)) - Number(hasLiveParent(a));
            return parent !== 0 ? parent : new Date(a.createdAt) - new Date(b.createdAt);
        });
        dupeReport.push({ name: effective(ordered[0]).name, count: copies.length });
        drop.push(...ordered.slice(1));
    }

    if (drop.length) {
        console.log(`\n  3. Duplicates — ${plural(drop.length, 'redundant row')} across ${plural(dupeReport.length, 'analyte')}`);
        for (const d of dupeReport) console.log(`     ${d.name.padEnd(28)} ×${d.count}  keeping 1`);
        journal.push(...drop.map((r) => ({ action: 'delete', reason: 'duplicate', document: r })));
        if (apply) await Biomarker.deleteMany({ _id: { $in: drop.map((r) => r._id) } });
    } else {
        console.log('\n  3. Duplicates — none');
    }

    // Repairs are written last, and only to rows that survived deduplication — there is no
    // point normalising a document that is about to be deleted.
    const dropped = new Set(drop.map((r) => String(r._id)));
    let repaired = 0;
    for (const [id, fix] of repairs) {
        if (dropped.has(id)) continue;
        const row = measurements.find((r) => String(r._id) === id);
        journal.push({ action: 'update', reason: 'mis-slugged', document: row });
        if (apply) await Biomarker.updateOne({ _id: row._id }, { $set: fix });
        repaired += 1;
    }

    // ── Provenance report ─────────────────────────────────────────────────────────────
    // Not a deletion. Surfaced so the gap is known rather than assumed away.
    const orphans = measurements
        .filter((r) => !dropped.has(String(r._id)))
        .filter((r) => r.testResultId && !hasLiveParent(r));

    if (orphans.length) {
        console.log(`\n  ⚠ ${plural(orphans.length, 'surviving row')} whose report no longer exists — KEPT`);
        for (const r of orphans) {
            const e = effective(r);
            console.log(`     ${String(e.name).padEnd(28)} ${e.value} ${e.unit || ''}  ${day(r.measuredAt)}`);
        }
    }

    const before = rows.length;
    const after = apply
        ? await Biomarker.countDocuments({ userId: uid })
        : before - snps.length - drop.length;

    return { before, after, repaired, dupes: drop.length, snps: snps.length, orphans: orphans.length };
};

/**
 * Put back everything in a backup that is no longer in the collection.
 *
 * The reason this exists: an earlier version of this script deleted every orphaned row,
 * including the sole copy of five real measurements. A destructive script whose backup
 * nobody can replay has not really written a backup.
 *
 * Matches on `_id`, so restoring twice is a no-op and a document that was only *updated* is
 * left alone — its `_id` still exists.
 */
const restore = async (file) => {
    const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
    const present = new Set(
        (await Biomarker.find({ _id: { $in: journal.map((e) => e.document._id) } })
            .select('_id').lean()).map((r) => String(r._id)),
    );

    const missing = journal.filter((e) => !present.has(String(e.document._id)));
    if (!missing.length) {
        console.log(`\n✅ Nothing to restore — all ${plural(journal.length, 'document')} are present.\n`);
        return;
    }

    console.log(`\n♻️  Restoring ${plural(missing.length, 'document')} from ${file}`);
    for (const e of missing) {
        console.log(`     ${String(e.document.name).padEnd(28)} ${e.document.value} ${e.document.unit || ''}  (${e.reason})`);
    }
    await Biomarker.insertMany(missing.map((e) => e.document), { ordered: false });
    console.log(`\n✅ Restored ${plural(missing.length, 'document')}.\n`);
};

(async () => {
    const args = process.argv.slice(2);
    const apply = args.includes('--apply');
    const all = args.includes('--all');
    const restoreIdx = args.indexOf('--restore');

    if (restoreIdx !== -1) {
        const file = args[restoreIdx + 1];
        if (!file || !fs.existsSync(file)) {
            console.error('❌ Usage: node scripts/repairBiomarkers.js --restore <backupFile>');
            process.exit(1);
        }
        await connectDB();
        await restore(file);
        await mongoose.disconnect();
        return;
    }

    const userId = args.find((a) => !a.startsWith('--'));
    if (!all && !userId) {
        console.error('❌ Usage: node scripts/repairBiomarkers.js <userId> [--apply]');
        console.error('          node scripts/repairBiomarkers.js --all [--apply]');
        console.error('          node scripts/repairBiomarkers.js --restore <backupFile>');
        process.exit(1);
    }
    if (userId && !mongoose.Types.ObjectId.isValid(userId)) {
        console.error(`❌ Not a valid ObjectId: ${userId}`);
        process.exit(1);
    }

    await connectDB();

    const ids = all ? (await Biomarker.distinct('userId')).map(String) : [userId];

    console.log(apply
        ? `\n⚠️  APPLY — writing changes for ${plural(ids.length, 'user')}`
        : `\n🔍 DRY RUN — nothing will be written (${plural(ids.length, 'user')}). Re-run with --apply.`);

    const journal = [];
    const totals = { before: 0, after: 0, repaired: 0, dupes: 0, snps: 0, orphans: 0 };
    for (const id of ids) {
        const r = await run(id, apply, journal);
        for (const k of Object.keys(totals)) totals[k] += r[k];
    }

    if (apply && journal.length) {
        const dir = path.join(__dirname, 'backups');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `biomarkers-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
        fs.writeFileSync(file, JSON.stringify(journal, null, 2));
        console.log(`\n💾 ${plural(journal.length, 'document')} journalled to ${file}`);
        console.log(`   Undo with: node scripts/repairBiomarkers.js --restore ${file}`);
    }

    console.log('\n─────────────────────────────────────────────');
    console.log(`  genotype rows removed  ${totals.snps}`);
    console.log(`  rows repaired          ${totals.repaired}`);
    console.log(`  duplicates removed     ${totals.dupes}`);
    console.log(`  orphans kept           ${totals.orphans}`);
    console.log(`  measurements           ${totals.before} → ${totals.after}${apply ? '' : '  (projected)'}`);
    if (!apply) console.log('\n  Nothing was written. Re-run with --apply.');
    console.log('');

    await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
