/**
 * W4 — operations: SLA, assignment, metrics, and the access-log viewer.
 *
 * Three of these are the sort of thing that looks obviously right and is quietly wrong:
 *
 *  - an SLA clock that restarts when somebody opens the case, so a breach can be cleared by
 *    looking at it;
 *  - an amendment rate that reads 0% when nothing has been reviewed, which says the model is
 *    never corrected rather than that nobody has checked;
 *  - a claim that guards nothing, so two clinicians review the same case and the second
 *    sign-off lands on top of the first.
 *
 * Each has a test here that fails if it is reintroduced.
 */
const mongoose = require('mongoose');
const User = require('../models/userModel');
const Professional = require('../models/Professional');
const Interpretation = require('../models/Interpretation');
const AccessLog = require('../models/AccessLog');
const { slaFor, slaOrder } = require('../utils/reviewSla');
const { computeReviewMetrics } = require('../utils/reviewMetrics');
const { toCsv } = require('../utils/csv');
const {
    getQueue, claimReview, releaseReview, submitReview, getReviewMetrics,
} = require('../controllers/reviewController');
const { getAccessLog, exportAccessLog } = require('../controllers/staffController');

const mockRes = () => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    res.send = jest.fn().mockReturnValue(res);
    res.setHeader = jest.fn().mockReturnValue(res);
    return res;
};

const HOUR = 3_600_000;
const hoursAgo = (h) => new Date(Date.now() - h * HOUR);

const CONTENT = {
    summary: 'Cardiometabolic pattern.',
    risks: [{ condition: 'Prediabetes', level: 'moderate', basis: 'biomarker', rationale: 'HbA1c.' }],
};
const HIGH_RISK_CONTENT = {
    summary: 'Marked dyslipidaemia.',
    risks: [{ condition: 'CVD', level: 'high', basis: 'biomarker', rationale: 'LDL.' }],
};

const patientFor = async (suffix) => (await User.create({
    username: `qpt${suffix}`,
    email: `qpt${suffix}@example.com`,
    password: 'x',
    firstName: 'Queue',
    lastName: `Patient${suffix}`,
    dob: '1985-03-14',
}))._id;

const clinician = (id, email = 'doc@example.com') => ({
    userId: String(id), role: 'professional', email,
});
const administrator = (id) => ({ userId: String(id), role: 'admin', email: 'admin@example.com' });

/* ------------------------------------------------------------------ the SLA table */

describe('reviewSla', () => {
    it('measures from when the interpretation was generated, not from when it was opened', () => {
        // The whole point: a case that has been waiting six days is late whether or not
        // anybody has looked at it, and looking at it must not reset the clock.
        const sla = slaFor({ generatedAt: hoursAgo(144) });
        expect(sla.state).toBe('breached');
        expect(sla.hoursWaiting).toBeGreaterThan(140);
    });

    it('gives a high-risk finding the shorter target', () => {
        const routine = slaFor({ generatedAt: hoursAgo(30) });
        const urgent = slaFor({ generatedAt: hoursAgo(30), highRiskCount: 1 });

        expect(urgent.targetHours).toBeLessThan(routine.targetHours);
        expect(urgent.priority).toBe('urgent');
        // Same age, different verdict — which is the reason priority exists at all.
        expect(routine.state).toBe('on_track');
        expect(urgent.state).toBe('breached');
    });

    it('treats a pathogenic variant the same way, without needing a high-risk read', () => {
        expect(slaFor({ generatedAt: hoursAgo(1), pathogenicCount: 2 }).priority).toBe('urgent');
    });

    it('never lets a rule lengthen a target', () => {
        // Every matching rule is considered and the shortest wins, so adding one can only
        // ever make a case more urgent.
        const urgent = slaFor({ generatedAt: hoursAgo(1), highRiskCount: 3, pathogenicCount: 5 });
        expect(urgent.targetHours).toBe(24);
    });

    it('flags due_soon before the target rather than at it', () => {
        const sla = slaFor({ generatedAt: hoursAgo(20), highRiskCount: 1 });
        expect(sla.state).toBe('due_soon');
        expect(sla.hoursRemaining).toBeGreaterThan(0);
    });

    it('reports an unusable date as unknown, never as zero hours waiting', () => {
        // Zero would sort an undated row to the safe end of every queue, and an undated row
        // is the one most likely to be old.
        const sla = slaFor({ generatedAt: undefined });
        expect(sla.state).toBe('unknown');
        expect(sla.hoursWaiting).toBeNull();
        expect(sla.dueAt).toBeNull();
    });

    it('carries a breach as a state with the hours it is over by', () => {
        const sla = slaFor({ generatedAt: hoursAgo(48), highRiskCount: 1 });
        expect(sla.state).toBe('breached');
        expect(sla.hoursOverdue).toBeGreaterThan(23);
        expect(sla.hoursRemaining).toBe(0);
    });

    it('sorts the most overdue first and unknowns before everything', () => {
        const rows = [
            slaFor({ generatedAt: hoursAgo(1) }),
            slaFor({ generatedAt: hoursAgo(200) }),
            slaFor({ generatedAt: null }),
        ].sort((a, b) => slaOrder(a) - slaOrder(b));

        expect(rows[0].state).toBe('unknown');
        expect(rows[1].hoursOverdue).toBeGreaterThan(0);
        expect(rows[2].state).toBe('on_track');
    });
});

/* ------------------------------------------------------------------- the metrics */

describe('computeReviewMetrics', () => {
    const signed = (hoursToReview, status = 'approved', edits = []) => ({
        generatedAt: hoursAgo(hoursToReview + 10),
        review: {
            status,
            reviewedAt: hoursAgo(10),
            professionalId: 'p1',
            edits,
        },
    });

    it('returns null, not zero, when nothing has been reviewed', () => {
        const m = computeReviewMetrics([], []);
        // 0% would say the model is never corrected. Null says nobody has checked.
        expect(m.amendments.rate).toBeNull();
        expect(m.turnaround.medianHours).toBeNull();
        expect(m.signedCount).toBe(0);
    });

    it('reports a median and a p90 rather than a mean', () => {
        const m = computeReviewMetrics([signed(1), signed(2), signed(3), signed(100)], []);
        // A mean here would be ~26h. The median says what a typical patient waits.
        expect(m.turnaround.medianHours).toBeLessThan(10);
        expect(m.turnaround.p90Hours).toBeGreaterThan(50);
    });

    it('excludes an impossible turnaround instead of counting it as instant', () => {
        const broken = {
            generatedAt: hoursAgo(1),
            review: { status: 'approved', reviewedAt: hoursAgo(50), professionalId: 'p1' },
        };
        const m = computeReviewMetrics([signed(6), broken], []);

        expect(m.turnaround.measured).toBe(1);
        expect(m.turnaround.unusable).toBe(1);
        // Counting it as 0h would have halved the reported median for free.
        expect(m.turnaround.medianHours).toBeGreaterThan(5);
    });

    it('counts which fields clinicians actually change — the feedback into the prompt', () => {
        const m = computeReviewMetrics([
            signed(2, 'amended', [{ field: 'summary' }, { field: 'risks' }]),
            signed(3, 'amended', [{ field: 'summary' }]),
            signed(4),
        ], []);

        expect(m.amendments.amendedCount).toBe(2);
        expect(m.amendments.rate).toBeCloseTo(66.7, 0);
        expect(m.amendments.byField[0]).toEqual({ field: 'summary', count: 2 });
    });

    it('reports the backlog by wait, with null when the queue is empty', () => {
        const empty = computeReviewMetrics([], []);
        expect(empty.backlog.pendingCount).toBe(0);
        expect(empty.backlog.oldestWaitingHours).toBeNull();

        const busy = computeReviewMetrics([], [
            { generatedAt: hoursAgo(4) },
            { generatedAt: hoursAgo(200) },
        ]);
        expect(busy.backlog.oldestWaitingHours).toBeGreaterThan(190);
    });

    it('groups by clinician without inventing a rate for one who has signed nothing', () => {
        const m = computeReviewMetrics([
            { ...signed(2), review: { ...signed(2).review, professionalId: 'a' } },
            { ...signed(4, 'amended', [{ field: 'follow_up' }]), review: { ...signed(4, 'amended').review, professionalId: 'b', status: 'amended', edits: [{ field: 'follow_up' }] } },
        ], []);

        expect(m.byClinician).toHaveLength(2);
        for (const c of m.byClinician) expect(c.signed).toBeGreaterThan(0);
    });
});

/* ------------------------------------------------------------------------ the CSV */

describe('csv export', () => {
    it('quotes commas, quotes and newlines', () => {
        const out = toCsv([{ key: 'a', label: 'A' }], [{ a: 'one, "two"\nthree' }]);
        expect(out).toContain('"one, ""two""\nthree"');
    });

    it('neutralises a formula so a spreadsheet does not execute it on open', () => {
        // Names and emails are user-controlled, so an export is otherwise a way to hand an
        // administrator a file that runs somebody else's formula.
        const out = toCsv([{ key: 'a', label: 'A' }], [{ a: '=1+1' }]);
        expect(out).toContain("'=1+1");
        expect(out).not.toMatch(/(^|,)=1\+1/m);
    });
});

/* ---------------------------------------------------------------------- the queue */

describe('the review queue', () => {
    const seed = async () => {
        const [p1, p2] = await Promise.all([patientFor(1), patientFor(2)]);
        const stale = await Interpretation.create({
            userId: p1, content: HIGH_RISK_CONTENT, generatedAt: hoursAgo(200),
            review: { status: 'pending' },
        });
        const fresh = await Interpretation.create({
            userId: p2, content: CONTENT, generatedAt: hoursAgo(2),
            review: { status: 'pending' },
        });
        return { p1, p2, stale, fresh };
    };

    it('carries the SLA on every row, computed server-side', async () => {
        await seed();
        const res = mockRes();
        await getQueue({ auth: clinician(new mongoose.Types.ObjectId()), query: {} }, res);

        const rows = res.json.mock.calls[0][0].interpretations;
        expect(rows).toHaveLength(2);
        for (const row of rows) expect(row.sla.state).toBeDefined();
        expect(res.json.mock.calls[0][0].counts.breached).toBe(1);
    });

    it('filters to breached cases without changing what may be seen', async () => {
        await seed();
        const res = mockRes();
        await getQueue({ auth: clinician(new mongoose.Types.ObjectId()), query: { sla: 'breached' } }, res);

        const body = res.json.mock.calls[0][0];
        expect(body.interpretations).toHaveLength(1);
        expect(body.interpretations[0].sla.state).toBe('breached');
    });

    it('filters by assignment, and says which rows are mine', async () => {
        const { stale } = await seed();
        const me = new mongoose.Types.ObjectId();

        await claimReview({ auth: clinician(me), params: { reportId: stale._id }, body: {} }, mockRes());

        const mineRes = mockRes();
        await getQueue({ auth: clinician(me), query: { assignment: 'mine' } }, mineRes);
        expect(mineRes.json.mock.calls[0][0].interpretations).toHaveLength(1);
        expect(mineRes.json.mock.calls[0][0].interpretations[0].assignedToMe).toBe(true);

        const freeRes = mockRes();
        await getQueue({ auth: clinician(me), query: { assignment: 'unclaimed' } }, freeRes);
        expect(freeRes.json.mock.calls[0][0].interpretations).toHaveLength(1);
        expect(freeRes.json.mock.calls[0][0].interpretations[0].assignedTo).toBeNull();
    });

    it('searches by patient name', async () => {
        await seed();
        const res = mockRes();
        await getQueue({ auth: clinician(new mongoose.Types.ObjectId()), query: { q: 'Patient2' } }, res);
        expect(res.json.mock.calls[0][0].interpretations).toHaveLength(1);
    });

    it('logs one entry with a count, not one per patient', async () => {
        await seed();
        const me = new mongoose.Types.ObjectId();
        await getQueue({ auth: clinician(me), query: {} }, mockRes());

        const entries = await AccessLog.find({ resource: 'queue' }).lean();
        expect(entries).toHaveLength(1);
        expect(entries[0].count).toBe(2);
        expect(entries[0].patientId).toBeUndefined();
    });
});

/* ----------------------------------------------------------------- claim / release */

describe('claiming a case', () => {
    const pending = async () => Interpretation.create({
        userId: await patientFor(9), content: CONTENT, review: { status: 'pending' },
    });

    it('records the claim against the acting clinician', async () => {
        const row = await pending();
        const me = new mongoose.Types.ObjectId();
        const res = mockRes();

        await claimReview({ auth: clinician(me), params: { reportId: row._id }, body: {} }, res);

        const after = await Interpretation.findById(row._id).lean();
        expect(String(after.review.assignedTo)).toBe(String(me));
        expect(after.review.assignedAt).toBeInstanceOf(Date);
    });

    it('attributes the claim to the linked Professional where one exists', async () => {
        // The same rule sign-off follows, so a claim and the sign-off after it name one actor.
        const row = await pending();
        const userId = new mongoose.Types.ObjectId();
        const professional = await Professional.create({
            userId,
            firstname: 'Ada',
            lastname: 'Chen',
            username: `ada${Date.now()}`,
            password: 'hashed',
            dob: new Date('1980-01-01'),
            address: '1 Road',
            postcode: 'E1 1AA',
            country: 'UK',
            speciality: ['Cardiology'],
            hourly_rate: 100,
            profile_image: 'https://imagedelivery.net/x/y/public',
            description: 'A clinician.',
        });

        await claimReview({ auth: clinician(userId), params: { reportId: row._id }, body: {} }, mockRes());

        const after = await Interpretation.findById(row._id).lean();
        expect(String(after.review.assignedTo)).toBe(String(professional._id));
    });

    it('refuses a case another clinician is holding', async () => {
        const row = await pending();
        await claimReview({ auth: clinician(new mongoose.Types.ObjectId()), params: { reportId: row._id }, body: {} }, mockRes());

        const res = mockRes();
        await claimReview({ auth: clinician(new mongoose.Types.ObjectId()), params: { reportId: row._id }, body: {} }, res);

        expect(res.status).toHaveBeenCalledWith(409);
        expect(res.json.mock.calls[0][0].takeoverAvailableInHours).toBeGreaterThan(0);
    });

    it('lets anyone take over a claim that has gone stale', async () => {
        // The failure this prevents: a case parked forever because whoever opened it went
        // on leave.
        const row = await pending();
        const first = new mongoose.Types.ObjectId();
        await Interpretation.findByIdAndUpdate(row._id, {
            'review.assignedTo': first,
            'review.assignedAt': hoursAgo(30),
        });

        const second = new mongoose.Types.ObjectId();
        const res = mockRes();
        await claimReview({ auth: clinician(second), params: { reportId: row._id }, body: {} }, res);

        expect(res.status).not.toHaveBeenCalledWith(409);
        expect(res.json.mock.calls[0][0].tookOverFrom).toBe(String(first));
    });

    it('will not claim a case that has already been reviewed', async () => {
        const row = await Interpretation.create({
            userId: await patientFor(11), content: CONTENT,
            review: { status: 'approved', reviewedAt: new Date() },
        });
        const res = mockRes();
        await claimReview({ auth: clinician(new mongoose.Types.ObjectId()), params: { reportId: row._id }, body: {} }, res);
        expect(res.status).toHaveBeenCalledWith(409);
    });

    it('lets the holder release, refuses another clinician, allows an admin', async () => {
        const row = await pending();
        const holder = new mongoose.Types.ObjectId();
        await claimReview({ auth: clinician(holder), params: { reportId: row._id }, body: {} }, mockRes());

        const stranger = mockRes();
        await releaseReview({ auth: clinician(new mongoose.Types.ObjectId()), params: { reportId: row._id } }, stranger);
        expect(stranger.status).toHaveBeenCalledWith(403);

        const admin = mockRes();
        await releaseReview({ auth: administrator(new mongoose.Types.ObjectId()), params: { reportId: row._id } }, admin);
        expect((await Interpretation.findById(row._id).lean()).review.assignedTo).toBeNull();
    });
});

describe('sign-off and the claim', () => {
    const pending = async () => Interpretation.create({
        userId: await patientFor(21), content: CONTENT, review: { status: 'pending' },
    });

    it('refuses a sign-off on a case another clinician is holding', async () => {
        // Without this, two clinicians each spend an hour on the same case and the second
        // sign-off appends its edits to the first's, with the record naming both.
        const row = await pending();
        await claimReview({ auth: clinician(new mongoose.Types.ObjectId()), params: { reportId: row._id }, body: {} }, mockRes());

        const res = mockRes();
        await submitReview({
            auth: clinician(new mongoose.Types.ObjectId()),
            params: { reportId: row._id },
            body: { approved: true, notes: 'Looks right' },
        }, res);

        expect(res.status).toHaveBeenCalledWith(409);
        expect((await Interpretation.findById(row._id).lean()).review.status).toBe('pending');
    });

    it('lets the holder sign off, and clears the claim when they do', async () => {
        const row = await pending();
        const me = new mongoose.Types.ObjectId();
        await claimReview({ auth: clinician(me), params: { reportId: row._id }, body: {} }, mockRes());

        await submitReview({
            auth: clinician(me),
            params: { reportId: row._id },
            body: { approved: true, notes: 'Agreed' },
        }, mockRes());

        const after = await Interpretation.findById(row._id).lean();
        expect(after.review.status).toBe('approved');
        // A signed case that still reads as held would make "who has this open" meaningless.
        expect(after.review.assignedTo).toBeNull();
    });

    it('lets an admin sign off over a claim', async () => {
        const row = await pending();
        await claimReview({ auth: clinician(new mongoose.Types.ObjectId()), params: { reportId: row._id }, body: {} }, mockRes());

        await submitReview({
            auth: administrator(new mongoose.Types.ObjectId()),
            params: { reportId: row._id },
            body: { approved: true },
        }, mockRes());

        expect((await Interpretation.findById(row._id).lean()).review.status).toBe('approved');
    });
});

/* ------------------------------------------------------------------ metrics route */

describe('GET /reviews/metrics', () => {
    it('reports the backlog with the same SLA table the queue uses', async () => {
        await Interpretation.create({
            userId: await patientFor(31), content: HIGH_RISK_CONTENT,
            generatedAt: hoursAgo(100), review: { status: 'pending' },
        });
        await Interpretation.create({
            userId: await patientFor(32), content: CONTENT,
            generatedAt: hoursAgo(60), review: { status: 'approved', reviewedAt: hoursAgo(50), professionalId: new mongoose.Types.ObjectId() },
        });

        const res = mockRes();
        await getReviewMetrics({ auth: clinician(new mongoose.Types.ObjectId()), query: {} }, res);
        const body = res.json.mock.calls[0][0];

        expect(body.backlog.pendingCount).toBe(1);
        expect(body.backlog.sla.breached).toBe(1);
        expect(body.signedCount).toBe(1);
        expect(body.turnaround.medianHours).toBeGreaterThan(9);
    });

    it('writes no access-log entry — it reads no patient content', async () => {
        await getReviewMetrics({ auth: clinician(new mongoose.Types.ObjectId()), query: {} }, mockRes());
        expect(await AccessLog.countDocuments({})).toBe(0);
    });
});

/* -------------------------------------------------------------- the access log UI */

describe('the access-log viewer', () => {
    const seedLog = async () => {
        const patientId = await patientFor(41);
        const actorId = new mongoose.Types.ObjectId();
        await AccessLog.create([
            { actorId, actorEmail: 'a@x.com', actorRole: 'professional', patientId, resource: 'patient_context', at: hoursAgo(2) },
            { actorId, actorEmail: 'a@x.com', actorRole: 'professional', resource: 'queue', count: 7, at: hoursAgo(3) },
            { actorId: new mongoose.Types.ObjectId(), actorEmail: 'b@x.com', actorRole: 'admin', patientId, resource: 'interpretation', at: hoursAgo(4) },
        ]);
        return { patientId, actorId };
    };

    it('answers "everyone who looked at this patient"', async () => {
        const { patientId } = await seedLog();
        const res = mockRes();
        await getAccessLog({ auth: administrator(new mongoose.Types.ObjectId()), query: { patientId: String(patientId) } }, res, jest.fn());

        const body = res.json.mock.calls[0][0];
        expect(body.total).toBe(2);
        expect(body.entries.map((e) => e.actorEmail).sort()).toEqual(['a@x.com', 'b@x.com']);
        // The log stores ids; the name is joined at read time so a correction is not stale.
        expect(body.entries[0].patientName).toContain('Queue');
    });

    it('answers "everything this clinician looked at"', async () => {
        const { actorId } = await seedLog();
        const res = mockRes();
        await getAccessLog({ auth: administrator(new mongoose.Types.ObjectId()), query: { actorId: String(actorId) } }, res, jest.fn());
        expect(res.json.mock.calls[0][0].total).toBe(2);
    });

    it('records that the log itself was read', async () => {
        // The administrator reading it is the account with no other check on it.
        await seedLog();
        const admin = new mongoose.Types.ObjectId();
        await getAccessLog({ auth: administrator(admin), query: {} }, mockRes(), jest.fn());

        const own = await AccessLog.find({ resource: 'access_log' }).lean();
        expect(own).toHaveLength(1);
        expect(String(own[0].actorId)).toBe(String(admin));
        expect(own[0].count).toBe(3);
    });

    it('exports CSV of the same filter, with a header and no clinical content', async () => {
        const { patientId } = await seedLog();
        const res = mockRes();
        await exportAccessLog({ auth: administrator(new mongoose.Types.ObjectId()), query: { patientId: String(patientId) } }, res, jest.fn());

        const csv = res.send.mock.calls[0][0];
        expect(csv.split('\r\n')[0]).toContain('Patient id');
        expect(csv).toContain('a@x.com');
        // Identifiers only. Nothing here says what any record contained.
        expect(csv).not.toMatch(/Cardiometabolic|Prediabetes/);
        expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv; charset=utf-8');
    });
});
