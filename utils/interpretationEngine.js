/**
 * Generates a structured health interpretation from a person's own data.
 *
 * Replaces the DeepSeek + keyword-parser pipeline. Two things changed materially:
 *
 *   - **Structured output instead of prose.** The old path asked for free text and then ran
 *     `feedbackParser.js` over it looking for exact phrases like "PSA Testing". Anything
 *     phrased differently was silently discarded, and the specialities it did emit matched
 *     no `Professional.speciality` value, so consultations never reached a plan.
 *   - **The person's actual data goes in.** The old prompt sent gender, height, weight, dob
 *     and one interpretation string. This sends genetic findings, biomarker trends, and
 *     health-assessment context, which is what makes the output specific to them.
 *
 * Uses Claude Opus 5: this is the highest-stakes, lowest-volume call in the product, and it
 * is cached per source document so it runs once rather than per view.
 */
const Anthropic = require('@anthropic-ai/sdk');
const { INTERPRETATION_SCHEMA, SYSTEM_PROMPT } = require('./interpretationSchema');
const { calculateAge } = require('./biomarkerEvaluator');

const MODEL = 'claude-opus-5';

const isConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY);

let client = null;
const getClient = () => {
    if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    return client;
};

/**
 * Render the person's data as the prompt input.
 *
 * Deliberately plain text rather than raw JSON: labelled sections with units and trends
 * spelled out give the model less room to misread a field than a nested object does.
 */
/** YYYY-MM-DD, tolerant of a missing or unparseable date. */
const isoDay = (d) => {
    const t = new Date(d).getTime();
    return Number.isNaN(t) ? 'undated' : new Date(t).toISOString().slice(0, 10);
};

const buildContext = ({ user, dnaReports = [], biomarkers = [], trends = {}, series = {}, testResults = [], previous = null, nutrition = null, medications = null }) => {
    const age = calculateAge(user?.dob);
    const lines = [];

    lines.push('## Person');
    lines.push(`Age: ${age ?? 'unknown'}`);
    lines.push(`Sex: ${user?.gender ?? 'not recorded'}`);
    if (user?.height) lines.push(`Height: ${user.height} cm`);
    if (user?.weight) lines.push(`Weight: ${user.weight} kg`);
    if (user?.bloodType) lines.push(`Blood type: ${user.bloodType}`);

    const ha = user?.healthAssessment;
    if (ha) {
        if (ha.healthGoals?.length) lines.push(`Health goals: ${ha.healthGoals.join(', ')}`);
        const ls = ha.lifestyle || {};
        const lifestyle = [
            ls.smokingStatus && `smoking: ${ls.smokingStatus}`,
            ls.alcoholConsumption && `alcohol: ${ls.alcoholConsumption}`,
            ls.exerciseFrequency && `exercise: ${ls.exerciseFrequency}`,
            ls.dietType && `diet: ${ls.dietType}`,
            ls.sleepHoursPerNight && `sleep: ${ls.sleepHoursPerNight}h/night`,
            ls.stressLevel && `stress: ${ls.stressLevel}`,
        ].filter(Boolean);
        if (lifestyle.length) lines.push(`Lifestyle: ${lifestyle.join('; ')}`);

        if (ha.conditions?.length) {
            lines.push(`Existing conditions: ${ha.conditions.map((c) => `${c.name} (${c.status})`).join(', ')}`);
        }
        if (ha.medications?.length) {
            lines.push(`Medications: ${ha.medications.map((m) => m.name).join(', ')}`);
        }
        if (ha.allergies?.length) {
            lines.push(`Allergies: ${ha.allergies.map((a) => a.allergen).join(', ')}`);
        }
        if (ha.familyHistory?.length) {
            lines.push(`Family history: ${ha.familyHistory.map((f) => `${f.condition} (${f.relation})`).join(', ')}`);
        }
    }

    lines.push('');
    lines.push('## Genetic findings');
    if (!dnaReports.length) {
        lines.push('No genetic testing on record.');
    } else {
        for (const report of dnaReports) {
            lines.push(`Report from ${report.labName || 'unknown lab'}${report.reportDate ? ` (${isoDay(report.reportDate)})` : ''}:`);
            if (!report.mutations?.length) {
                lines.push('  No variants reported.');
                continue;
            }
            for (const m of report.mutations) {
                lines.push(`  ${m.gene}${m.variant ? ` ${m.variant}` : ''} — ${m.significance}${m.zygosity && m.zygosity !== 'unknown' ? `, ${m.zygosity}` : ''}${m.condition ? ` — associated with ${m.condition}` : ''}`);
            }
        }
    }

    lines.push('');
    lines.push('## Laboratory results');
    if (!biomarkers.length) {
        lines.push('No laboratory results on record.');
    } else {
        for (const b of biomarkers) {
            const range = b.appliedRange
                ? ` [reference ${b.appliedRange.min ?? '–'}–${b.appliedRange.max ?? '–'}${b.appliedRange.geneAdjusted ? ', adjusted for their genetics' : ''}]`
                : '';
            const trend = trends[b.name];
            const trendText = trend && trend.count > 1
                ? ` — ${trend.count} measurements, ${trend.direction} from ${trend.first} to ${trend.last}`
                : '';
            lines.push(`  ${b.displayName || b.name}: ${b.value} ${b.unit} — ${b.flag}${range}${trendText}`);

            // Every measurement with its date. Endpoints alone hide the shape, and hide
            // whether repeated identical values are real draws or a duplicated entry.
            const points = series[b.name]?.points || [];
            if (points.length > 1) {
                if (series[b.name].omitted) {
                    lines.push(`    (most recent ${points.length}; ${series[b.name].omitted} earlier omitted)`);
                }
                for (const p of points) {
                    lines.push(`    ${isoDay(p.at)}: ${p.v} ${b.unit}`);
                }
            }
        }
    }

    if (testResults.length) {
        lines.push('');
        lines.push('## Reports on file');
        for (const t of testResults) {
            lines.push(`  ${t.patient?.test_type || 'Test'} at ${t.patient?.lab_name || 'unknown lab'}, ${isoDay(t.patient?.date_of_test)}${t.interpretation ? ` — lab comment: ${t.interpretation}` : ''}`);
        }
    }

    if (nutrition) {
        lines.push('');
        lines.push('## Logged nutrition');
        // What they actually ate against what the last interpretation told them to eat.
        // Without this the dietary advice is written blind every time, and someone who has
        // already been following it for three months is told to start.
        lines.push(`Self-logged, so treat it as indicative rather than measured. ${nutrition.daysLogged} of the last ${nutrition.windowDays} days have entries.`);
        if (nutrition.targets?.calories) {
            lines.push(`Daily target ${nutrition.targets.calories} kcal; mean intake on logged days ${nutrition.meanCalories} kcal.`);
        }
        if (nutrition.guidance?.length) {
            lines.push(`Dietary guidance currently on their plan: ${nutrition.guidance.join('; ')}.`);
        }
        if (nutrition.adherence.assessed > 0) {
            lines.push(`Of ${nutrition.adherence.assessed} meals assessed against that guidance, `
                + `${nutrition.adherence.aligned} were aligned, ${nutrition.adherence.partial} partly aligned, `
                + `and ${nutrition.adherence.offPlan} were not.`);
        } else {
            lines.push('No meals have been assessed against dietary guidance yet.');
        }
        lines.push('Where the record shows advice already being followed, acknowledge it rather than');
        lines.push('repeating the instruction. Where it shows advice not being followed, consider');
        lines.push('whether a different, more achievable change would serve them better.');
    }

    if (medications) {
        lines.push('');
        lines.push('## Medicines they take');
        // A biomarker cannot be read without this. A raised potassium in someone on
        // spironolactone and an ACE inhibitor is a different finding from the same number in
        // someone on neither, and an engine that cannot see the list will write the wrong one.
        for (const m of medications.current) {
            const bits = [m.name];
            if (m.strength) bits.push(m.strength);
            if (m.brandName) bits.push(`(as ${m.brandName})`);
            const how = m.frequency ? m.frequency.replace(/_/g, ' ') : 'schedule not recorded';
            lines.push(`  ${bits.join(' ')} — ${how}${m.since ? `, since ${m.since}` : ''}`);
        }

        if (medications.adherence && medications.adherence.assessed > 0) {
            const a = medications.adherence;
            lines.push(`Over the last ${medications.windowDays} days, ${a.taken} of ${a.assessed} due doses were `
                + `recorded as taken (${a.score}%), ${a.missed} were missed and ${a.skipped} deliberately skipped.`);
            lines.push('Where a result has not moved, weigh this before concluding a treatment is not working.');
        } else {
            lines.push('No dose history has been recorded, so adherence is unknown — do not assume either way.');
        }

        if (medications.interactionFindings?.length) {
            lines.push('');
            lines.push('Interactions already identified by the rule table, for context — these are');
            lines.push('being shown to the person separately, so do not restate them as new findings:');
            for (const f of medications.interactionFindings) {
                lines.push(`  [${f.severity}] ${f.between.join(' + ')}`);
            }
        }

        if (medications.uncheckable?.length) {
            lines.push(`Not classifiable by that table, so not checked at all: ${medications.uncheckable.join(', ')}.`);
        }

        lines.push('Never tell them to start, stop, or change the dose of any of these. Where');
        lines.push('something needs changing, say what to raise with the prescriber and why.');
    }

    if (previous) {
        lines.push('');
        lines.push(`## Your previous interpretation (${isoDay(previous.generatedAt)})`);
        if (previous.reviewed) {
            lines.push('This one was reviewed by a clinician, and what follows is the version they signed.');
            lines.push('Where you now disagree with it, say so explicitly rather than quietly departing from it.');
        }
        lines.push('Written by you at an earlier assessment. Re-derive everything from the data');
        lines.push('above — this is for continuity, not a conclusion to defer to. Where the picture');
        lines.push('has changed, say so explicitly and say which values moved.');
        lines.push('');
        if (previous.summary) lines.push(`Summary given: ${previous.summary}`);
        if (previous.risks?.length) {
            lines.push('Risks stated:');
            for (const r of previous.risks) lines.push(`  ${r.condition} — ${r.level}`);
        }
        if (previous.biomarkersOfConcern?.length) {
            lines.push(`Markers flagged: ${previous.biomarkersOfConcern.map((b) => b.name).join(', ')}`);
        }
    }

    lines.push('');
    lines.push(`Today's date is ${new Date().toISOString().slice(0, 10)}.`);

    return lines.join('\n');
};

/**
 * Text that satisfies the schema while carrying no information.
 * Observed in production: a run returned `reason: "Placeholder"` for every specialist
 * consultation while the rest of the output was detailed and correct. The schema cannot
 * catch this — "Placeholder" is a valid string — so it is checked explicitly.
 */
const PLACEHOLDER_TEXT = /^(placeholder|tbd|to be determined|n\/?a|none|todo|unknown|\.\.\.|-+)$/i;

const isDegenerate = (text, minLength = 20) => {
    const value = String(text ?? '').trim();
    return !value || value.length < minLength || PLACEHOLDER_TEXT.test(value);
};

/**
 * Reject output that validates but says nothing.
 *
 * This is a medical product: shipping "Placeholder" where a person's care plan should be is
 * worse than showing an error, because it looks like an answer.
 *
 * @returns {string[]} human-readable problems; empty means the output is usable
 */
const findQualityIssues = (data) => {
    const issues = [];

    if (isDegenerate(data.summary, 60)) issues.push('summary is empty or placeholder text');

    data.specialist_consultations?.forEach((c, i) => {
        if (isDegenerate(c.reason)) issues.push(`consultation ${i + 1} (${c.speciality}) has no real reason`);
    });
    data.recommended_screenings?.forEach((s, i) => {
        if (isDegenerate(s.rationale)) issues.push(`screening ${i + 1} (${s.test}) has no real rationale`);
    });
    data.risks?.forEach((r, i) => {
        if (isDegenerate(r.rationale)) issues.push(`risk ${i + 1} (${r.condition}) has no real rationale`);
    });

    return issues;
};

/**
 * Collapse consultations that name the same speciality, keeping the most urgent and the
 * soonest. Two rows reading "Medical Genetics" are a UI defect, not two appointments.
 */
const dedupeConsultations = (consultations = []) => {
    const rank = { urgent: 3, soon: 2, routine: 1 };
    const bySpeciality = new Map();

    for (const c of consultations) {
        const existing = bySpeciality.get(c.speciality);
        if (!existing) {
            bySpeciality.set(c.speciality, c);
            continue;
        }
        bySpeciality.set(c.speciality, {
            ...existing,
            urgency: rank[c.urgency] > rank[existing.urgency] ? c.urgency : existing.urgency,
            due_within_months: Math.min(existing.due_within_months, c.due_within_months),
            // Preserve both justifications rather than discarding one
            reason: existing.reason === c.reason ? existing.reason : `${existing.reason} ${c.reason}`,
        });
    }

    return [...bySpeciality.values()];
};

/**
 * Produce an interpretation.
 *
 * Retries once on degenerate output. The failure is intermittent rather than systematic, so
 * a single retry clears it; two failures in a row means something is genuinely wrong and an
 * error is returned instead of low-quality content.
 *
 * @returns {Promise<{ok:boolean, data?:object, error?:string, usage?:object, context?:string}>}
 */
const interpret = async (input, attempt = 1) => {
    if (!isConfigured()) {
        return { ok: false, error: 'ANTHROPIC_API_KEY is not configured on the server' };
    }

    const context = buildContext(input);

    try {
        // Streamed: high effort on a full profile can exceed the non-streaming timeout
        const stream = getClient().messages.stream({
            model: MODEL,
            max_tokens: 16000,
            system: SYSTEM_PROMPT,
            thinking: { type: 'adaptive' },
            output_config: {
                effort: 'high',
                format: { type: 'json_schema', schema: INTERPRETATION_SCHEMA },
            },
            messages: [{
                role: 'user',
                content: `Interpret this person's health data and produce their surveillance plan.\n\n${context}`,
            }],
        });

        const message = await stream.finalMessage();

        if (message.stop_reason === 'refusal') {
            return {
                ok: false,
                error: 'This request could not be processed automatically. Please consult a clinician directly.',
            };
        }

        const textBlock = message.content.find((b) => b.type === 'text');
        if (!textBlock) return { ok: false, error: 'No interpretation returned' };

        const data = JSON.parse(textBlock.text);

        const issues = findQualityIssues(data);
        if (issues.length) {
            console.warn(`⚠️ Interpretation quality issues (attempt ${attempt}):`, issues);
            if (attempt < 2) return interpret(input, attempt + 1);
            return {
                ok: false,
                error: 'Could not produce a reliable interpretation. Please try again shortly.',
                issues,
            };
        }

        data.specialist_consultations = dedupeConsultations(data.specialist_consultations);

        return { ok: true, data, usage: message.usage, context, attempts: attempt };
    } catch (error) {
        console.error('❌ Interpretation failed:', error);
        return { ok: false, error: error.message || 'Interpretation failed' };
    }
};

module.exports = { interpret, buildContext, isConfigured, findQualityIssues, dedupeConsultations, MODEL };
