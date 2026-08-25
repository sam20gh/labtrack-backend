/**
 * Specialist review on `Interpretation`.
 *
 * Two defects motivated moving the queue off `DnaReport`, and both are asserted here: a
 * blood-only patient could never enter the queue at all, and a clinician's amendment landed
 * somewhere the patient-facing read never looked.
 */
const mongoose = require('mongoose');
const Interpretation = require('../models/Interpretation');
const DnaReport = require('../models/DnaReport');
const TestResult = require('../models/testResultModel');
const User = require('../models/userModel');
const { getQueue, submitReview, getReportForReview } = require('../controllers/reviewController');
const { presentToPatient } = require('../config/clinicalPolicy');

const mockRes = () => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    res.set = jest.fn().mockReturnValue(res);
    return res;
};

const professionalId = new mongoose.Types.ObjectId();

const patient = async (suffix) => (await User.create({
    username: `p${suffix}`, email: `p${suffix}@x.co`, password: 'x',
    firstName: 'Pat', lastName: String(suffix), dob: '1985-03-14',
}))._id;

const AI = {
    summary: 'Cardiometabolic pattern, moderate risk.',
    risks: [{ condition: 'Prediabetes', level: 'moderate', basis: 'biomarker', rationale: 'HbA1c 5.69.' }],
};

describe('getQueue', () => {
    it('includes a blood-only patient, which the old DnaReport queue could not', async () => {
        const userId = await patient(1);
        const r = await TestResult.create({
            patient: { user_id: userId, date_of_test: new Date('2026-06-09'), lab_name: 'Lab', test_type: 'Lipid Panel' },
            results: {},
        });
        await Interpretation.create({
            userId, content: AI, review: { status: 'pending' },
            covers: [{ kind: 'test_result', id: r._id, date: new Date('2026-06-09') }],
        });

        const res = mockRes();
        await getQueue({ auth: { userId: String(professionalId) } }, res);
        const body = res.json.mock.calls[0][0];

        expect(body.count).toBe(1);
        expect(body.interpretations[0].sourceKinds).toEqual(['test_result']);
        expect(body.interpretations[0].mutationCount).toBe(0);
    });

    it('surfaces pathogenic and high-risk counts so urgent cases can be picked first', async () => {
        const userId = await patient(2);
        const dna = await DnaReport.create({
            userId, labName: 'Genetics Co',
            mutations: [
                { gene: 'BRCA1', significance: 'pathogenic' },
                { gene: 'APOE', significance: 'vus' },
            ],
        });
        await Interpretation.create({
            userId,
            content: { ...AI, risks: [{ condition: 'Breast cancer', level: 'high', basis: 'genetic', rationale: 'BRCA1.' }] },
            review: { status: 'pending' },
            covers: [{ kind: 'dna_report', id: dna._id }],
        });

        const res = mockRes();
        await getQueue({ auth: { userId: String(professionalId) } }, res);
        const row = res.json.mock.calls[0][0].interpretations[0];

        expect(row.mutationCount).toBe(2);
        expect(row.pathogenicCount).toBe(1);
        expect(row.highRiskCount).toBe(1);
    });

    it('leaves reviewed interpretations out of the queue', async () => {
        const userId = await patient(3);
        await Interpretation.create({ userId, content: AI, review: { status: 'approved' } });

        const res = mockRes();
        await getQueue({ auth: { userId: String(professionalId) } }, res);
        expect(res.json.mock.calls[0][0].count).toBe(0);
    });
});

describe('submitReview', () => {
    const submit = async (id, body) => {
        const res = mockRes();
        await submitReview({ auth: { userId: String(professionalId) }, params: { reportId: String(id) }, body }, res);
        return res;
    };

    it('approves without edits and leaves the AI text as the patient read', async () => {
        const userId = await patient(4);
        const i = await Interpretation.create({ userId, content: AI, review: { status: 'pending' } });

        const res = await submit(i._id, { approved: true, notes: 'Concur.' });
        expect(res.json.mock.calls[0][0].amendmentCount).toBe(0);

        const saved = await Interpretation.findById(i._id).lean();
        expect(saved.review.status).toBe('approved');
        expect(presentToPatient(saved).content.summary).toBe(AI.summary);
    });

    it('amends, keeps the original, and the amendment is what the patient reads', async () => {
        const userId = await patient(5);
        const i = await Interpretation.create({ userId, content: AI, review: { status: 'pending' } });

        const res = await submit(i._id, {
            approved: true,
            notes: 'Downgraded on review.',
            amendments: { summary: 'Clinician: low risk, repeat in 12 months.' },
        });
        expect(res.json.mock.calls[0][0].amendmentCount).toBe(1);

        const saved = await Interpretation.findById(i._id).lean();
        expect(saved.review.status).toBe('amended');
        // The record of what the model actually said is preserved...
        expect(saved.content.summary).toBe(AI.summary);
        // ...and the correction is what reaches the patient. This is the defect being fixed.
        expect(presentToPatient(saved).content.summary).toBe('Clinician: low risk, repeat in 12 months.');
        expect(saved.review.edits[0].previous).toBe(AI.summary);
    });

    it('builds a second review on the first rather than reverting it', async () => {
        const userId = await patient(6);
        const i = await Interpretation.create({ userId, content: AI, review: { status: 'pending' } });

        await submit(i._id, { approved: true, amendments: { summary: 'First correction.' } });
        await submit(i._id, { approved: true, amendments: { follow_up: 'Repeat in 6 months.' } });

        const saved = await Interpretation.findById(i._id).lean();
        // The first clinician's change survives the second review.
        expect(saved.amended.content.summary).toBe('First correction.');
        expect(saved.amended.content.follow_up).toBe('Repeat in 6 months.');
        expect(saved.review.edits).toHaveLength(2);
    });

    it('rejects a body without an explicit approved flag', async () => {
        const userId = await patient(7);
        const i = await Interpretation.create({ userId, content: AI, review: { status: 'pending' } });

        const res = await submit(i._id, { notes: 'looks fine' });
        expect(res.status).toHaveBeenCalledWith(400);
    });

    it('advances the DNA report status without copying the interpretation onto it', async () => {
        const userId = await patient(8);
        const dna = await DnaReport.create({ userId, labName: 'Genetics Co', mutations: [], status: 'ai_interpreted' });
        const i = await Interpretation.create({
            userId, content: AI, review: { status: 'pending' },
            covers: [{ kind: 'dna_report', id: dna._id }],
        });

        await submit(i._id, { approved: true, amendments: { summary: 'Corrected.' } });

        const savedDna = await DnaReport.findById(dna._id).lean();
        // The status still gates gene-adjusted reference ranges, so it is kept current...
        expect(savedDna.status).toBe('specialist_reviewed');
        expect(savedDna.specialistReview.approved).toBe(true);
        // ...but the interpretation is no longer duplicated here. Two copies that could
        // drift is precisely the defect this migration removed.
        expect(savedDna.aiInterpretation?.summary).toBeUndefined();
        expect(presentToPatient(await Interpretation.findById(i._id).lean()).content.summary).toBe('Corrected.');
    });
});

describe('getReportForReview', () => {
    it('returns the sources the interpretation read, and the previous read', async () => {
        const userId = await patient(9);
        const r = await TestResult.create({
            patient: { user_id: userId, date_of_test: new Date('2026-06-09'), lab_name: 'Lab', test_type: 'Lipid Panel' },
            results: {},
        });
        const first = await Interpretation.create({ userId, content: { summary: 'Earlier read.' } });
        const second = await Interpretation.create({
            userId, content: AI, supersedes: first._id, review: { status: 'pending' },
            covers: [{ kind: 'test_result', id: r._id }],
        });

        const res = mockRes();
        await getReportForReview({ auth: { userId: String(professionalId) }, params: { reportId: String(second._id) } }, res);
        const body = res.json.mock.calls[0][0];

        expect(body.sources.testResults[0].patient.test_type).toBe('Lipid Panel');
        // So an amendment can be judged against what changed, not in isolation.
        expect(body.previous.content.summary).toBe('Earlier read.');
    });
});
