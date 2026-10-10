const Specimen = require('../models/Specimen');
const Order = require('../models/Order');
const User = require('../models/userModel');
const TestResult = require('../models/testResultModel');
const DnaReport = require('../models/DnaReport');
const LabMessage = require('../models/LabMessage');
const { LABS, secretsFromEnv, verifySignature } = require('../utils/labs');
const collection = require('../utils/collectionCentre');
const { persistMeasurements } = require('./biomarkerController');
const { advanceComponent } = require('./orderController');
const { publish } = require('../utils/notificationCentre');

/**
 * The laboratories' API — samples received, rejected, being processed, and their results.
 * The contract is docs/LAB-INTEGRATION.md; the short version:
 *
 *   - **Signed, not logged in.** Each lab signs every request (`utils/labs.verifySignature`);
 *     there is no token and no session. The route is mounted on the raw body for that reason.
 *   - **Our barcode is the only key.** A lab never sends, and never needs, a name or an email.
 *     A barcode we do not know, *or one destined for a different lab*, answers the same 404 —
 *     telling a lab a tube exists elsewhere tells it something about somebody.
 *   - **Every message is answered once.** Keyed on `(lab, eventId | resultId)` in `LabMessage`:
 *     a retry gets the first answer back and changes nothing.
 *   - **A result goes through the same doors as a portal upload**: `persistMeasurements` for
 *     blood, a `DnaReport` for DNA, then `advanceComponent`, which tells the customer and re-runs
 *     their analysis. No second route into the record.
 */

const fail = (status, message, reason) => ({ status, body: { message, reason } });
const ok = (status, body) => ({ status, body });

/** The tube, if it exists and is this lab's. Anything else is the same not-found. */
const tubeFor = async (lab, barcode) => {
    const code = collection.normaliseBarcode(barcode);
    if (!code) return null;
    const specimen = await Specimen.findOne({ barcode: code });
    if (!specimen) return null;
    if (specimen.lab && specimen.lab !== lab) return null;
    if (!specimen.lab && !LABS[lab].kinds.includes(specimen.kind)) return null;
    return specimen;
};

const componentOf = async (specimen) => {
    const order = await Order.findById(specimen.orderId);
    const component = order?.items.id(specimen.itemId)?.components?.find((c) => String(c._id) === String(specimen.componentId));
    return { order, component };
};

/** Make sure the tube is "at the lab" before anything later happens to it. */
const ensureReceived = async (specimen, lab) => {
    if (['collected', 'in_transit'].includes(specimen.status)) {
        await collection.receiveSpecimen({ barcode: specimen.barcode, by: `lab:${lab}` });
        return Specimen.findById(specimen._id);
    }
    return specimen;
};

// ── Events ───────────────────────────────────────────────────────────────────

const handleEvent = async (lab, body) => {
    const { type, barcode, accession, reason } = body;
    if (!['received', 'processing', 'rejected'].includes(type)) {
        return fail(422, 'type must be received, processing or rejected.', 'invalid');
    }
    let specimen = await tubeFor(lab, barcode);
    if (!specimen) return fail(404, 'No sample with that barcode for this laboratory.', 'unknown');
    if (accession && !specimen.accession) {
        specimen.accession = String(accession).slice(0, 80);
        await specimen.save();
    }

    if (type === 'received') {
        if (specimen.status === 'rejected') return fail(409, 'That sample was rejected.', 'state');
        specimen = await ensureReceived(specimen, lab);
        return ok(200, { barcode: specimen.barcode, status: specimen.status });
    }

    if (type === 'processing') {
        if (['rejected', 'resulted'].includes(specimen.status)) return fail(409, `That sample is already ${specimen.status}.`, 'state');
        specimen = await ensureReceived(specimen, lab);
        if (specimen.status !== 'processing') {
            specimen.status = 'processing';
            specimen.events.push({ type: 'processing', at: new Date(), by: `lab:${lab}` });
            await specimen.save();
            const { order, component } = await componentOf(specimen);
            if (component?.status === 'sample_received') {
                await advanceComponent({ order, component, status: 'processing', note: `Processing at ${LABS[lab].name}` });
            }
        }
        return ok(200, { barcode: specimen.barcode, status: specimen.status });
    }

    // Rejected: the tube cannot be tested. The kit goes back to waiting for a new sample, and the
    // customer is asked for one — the same path a sample not taken at the door follows.
    if (specimen.status === 'resulted') return fail(409, 'That sample has already been resulted.', 'state');
    if (specimen.status !== 'rejected') {
        specimen.status = 'rejected';
        specimen.rejectedReason = String(reason || '').slice(0, 200) || undefined;
        specimen.events.push({ type: 'rejected', at: new Date(), by: `lab:${lab}`, note: specimen.rejectedReason });
        await specimen.save();
        const { order, component } = await componentOf(specimen);
        if (component && component.status !== 'resulted') {
            component.status = 'placed';
            component.statusHistory.push({ status: 'placed', at: new Date(), note: `Sample rejected by ${LABS[lab].name}${specimen.rejectedReason ? `: ${specimen.rejectedReason}` : ''}` });
            await order.save();
            if (order.userId) {
                const visit = component.method === 'home_collection';
                publish(String(order.userId), {
                    category: 'order',
                    title: 'We need a new sample',
                    body: `The laboratory could not use your ${specimen.kind === 'dna' ? 'DNA' : 'blood'} sample. ${visit ? 'Book a new collection visit' : 'We will send you a new kit'} — there is no extra charge.`,
                    route: visit ? `/collection/book?orderId=${order._id}` : `/order-details?orderId=${order._id}`,
                    dedupeKey: `specimen:${specimen._id}:rejected`,
                    source: 'lab',
                });
            }
        }
    }
    return ok(200, { barcode: specimen.barcode, status: 'rejected' });
};

// ── Results ──────────────────────────────────────────────────────────────────

const ZYGOSITY = ['heterozygous', 'homozygous', 'hemizygous', 'unknown'];
const SIGNIFICANCE = ['pathogenic', 'likely_pathogenic', 'vus', 'likely_benign', 'benign', 'unknown'];

/** Every analyte checked; the whole list of faults is returned, not just the first. */
const cleanAnalytes = (analytes) => {
    const errors = [];
    const out = [];
    (Array.isArray(analytes) ? analytes : []).forEach((a, i) => {
        const name = String(a?.name || '').trim();
        const value = Number(a?.value);
        if (!name) errors.push(`analytes[${i}].name is required`);
        if (!Number.isFinite(value)) errors.push(`analytes[${i}].value must be a number`);
        if (!name || !Number.isFinite(value)) return;
        const min = Number.isFinite(Number(a.refLow)) && a.refLow !== null ? Number(a.refLow) : undefined;
        const max = Number.isFinite(Number(a.refHigh)) && a.refHigh !== null ? Number(a.refHigh) : undefined;
        out.push({
            name,
            value,
            unit: a.unit ? String(a.unit).slice(0, 30) : undefined,
            code: a.code ? String(a.code).slice(0, 30) : undefined,
            reportedRange: (min !== undefined || max !== undefined || a.refText)
                ? { min, max, raw: a.refText ? String(a.refText).slice(0, 80) : [min, max].filter((x) => x !== undefined).join('–') || undefined }
                : undefined,
        });
    });
    if (!out.length && !errors.length) errors.push('analytes must list at least one result');
    return { errors, analytes: out };
};

const cleanVariants = (variants) => {
    const errors = [];
    const out = [];
    if (!Array.isArray(variants)) return { errors: ['variants must be a list (empty when nothing is reportable)'], variants: [] };
    variants.forEach((v, i) => {
        const gene = String(v?.gene || '').trim();
        if (!gene) { errors.push(`variants[${i}].gene is required`); return; }
        out.push({
            gene,
            variant: v.variant ? String(v.variant).slice(0, 80) : undefined,
            rsid: v.rsid ? String(v.rsid).slice(0, 30) : undefined,
            zygosity: ZYGOSITY.includes(v.zygosity) ? v.zygosity : 'unknown',
            significance: SIGNIFICANCE.includes(v.classification) ? v.classification : 'unknown',
            condition: v.condition ? String(v.condition).slice(0, 160) : undefined,
        });
    });
    return { errors, variants: out };
};

const handleResult = async (lab, body) => {
    let specimen = await tubeFor(lab, body.barcode);
    if (!specimen) return fail(404, 'No sample with that barcode for this laboratory.', 'unknown');
    if (specimen.status === 'rejected') return fail(409, 'That sample was rejected.', 'state');
    if (specimen.status === 'resulted' && !body.supersedes) {
        return fail(409, 'That sample already has a result. Send a correction with "supersedes".', 'state');
    }

    // Checked before anything is written, from a read-only look at the order.
    const owner = await Order.findById(specimen.orderId).select('userId').lean();
    if (!owner?.userId) return fail(409, 'The order for that sample has not been claimed by an account yet.', 'unclaimed');
    const malformed = specimen.kind === 'blood' ? cleanAnalytes(body.analytes).errors : cleanVariants(body.variants).errors;
    if (malformed.length) return fail(422, malformed[0], 'invalid');

    // A lab that sends a result without ever saying "received" has still received the tube.
    // Done first, because receiving saves the order — loading it before would leave this
    // handler holding a stale copy whose save Mongoose refuses.
    const correction = specimen.status === 'resulted';
    specimen = await ensureReceived(specimen, lab);
    const { order, component } = await componentOf(specimen);
    const user = await User.findById(order.userId).select('dob gender');
    const reportedAt = body.reportedAt && !Number.isNaN(new Date(body.reportedAt).getTime()) ? new Date(body.reportedAt) : new Date();
    const collectedAt = specimen.events.find((e) => e.type === 'collected')?.at || specimen.createdAt;
    const labName = LABS[lab].name;

    let field;
    let id;
    if (specimen.kind === 'blood') {
        const { errors, analytes } = cleanAnalytes(body.analytes);
        if (errors.length) return fail(422, errors[0], 'invalid');
        const testResult = await TestResult.create({
            patient: {
                user_id: order.userId,
                date_of_test: collectedAt,
                lab_name: labName,
                test_type: String(body.panel?.name || 'Blood test').slice(0, 80),
            },
            results: analytes.reduce((acc, m) => {
                acc[m.name] = { value: m.value, unit: m.unit, reference_range: m.reportedRange?.raw };
                return acc;
            }, {}),
            source: 'lab_integration',
            parseStatus: 'parsed',
        });
        const { saved, failed } = await persistMeasurements({
            userId: order.userId,
            user,
            measurements: analytes.map((m) => ({ ...m, measuredAt: collectedAt })),
            testResultId: testResult._id,
            source: 'lab_report',
        });
        await TestResult.updateOne({ _id: testResult._id }, {
            $set: { biomarkerCount: saved.length, parseStatus: failed.length ? 'needs_review' : 'parsed' },
        });
        field = 'testResultId';
        id = testResult._id;
    } else {
        const { errors, variants } = cleanVariants(body.variants);
        if (errors.length) return fail(422, errors[0], 'invalid');
        const report = await DnaReport.create({
            userId: order.userId, labName, reportDate: reportedAt, orderId: order._id, mutations: variants, status: 'uploaded',
        });
        field = 'dnaReportId';
        id = report._id;
    }

    specimen.status = 'resulted';
    specimen[field] = id;
    if (body.accession && !specimen.accession) specimen.accession = String(body.accession).slice(0, 80);
    specimen.events.push({ type: 'resulted', at: new Date(), by: `lab:${lab}`, note: correction ? `Corrected (supersedes ${body.supersedes})` : undefined });
    await specimen.save();

    if (component && component.status !== 'resulted') {
        component[field] = id;
        await advanceComponent({ order, component, status: 'resulted', note: `Resulted by ${labName}` });
    } else if (correction) {
        // A corrected report on a kit already resulted: the record is added beside the original,
        // never over it, and the analysis is re-run against the newer one.
        const { requestGeneration } = require('./interpretationController');
        requestGeneration({ userId: order.userId, [field === 'testResultId' ? 'testResultId' : 'dnaReportId']: id })
            .catch((e) => console.error('❌ Re-analysis after a corrected result failed:', e.message));
    }
    return ok(202, { barcode: specimen.barcode, id: String(id), corrected: correction });
};

// ── The HTTP layer ───────────────────────────────────────────────────────────

/**
 * Verify, parse, de-duplicate, run, remember. `kind` is 'event' or 'result'; the message id is
 * `eventId` or `resultId` respectively.
 */
const receive = (kind, handler) => async (req, res) => {
    const lab = String(req.params.lab || '').toUpperCase();
    try {
        if (!LABS[lab]) return res.status(404).json({ message: 'Unknown laboratory' });
        const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
        const check = verifySignature({ header: req.get('Predyqt-Signature'), rawBody, secrets: secretsFromEnv()[lab] });
        if (!check.ok) {
            console.warn(`🔒 Lab ${lab} ${kind} refused: ${check.reason}`);
            return res.status(check.reason === 'not_configured' ? 503 : 401).json({ message: 'Signature missing, wrong or too old.', reason: check.reason });
        }
        let body;
        try {
            body = JSON.parse(rawBody);
        } catch {
            return res.status(422).json({ message: 'The body is not valid JSON.', reason: 'invalid' });
        }
        const messageId = String(kind === 'event' ? body.eventId : body.resultId || '').trim().slice(0, 120);
        if (!messageId) return res.status(422).json({ message: `${kind === 'event' ? 'eventId' : 'resultId'} is required.`, reason: 'invalid' });

        const seen = await LabMessage.findOne({ lab, messageId }).lean();
        if (seen) return res.status(seen.status === 202 ? 200 : seen.status).json({ ...seen.response, replay: true });

        const outcome = await handler(lab, body);
        if (outcome.status < 500) {
            await LabMessage.create({ lab, messageId, kind, barcode: collection.normaliseBarcode(body.barcode) || undefined, status: outcome.status, response: outcome.body })
                .catch((e) => { if (e.code !== 11000) throw e; });
        }
        console.log(`🧪 Lab ${lab} ${kind} ${messageId}: ${outcome.status}`);
        return res.status(outcome.status).json(outcome.body);
    } catch (error) {
        console.error(`❌ Lab ${lab} ${kind} failed:`, error);
        return res.status(500).json({ message: 'Could not process the message. Please retry.' });
    }
};

exports.events = receive('event', handleEvent);
exports.results = receive('result', handleResult);
exports._internal = { cleanAnalytes, cleanVariants, handleEvent, handleResult };
