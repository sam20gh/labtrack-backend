/**
 * Phase 3 backfill.
 *
 * The case that matters most is amendment recovery: a clinician's correction currently
 * lands on `DnaReport.aiInterpretation` while the patient-facing read looks at
 * `AIFeedback`, so those edits have never been visible. The migration is where they are
 * recovered, and if it silently misses them the defect survives the migration.
 */
const mongoose = require('mongoose');
const AIFeedback = require('../models/AIFeedback');
const Interpretation = require('../models/Interpretation');
const TestResult = require('../models/testResultModel');
const DnaReport = require('../models/DnaReport');
const { backfill } = require('../utils/interpretationBackfill');

const silent = () => {};
const userId = new mongoose.Types.ObjectId();

const result = (testType, date) => TestResult.create({
    patient: { user_id: userId, date_of_test: new Date(date), lab_name: 'Lab', test_type: testType },
    results: {},
});

const feedback = (testID, content, createdAt) => AIFeedback.create({
    userID: userId, testID, feedback: JSON.stringify(content), createdAt: new Date(createdAt),
});

describe('backfill', () => {
    it('migrates a test-result interpretation with its source recorded', async () => {
        const r = await result('Lipid Panel', '2026-06-09');
        await feedback(r._id, { summary: 'A read.' }, '2026-06-10');

        const stats = await backfill({ log: silent });
        expect(stats.migrated).toBe(1);

        const migrated = await Interpretation.findOne({ userId }).lean();
        expect(migrated.content.summary).toBe('A read.');
        expect(migrated.covers).toHaveLength(1);
        expect(migrated.covers[0].kind).toBe('test_result');
        expect(String(migrated.covers[0].id)).toBe(String(r._id));
        // Policy says everything needs review today.
        expect(migrated.review.status).toBe('pending');
    });

    it('recovers a clinician amendment the patient could never see', async () => {
        const aiContent = { summary: 'AI said moderate risk.', risks: [{ condition: 'X', level: 'moderate' }] };
        const corrected = { summary: 'Clinician corrected to low.', risks: [{ condition: 'X', level: 'low' }] };
        const professionalId = new mongoose.Types.ObjectId();

        const dna = await DnaReport.create({
            userId, labName: 'Genetics Co', mutations: [], status: 'specialist_reviewed',
            aiInterpretation: { summary: corrected.summary, raw: corrected, generatedAt: new Date('2026-06-10') },
            specialistReview: { professionalId, reviewedAt: new Date('2026-06-12'), approved: true, notes: 'Downgraded.' },
        });
        // AIFeedback still holds the *pre-amendment* text — that is the live defect.
        await feedback(dna._id, aiContent, '2026-06-10');

        const stats = await backfill({ log: silent });
        expect(stats.amendmentsRecovered).toBe(1);

        const migrated = await Interpretation.findOne({ userId }).lean();
        expect(migrated.review.status).toBe('amended');
        expect(String(migrated.review.professionalId)).toBe(String(professionalId));
        // Original preserved as the record of what the model actually said...
        expect(migrated.content.summary).toBe('AI said moderate risk.');
        // ...and the correction is what a patient will now read.
        expect(migrated.amended.content.summary).toBe('Clinician corrected to low.');
    });

    it('does not invent an amendment when the two copies agree', async () => {
        const content = { summary: 'Unchanged.' };
        const dna = await DnaReport.create({
            userId, labName: 'Genetics Co', mutations: [], status: 'ai_interpreted',
            aiInterpretation: { summary: content.summary, raw: content },
        });
        await feedback(dna._id, content, '2026-06-10');

        const stats = await backfill({ log: silent });
        expect(stats.amendmentsRecovered).toBe(0);
        expect((await Interpretation.findOne({ userId }).lean()).review.status).toBe('pending');
    });

    it('chains supersedes oldest to newest', async () => {
        const a = await result('Lipid Panel', '2026-01-09');
        const b = await result('Full Blood Count', '2026-06-09');
        await feedback(a._id, { summary: 'first' }, '2026-01-10');
        await feedback(b._id, { summary: 'second' }, '2026-06-10');

        await backfill({ log: silent });

        const all = await Interpretation.find({ userId }).sort({ generatedAt: 1 }).lean();
        expect(all).toHaveLength(2);
        expect(all[0].supersedes).toBeNull();
        expect(String(all[1].supersedes)).toBe(String(all[0]._id));
    });

    it('is safe to run twice', async () => {
        const r = await result('Lipid Panel', '2026-06-09');
        await feedback(r._id, { summary: 'A read.' }, '2026-06-10');

        const first = await backfill({ log: silent });
        const second = await backfill({ log: silent });

        expect(first.migrated).toBe(1);
        expect(second.migrated).toBe(0);
        expect(second.skipped).toBe(1);
        expect(await Interpretation.countDocuments({ userId })).toBe(1);
    });

    it('leaves an unparseable row in place rather than dropping it', async () => {
        await AIFeedback.create({ userID: userId, testID: new mongoose.Types.ObjectId(), feedback: 'not json{' });

        const stats = await backfill({ log: silent });
        expect(stats.unparseable).toBe(1);
        expect(stats.migrated).toBe(0);
        // Still there for a human to look at.
        expect(await AIFeedback.countDocuments({ userID: userId })).toBe(1);
    });

    it('migrates an orphaned interpretation with no covers rather than losing it', async () => {
        await feedback(new mongoose.Types.ObjectId(), { summary: 'Source deleted.' }, '2026-06-10');

        const stats = await backfill({ log: silent });
        expect(stats.orphaned).toBe(1);
        expect(stats.migrated).toBe(1);

        const migrated = await Interpretation.findOne({ userId }).lean();
        expect(migrated.covers).toHaveLength(0);
        expect(migrated.content.summary).toBe('Source deleted.');
    });

    it('writes nothing on a dry run', async () => {
        const r = await result('Lipid Panel', '2026-06-09');
        await feedback(r._id, { summary: 'A read.' }, '2026-06-10');

        const stats = await backfill({ dry: true, log: silent });
        expect(stats.migrated).toBe(1);
        expect(await Interpretation.countDocuments({})).toBe(0);
    });
});
