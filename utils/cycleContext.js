/**
 * The cycle tracker, as a few lines of the assistant's context.
 *
 * **The assistant only — never the interpretation.** An interpretation is a draft a clinician
 * reviews in the staff portal, so anything it is given can end up in text a clinician reads,
 * and cycle data is hidden from clinicians in v1 by product decision. The assistant's
 * conversation is the person's own. When that decision changes, this is the file the
 * interpretation would call.
 *
 * Why it is worth the tokens at all: "I'm exhausted all the time" means something different
 * in somebody whose last three periods were heavy, and a question about cramps is better
 * answered knowing it is cycle day 2. The model is told to use it only where it bears on the
 * question, and never to diagnose from it.
 *
 * Returns null — and the section is omitted — for anybody who has not switched the tracker on.
 */
const CyclePlan = require('../models/CyclePlan');
const CycleDay = require('../models/CycleDay');
const { mergeDays, addDays, localDay } = require('./cycleEngine');
const { forecast, stats, regularityNotes } = require('./cycleForecast');

const STATUS_WORDS = {
    hormonal_contraception: 'uses hormonal contraception (bleeds are withdrawal bleeds; no ovulation estimate)',
    pregnant: 'is pregnant (predictions paused)',
    breastfeeding: 'is breastfeeding (predictions paused)',
    perimenopause: 'is perimenopausal (irregular cycles expected)',
};

const gatherCycle = async (userId, today = localDay(new Date())) => {
    const plan = await CyclePlan.findOne({ userId, enabled: true }).lean();
    if (!plan) return null;
    const rows = await CycleDay.find({ userId, day: { $gte: addDays(today, -400), $lte: today } }).lean();
    const days = mergeDays(rows);
    const reading = forecast({ days, plan, today, useTemperature: false });
    const since = addDays(today, -14);
    const recentSymptoms = {};
    for (const d of days) {
        if (d.day < since) continue;
        for (const s of d.symptoms) recentSymptoms[s] = (recentSymptoms[s] || 0) + 1;
    }
    return {
        today,
        plan,
        reading,
        stats: stats(reading),
        notes: regularityNotes(reading, plan, today),
        recentSymptoms,
        lastPeriod: reading.periods[reading.periods.length - 1] || null,
    };
};

const renderCycle = (cycle) => {
    if (!cycle) return '';
    const { reading, stats: s, plan } = cycle;
    const lines = ['', '## Their menstrual cycle (tracked in the app; private to them)'];

    if (STATUS_WORDS[plan.status]) lines.push(`They ${STATUS_WORDS[plan.status]}.`);
    if (reading.cycleDay) {
        lines.push(`As of ${cycle.today}: cycle day ${reading.cycleDay}, last period started ${reading.lastStart}`
            + ` (${reading.lastStartSource === 'logged' ? 'logged' : 'reported at setup'}).`);
    }
    if (reading.currentPeriod) lines.push(`They are on day ${reading.currentPeriod.day} of their period.`);
    if (reading.prediction && !reading.currentPeriod) {
        const p = reading.prediction;
        const when = `${p.window.from} to ${p.window.to}`;
        if (reading.state === 'late' || reading.state === 'very_late') {
            lines.push(`Their period is ${reading.daysLate} days late (expected around ${p.expected}).`);
        } else if (reading.state !== 'long_gap') {
            lines.push(`Next period likely ${when} (estimate from ${p.source === 'observed' ? 'their logged cycles' : 'their setup answers'}).`);
        }
    }
    if (s.averageCycle) lines.push(`Typical cycle ${s.averageCycle} days, typical period ${s.averagePeriod ?? 'unknown'} days, ${s.cyclesLogged} cycles logged.`);
    if (cycle.lastPeriod?.heaviest) lines.push(`Heaviest flow in their last period: ${cycle.lastPeriod.heaviest}.`);
    const symptoms = Object.entries(cycle.recentSymptoms);
    if (symptoms.length) {
        lines.push(`Symptoms logged in the last 14 days: ${symptoms.map(([k, n]) => `${k.replace(/_/g, ' ')} (${n})`).join(', ')}.`);
    }
    for (const n of cycle.notes) lines.push(`Tracker note shown to them: ${n.title}.`);

    lines.push('Use this only where it bears on what they ask — tiredness alongside heavy periods and');
    lines.push('iron results, cramps early in a cycle. Do not diagnose from it. Any fertile-window estimate');
    lines.push('is calendar-based and is not contraception; never suggest otherwise.');
    return lines.join('\n');
};

module.exports = { gatherCycle, renderCycle };
