/**
 * Rebuild every person's AI plan from their newest interpretation.
 *
 *   node scripts/rebuildPlans.js                     # dry run — prints, writes nothing
 *   node scripts/rebuildPlans.js --apply
 *   node scripts/rebuildPlans.js --user <id> --apply # one person
 *   node scripts/rebuildPlans.js --restore <file>    # undo, from a backup this wrote
 *
 * Before `generateInterpretation` allowed one run per person at a time, two overlapping
 * generations could each write a full plan, leaving two copies worded slightly differently —
 * the nutrition tracker showed the same diet advice twice. New generations can no longer do
 * that, but the plans already written still carry the duplicates, and none of their items
 * carry `sourceInterpretationId`.
 *
 * This runs exactly what a fresh generation would, minus the model call: `regeneratePlan`
 * over the newest stored interpretation's `content`. The same inputs the live path uses —
 * `content`, not `amended.content`, because a clinician's amendment does not regenerate the
 * plan today and this must not quietly change that. So it keeps everything a regeneration
 * keeps: ordered, booked, completed and dismissed items, and anything a clinician added.
 *
 * The nutrition tracker needs nothing: `NutritionPlan.guidance` is rebuilt on its next read.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const PlanItem = require('../models/PlanItem');
const Interpretation = require('../models/Interpretation');
const User = require('../models/userModel');
const Product = require('../models/Product');
const Professional = require('../models/Professional');
const { regeneratePlan, buildPlanItems } = require('../utils/planGeneratorV2');
const { deriveGuidance } = require('../utils/nutritionTargets');

const isReplaceable = (i) => i.source === 'ai' && PlanItem.MUTABLE_STATUSES.includes(i.status);
const isActiveDiet = (i) => i.type === 'lifestyle' && i.condition === 'diet' && !['dismissed', 'completed'].includes(i.status);

/** Rows that are the same item written more than once: same type, title and due day. */
const duplicateCount = (items) => {
    const seen = new Set();
    let dupes = 0;
    for (const i of items) {
        const key = `${i.type}|${String(i.title).trim().toLowerCase()}|${new Date(i.dueDate).toISOString().slice(0, 10)}`;
        if (seen.has(key)) dupes += 1;
        else seen.add(key);
    }
    return dupes;
};

const restore = async (file) => {
    const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const entry of journal) {
        const removed = await PlanItem.deleteMany({ _id: { $in: entry.createdIds } });
        const present = new Set((await PlanItem.find({ _id: { $in: entry.before.map((d) => d._id) } })
            .select('_id').lean()).map((r) => String(r._id)));
        const missing = entry.before.filter((d) => !present.has(String(d._id)));
        if (missing.length) await PlanItem.insertMany(missing, { ordered: false });
        console.log(`♻️  ${entry.userId}: removed ${removed.deletedCount} rebuilt item(s), restored ${missing.length}`);
    }
};

(async () => {
    const args = process.argv.slice(2);
    const apply = args.includes('--apply');

    await connectDB();

    const restoreIdx = args.indexOf('--restore');
    if (restoreIdx !== -1) {
        await restore(args[restoreIdx + 1]);
        await mongoose.disconnect();
        return;
    }

    const userIdx = args.indexOf('--user');
    const userIds = userIdx !== -1
        ? [args[userIdx + 1]]
        : (await Interpretation.distinct('userId')).map(String);

    const [products, professionals] = await Promise.all([
        Product.find().lean(),
        Professional.find().select('firstname lastname speciality profile_image').lean(),
    ]);

    console.log(`\n${apply ? '✍️  APPLYING' : '🔎 DRY RUN — nothing is written'} · ${userIds.length} user(s)\n`);

    // Written before each person's rebuild and again after, so a crash part-way through
    // still leaves a backup that can be replayed.
    const journal = [];
    const backupFile = path.join(__dirname, 'backups', `plans-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    const saveJournal = () => {
        fs.mkdirSync(path.dirname(backupFile), { recursive: true });
        fs.writeFileSync(backupFile, JSON.stringify(journal, null, 2));
    };

    for (const userId of userIds) {
        const [user, newest, items] = await Promise.all([
            User.findById(userId).select('_id dob email').lean(),
            Interpretation.findOne({ userId }).sort({ generatedAt: -1, _id: -1 }).lean(),
            PlanItem.find({ userId }).sort({ createdAt: 1 }).lean(),
        ]);
        if (!user || !newest?.content) {
            console.log(`⏭️  ${userId}: ${!user ? 'no user' : 'no interpretation content'} — skipped\n`);
            continue;
        }

        const replaceable = items.filter(isReplaceable);
        // The same source documents the live path would pass: the ones the current AI items
        // were generated from.
        const lastAi = [...items].reverse().find((i) => i.source === 'ai') || {};
        const sources = {
            sourceDnaReportId: lastAi.sourceDnaReportId || undefined,
            sourceTestResultId: lastAi.sourceTestResultId || undefined,
        };

        const { items: planned } = buildPlanItems({ interpretation: newest.content, user, products, professionals, ...sources });
        const kept = items.filter((i) => !isReplaceable(i));
        const guidanceNow = deriveGuidance(items.filter(isActiveDiet));
        const guidanceAfter = deriveGuidance([...kept, ...planned.map((p) => ({ ...p, createdAt: new Date() }))].filter(isActiveDiet));

        console.log(`👤 ${user.email || userId}`);
        console.log(`   newest interpretation ${newest._id} (${new Date(newest.generatedAt).toISOString().slice(0, 16)})`);
        console.log(`   plan items: ${items.length} total, ${replaceable.length} replaceable AI, ${duplicateCount(replaceable)} duplicate(s) among them`);
        console.log(`   after:      ${kept.length} kept + ${planned.length} rebuilt = ${kept.length + planned.length}`);
        console.log(`   diet advice rows: ${guidanceNow.length} → ${guidanceAfter.length}`);
        for (const g of guidanceAfter) console.log(`      • [${g.key}] ${g.directive}`);
        for (const i of kept.filter(isActiveDiet)) {
            console.log(`   kept diet item ${i._id}: source=${i.source} status=${i.status} created=${new Date(i.createdAt).toISOString().slice(0, 16)}`);
        }
        for (const i of replaceable.filter(isActiveDiet)) {
            console.log(`   AI diet item   ${i._id}: source=${i.source} status=${i.status} created=${new Date(i.createdAt).toISOString().slice(0, 16)}`);
        }

        if (apply) {
            const entry = { userId, before: replaceable, createdIds: [] };
            journal.push(entry);
            saveJournal();
            const result = await regeneratePlan({
                interpretation: newest.content,
                interpretationId: newest._id,
                user,
                products,
                professionals,
                ...sources,
            });
            entry.createdIds = result.created.map((c) => c._id);
            saveJournal();
            console.log(`   ✅ removed ${result.removedCount}, created ${result.created.length}`);
        }
        console.log('');
    }

    if (apply && journal.length) {
        console.log(`💾 Backup: ${backupFile}`);
        console.log(`   Undo with: node scripts/rebuildPlans.js --restore ${backupFile}\n`);
    }

    await mongoose.disconnect();
})().catch(async (e) => {
    console.error('❌', e);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
});
