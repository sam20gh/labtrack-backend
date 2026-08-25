/**
 * Inspect the legacy `aifeedbacks` collection.
 *
 * Phase 6 removed the model and every read of it, but the collection itself is left in
 * place as an archive — deleting a store of medical text on the same day you stop reading
 * it leaves no way to answer "what did it say before?".
 *
 * Queries the raw collection through the driver, since there is no longer a model for it.
 * Read-only.
 */
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Interpretation = require('../models/Interpretation');

const run = async () => {
    await connectDB();

    const collections = await mongoose.connection.db.listCollections({ name: 'aifeedbacks' }).toArray();
    if (!collections.length) {
        console.log('No legacy aifeedbacks collection — nothing archived.');
        await mongoose.disconnect();
        return;
    }

    const legacy = mongoose.connection.db.collection('aifeedbacks');
    const [archived, migrated] = await Promise.all([
        legacy.countDocuments(),
        Interpretation.countDocuments({ migratedFrom: { $ne: null } }),
    ]);

    const migratedIds = new Set(
        (await Interpretation.find({ migratedFrom: { $ne: null } }).select('migratedFrom').lean())
            .map((i) => String(i.migratedFrom)),
    );
    const stranded = (await legacy.find({}, { projection: { _id: 1, userID: 1 } }).toArray())
        .filter((r) => !migratedIds.has(String(r._id)));

    console.log(`
Archived AIFeedback rows  ${archived}
  migrated to snapshots   ${migrated}
  never migrated          ${stranded.length}
`);

    if (stranded.length) {
        console.warn('⚠️  Never migrated — these are invisible to patients today:');
        for (const r of stranded) console.warn(`   ${r._id}  (user ${r.userID})`);
    } else {
        console.log('✅ Everything in the archive has a snapshot. The collection can be dropped when you are ready.');
    }

    await mongoose.disconnect();
};

run().catch(async (e) => { console.error('❌', e.message); await mongoose.disconnect(); process.exit(1); });
