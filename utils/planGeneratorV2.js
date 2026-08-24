/**
 * Turns a structured interpretation into dated, actionable plan items.
 *
 * Replaces `planGenerator.js`, which had three defects this fixes:
 *
 *   - **Consultations were hardcoded to age 50** regardless of urgency or the person's
 *     current age, so a 60-year-old was told to see a specialist ten years ago.
 *   - **Screenings emitted exactly 10 yearly occurrences**, ignoring the stated frequency —
 *     a once-only genetic test produced ten identical rows.
 *   - **Age/year pairs instead of dates**, so "overdue" was arithmetic against a birth year
 *     rather than a date comparison.
 *
 * Every item now carries a real `dueDate`, so the daily sweep and the reminder job are both
 * simple date queries.
 */
const PlanItem = require('../models/PlanItem');
const Product = require('../models/Product');
const Professional = require('../models/Professional');
const { calculateAge } = require('./biomarkerEvaluator');

/** Months between occurrences. `once` and `as_advised` produce a single item. */
const FREQUENCY_MONTHS = {
    every_6_months: 6,
    annually: 12,
    every_2_years: 24,
    every_3_years: 36,
    every_5_years: 60,
};

/**
 * How far ahead to schedule recurring surveillance.
 *
 * Deliberately short. A 10-year horizon over 6-monthly and annual screenings produced 87
 * plan items for one BRCA2 interpretation — a wall of near-identical rows that buries what
 * the person should actually do next. Real care works the same way: you book the next
 * appointment, not the next twenty.
 *
 * `advanceRecurringItem()` creates the following occurrence when one is completed, so the
 * plan stays populated indefinitely without ever being overwhelming.
 */
const DEFAULT_HORIZON_MONTHS = 24;

const addMonths = (date, months) => {
    const d = new Date(date);
    d.setMonth(d.getMonth() + months);
    return d;
};

const startOfToday = () => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
};

/**
 * When should surveillance that begins at `startingAge` first happen?
 *
 * If the person is already past that age, it is due now — that is the whole point of
 * flagging it. Otherwise it falls on the birthday when they reach it.
 */
const firstDueDate = (dob, startingAge) => {
    const today = startOfToday();
    if (!dob || typeof startingAge !== 'number') return today;

    const birth = new Date(dob);
    if (Number.isNaN(birth.getTime())) return today;

    const currentAge = calculateAge(dob);
    if (currentAge === null || currentAge >= startingAge) return today;

    const due = new Date(birth);
    due.setFullYear(birth.getFullYear() + startingAge);
    return due < today ? today : due;
};

/**
 * Dates for one screening across the horizon.
 * A `once` or `as_advised` item yields exactly one date, however long the horizon is.
 */
const occurrenceDates = (firstDue, frequency, horizonMonths = DEFAULT_HORIZON_MONTHS) => {
    const interval = FREQUENCY_MONTHS[frequency];
    if (!interval) return [firstDue];

    const horizonEnd = addMonths(firstDue, horizonMonths);

    const dates = [];
    let cursor = new Date(firstDue);
    // Cap at 6 regardless of horizon: beyond that the list stops being a plan and starts
    // being a calendar dump
    while (cursor <= horizonEnd && dates.length < 6) {
        dates.push(new Date(cursor));
        cursor = addMonths(cursor, interval);
    }
    return dates;
};

/** Case-insensitive, bidirectional substring match against the product catalogue. */
const matchProduct = (testName, products) => {
    const needle = String(testName).toLowerCase();
    return products.find((p) => {
        const name = String(p.name).toLowerCase();
        return name.includes(needle) || needle.includes(name);
    }) || null;
};

/**
 * Professionals for a speciality. Exact enum match only — the interpretation schema
 * constrains `speciality` to the enum, so substring matching would only introduce error.
 */
const matchProfessionals = (speciality, professionals, limit = 3) =>
    professionals.filter((p) => (p.speciality || []).includes(speciality)).slice(0, limit);

/**
 * Build plan items from an interpretation.
 *
 * @returns {{items: object[], unmatched: {test: string, reason: string}[]}}
 *   `unmatched` records screenings with no purchasable product, so the catalogue gap is
 *   visible rather than silently dropping the recommendation.
 */
const buildPlanItems = ({ interpretation, user, products = [], professionals = [], sourceDnaReportId, sourceTestResultId, horizonMonths }) => {
    const items = [];
    const unmatched = [];
    const today = startOfToday();

    for (const screening of interpretation.recommended_screenings || []) {
        const product = matchProduct(screening.test, products);
        const firstDue = firstDueDate(user?.dob, screening.starting_age);
        const dates = occurrenceDates(firstDue, screening.frequency, horizonMonths);

        if (!product) {
            unmatched.push({ test: screening.test, reason: 'No matching product in the catalogue' });
        }

        dates.forEach((dueDate, index) => {
            items.push({
                userId: user._id,
                type: /scan|mri|ultrasound|ct|x-ray|dexa|colonoscopy|mammograph/i.test(screening.test) ? 'scan' : 'test',
                title: screening.test,
                description: screening.rationale,
                condition: screening.condition,
                frequency: screening.frequency,
                dueDate,
                // Only the first occurrence inherits the interpretation's urgency; later
                // ones are routine until their date approaches
                urgency: index === 0 ? (screening.urgency === 'urgent' ? 'high' : screening.urgency === 'soon' ? 'moderate' : 'low') : 'low',
                status: PlanItem.deriveStatus(dueDate),
                source: 'ai',
                sourceDnaReportId,
                sourceTestResultId,
                productId: product?._id,
                productName: product?.name,
                image: product?.image || null,
            });
        });
    }

    for (const consult of interpretation.specialist_consultations || []) {
        const matches = matchProfessionals(consult.speciality, professionals);
        const dueDate = addMonths(today, consult.due_within_months ?? 3);
        const chosen = matches[0] || null;

        if (!matches.length) {
            unmatched.push({ test: consult.speciality, reason: 'No professional with this speciality' });
        }

        items.push({
            userId: user._id,
            type: 'consultation',
            title: `Consult ${consult.speciality}`,
            description: consult.reason,
            speciality: consult.speciality,
            dueDate,
            urgency: consult.urgency === 'urgent' ? 'high' : consult.urgency === 'soon' ? 'moderate' : 'low',
            status: PlanItem.deriveStatus(dueDate),
            source: 'ai',
            sourceDnaReportId,
            sourceTestResultId,
            professionalId: chosen?._id,
            professionalName: chosen ? `${chosen.firstname} ${chosen.lastname}` : undefined,
            image: chosen?.profile_image || null,
        });
    }

    for (const lifestyle of interpretation.lifestyle_recommendations || []) {
        items.push({
            userId: user._id,
            type: 'lifestyle',
            title: lifestyle.recommendation,
            description: lifestyle.rationale,
            condition: lifestyle.area,
            dueDate: today,
            urgency: 'low',
            status: 'upcoming',
            source: 'ai',
            sourceDnaReportId,
            sourceTestResultId,
            // Lifestyle advice is guidance, not an appointment — no reminders
            reminder: { enabled: false, offsetDays: [], sentOffsets: [] },
        });
    }

    return { items, unmatched };
};

/**
 * Replace a person's AI-generated plan items with a fresh set.
 *
 * Only untouched AI items are removed: anything the person ordered, booked, completed, or
 * dismissed, and anything a specialist added, survives regeneration. Losing a booked
 * appointment because an interpretation was re-run would be indefensible.
 */
const regeneratePlan = async ({ interpretation, user, products, professionals, sourceDnaReportId, sourceTestResultId, horizonMonths }) => {
    const { items, unmatched } = buildPlanItems({
        interpretation, user, products, professionals, sourceDnaReportId, sourceTestResultId, horizonMonths,
    });

    const removed = await PlanItem.deleteMany({
        userId: user._id,
        source: 'ai',
        status: { $in: PlanItem.MUTABLE_STATUSES },
    });

    const created = items.length ? await PlanItem.insertMany(items) : [];

    return { created, removedCount: removed.deletedCount, unmatched };
};

/**
 * Create the next occurrence of a recurring item once the current one is completed.
 *
 * This is what keeps a short horizon viable: the plan never runs dry, and it never shows
 * twenty rows of the same screening.
 *
 * @returns {Promise<object|null>} the new item, or null when the item does not recur
 */
const advanceRecurringItem = async (completedItem) => {
    const interval = FREQUENCY_MONTHS[completedItem.frequency];
    if (!interval) return null;

    const nextDue = addMonths(completedItem.completedAt || new Date(), interval);

    // Guard against duplicates if completion is submitted twice
    const exists = await PlanItem.exists({
        userId: completedItem.userId,
        title: completedItem.title,
        dueDate: nextDue,
        status: { $in: PlanItem.MUTABLE_STATUSES },
    });
    if (exists) return null;

    return PlanItem.create({
        userId: completedItem.userId,
        planId: completedItem.planId,
        type: completedItem.type,
        title: completedItem.title,
        description: completedItem.description,
        condition: completedItem.condition,
        frequency: completedItem.frequency,
        dueDate: nextDue,
        status: PlanItem.deriveStatus(nextDue),
        urgency: 'low',
        source: completedItem.source,
        sourceDnaReportId: completedItem.sourceDnaReportId,
        sourceTestResultId: completedItem.sourceTestResultId,
        productId: completedItem.productId,
        productName: completedItem.productName,
        professionalId: completedItem.professionalId,
        professionalName: completedItem.professionalName,
        speciality: completedItem.speciality,
        image: completedItem.image,
    });
};

module.exports = {
    buildPlanItems,
    regeneratePlan,
    advanceRecurringItem,
    firstDueDate,
    occurrenceDates,
    matchProfessionals,
    matchProduct,
    FREQUENCY_MONTHS,
    DEFAULT_HORIZON_MONTHS,
};
