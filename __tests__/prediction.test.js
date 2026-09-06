/**
 * Predictive health analysis — the arithmetic, and the guard on the model.
 *
 * This is the same argument `medicationInteractions.test.js` and `healthMetrics.test.js`
 * make, pointed at a fourth deterministic component. You cannot assert that a language model
 * asked "what will their blood pressure be next week" gives the same answer twice, and there
 * is no way to find out afterwards which forecast was the invented one. A weighted regression
 * can be pinned to a number in a test, and `Prediction.resolution` scores it against reality
 * afterwards.
 *
 * What has to hold:
 *   - Two readings produce no prediction at all. Not a wide one — none.
 *   - A prediction is always an interval, and the interval is never zero-width.
 *   - A horizon the history cannot support is refused, with a reason.
 *   - Noise is not a trend.
 *   - Confidence falls when the data gets worse, on every axis independently.
 *   - The model can never change a figure, raise a severity, or invent a component.
 */
const f = require('../utils/predictionForecast');
const engine = require('../utils/predictionEngine');
const registry = require('../utils/predictionMetrics');

/** Build a daily series ending today. `values[0]` is the oldest. */
const daily = (values, { endDaysAgo = 0 } = {}) => values.map((value, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (values.length - 1 - i) - endDaysAgo);
    return { day: d.toISOString().slice(0, 10), value };
});

describe('refusing, rather than guessing', () => {
    it('produces nothing from fewer than three readings', () => {
        expect(f.forecast(daily([70, 72]), { horizonDays: 3 })).toBeNull();
        expect(f.forecast(daily([70]), { horizonDays: 3 })).toBeNull();
        expect(f.forecast([], { horizonDays: 3 })).toBeNull();
    });

    it('names what is missing rather than returning a bare null', () => {
        const r = f.explainRefusal(daily([70, 72]), 7);
        expect(r.reason).toBe('too_few');
        expect(r.have).toBe(2);
        expect(r.need).toBe(3);
        // The sentence the design's "not enough data" modal prints.
        expect(r.message).toMatch(/log 1 more entry/i);
    });

    it('refuses three readings taken on the same day', () => {
        const today = new Date().toISOString().slice(0, 10);
        const sameDay = [70, 71, 72].map((value) => ({ day: today, value }));
        expect(f.forecast(sameDay, { horizonDays: 3 })).toBeNull();
        expect(f.explainRefusal(sameDay, 3).reason).toBe('no_span');
    });

    it('refuses a horizon the history cannot reach', () => {
        // Ten days of data cannot say anything about a year, and must not try.
        const series = daily([70, 70.4, 70.2, 70.8, 71, 71.2, 71.1, 71.6, 71.8, 72]);
        expect(f.forecast(series, { horizonDays: 365 })).toBeNull();
        expect(f.explainRefusal(series, 365).reason).toBe('horizon_too_far');

        // The same series a week ahead is fine.
        expect(f.forecast(series, { horizonDays: 5 })).not.toBeNull();
    });

    it('caps the horizon at a fraction of the observed span, not at the span', () => {
        const series = daily(Array.from({ length: 21 }, (_, i) => 70 + i * 0.1));
        expect(f.maxHorizonFor(series)).toBe(15);          // 20 days × 0.75
        expect(f.forecast(series, { horizonDays: 15 })).not.toBeNull();
        expect(f.forecast(series, { horizonDays: 16 })).toBeNull();
    });
});

describe('a prediction is an interval', () => {
    const rising = daily([70, 70.5, 71, 71.5, 72, 72.5, 73, 73.5, 74, 74.5, 75, 75.5, 76, 76.5]);

    it('always brackets the point estimate', () => {
        const r = f.forecast(rising, { horizonDays: 7 });
        expect(r.low).toBeLessThan(r.point);
        expect(r.high).toBeGreaterThan(r.point);
    });

    it('never returns a zero-width interval, even on a perfectly straight series', () => {
        // Three identical weigh-ins have no residual scatter at all. The naive interval is
        // zero wide, which is the one thing a forecast must never claim.
        const flat = daily([80, 80, 80, 80, 80, 80, 80, 80]);
        const r = f.forecast(flat, { horizonDays: 4 });
        expect(r.high - r.low).toBeGreaterThan(0);
    });

    it('widens as the horizon lengthens', () => {
        const near = f.forecast(rising, { horizonDays: 2 });
        const far = f.forecast(rising, { horizonDays: 9 });
        expect(far.margin).toBeGreaterThan(near.margin);
    });

    it('clamps to physical bounds rather than predicting an impossible value', () => {
        const falling = daily([12, 10, 8, 6, 4, 3, 2, 1]);
        const r = f.forecast(falling, { horizonDays: 5, bounds: [0, 100] });
        expect(r.low).toBeGreaterThanOrEqual(0);
        expect(r.point).toBeGreaterThanOrEqual(0);
    });
});

describe('noise is not a trend', () => {
    it('reports a series that only bounces as flat', () => {
        // Scale noise around a stable weight. A regression through it tilts by a hair, and
        // reporting that as "rising" tells someone they are gaining weight because their
        // bathroom scale rounds differently on carpet.
        const jitter = daily([80.1, 79.9, 80.2, 79.8, 80.0, 80.2, 79.9, 80.1, 80.0, 79.9]);
        expect(f.forecast(jitter, { horizonDays: 5 }).direction).toBe('flat');
    });

    it('still finds a real trend buried in the same amount of noise', () => {
        const trend = daily([78.1, 78.4, 78.3, 78.9, 79.1, 79.0, 79.6, 79.8, 79.7, 80.3]);
        expect(f.forecast(trend, { horizonDays: 5 }).direction).toBe('rising');
    });

    it('weights recent readings above old ones', () => {
        // Flat for a fortnight, then a sharp climb. A plain unweighted fit is dragged towards
        // the flat half; the recency weighting has to follow the recent move.
        const values = [...Array(14).fill(70), 71, 72.5, 74, 75.5, 77];
        const r = f.forecast(daily(values), { horizonDays: 5 });
        expect(r.direction).toBe('rising');
        // And it must never print "rising" beside a figure below what they last measured —
        // the incoherence rule 7 exists to prevent.
        expect(r.point).toBeGreaterThan(r.basis.lastValue);
    });

    it('never contradicts its own direction against the last reading', () => {
        const cases = [
            [...Array(14).fill(70), 71, 72.5, 74, 75.5, 77],
            [...Array(14).fill(90), 88, 86.5, 85, 83.5, 82],
        ];
        for (const values of cases) {
            const r = f.forecast(daily(values), { horizonDays: 5 });
            if (r.direction === 'rising') expect(r.point).toBeGreaterThanOrEqual(r.basis.lastValue);
            if (r.direction === 'falling') expect(r.point).toBeLessThanOrEqual(r.basis.lastValue);
        }
    });
});

describe('confidence is computed, not asserted', () => {
    const clean = daily(Array.from({ length: 30 }, (_, i) => 70 + i * 0.2));

    it('falls when the series gets noisier', () => {
        const noisy = daily(Array.from({ length: 30 }, (_, i) => 70 + i * 0.2 + (i % 2 ? 3 : -3)));
        expect(f.forecast(noisy, { horizonDays: 7 }).confidence)
            .toBeLessThan(f.forecast(clean, { horizonDays: 7 }).confidence);
    });

    it('falls when the horizon lengthens', () => {
        expect(f.forecast(clean, { horizonDays: 20 }).confidence)
            .toBeLessThan(f.forecast(clean, { horizonDays: 2 }).confidence);
    });

    it('falls when there are fewer readings behind it', () => {
        const few = daily([70, 70.6, 71.2, 71.8, 72.4]);
        expect(f.forecast(few, { horizonDays: 3 }).confidence)
            .toBeLessThan(f.forecast(clean, { horizonDays: 3 }).confidence);
    });

    it('falls when the most recent reading is stale', () => {
        const stale = daily(Array.from({ length: 30 }, (_, i) => 70 + i * 0.2), { endDaysAgo: 14 });
        expect(f.forecast(stale, { horizonDays: 7 }).confidence)
            .toBeLessThan(f.forecast(clean, { horizonDays: 7 }).confidence);
    });

    it('never claims more than 97% or less than 25%', () => {
        const perfect = daily(Array.from({ length: 200 }, (_, i) => 50 + i));
        expect(f.forecast(perfect, { horizonDays: 1 }).confidence).toBeLessThanOrEqual(0.97);

        const awful = daily([10, 90, 20, 80, 30]);
        const r = f.forecast(awful, { horizonDays: 2 });
        if (r) expect(r.confidence).toBeGreaterThanOrEqual(0.25);
    });
});

describe('gaps are gaps', () => {
    it('drops unrecorded days rather than interpolating them', () => {
        const withNulls = [
            { day: '2026-01-01', value: 70 },
            { day: '2026-01-02', value: null },
            { day: '2026-01-03', value: 72 },
            { day: '2026-01-08', value: 74 },
        ];
        expect(f._normalise(withNulls)).toHaveLength(3);
    });

    it('measures the span in days, so an irregular logger is not treated as a dense one', () => {
        const sparse = [
            { day: '2026-01-01', value: 70 },
            { day: '2026-02-01', value: 72 },
            { day: '2026-03-01', value: 74 },
        ];
        // Three readings across two months support a longer horizon than three across a week.
        expect(f.maxHorizonFor(sparse)).toBeGreaterThan(30);
    });
});

describe('the projected path', () => {
    const series = daily(Array.from({ length: 30 }, (_, i) => 120 + i * 0.4));

    it('returns one row per day of the horizon, each with its own interval', () => {
        const p = f.project(series, { horizonDays: 7, decimals: 0 });
        expect(p.days).toHaveLength(7);
        for (const d of p.days) expect(d.low).toBeLessThanOrEqual(d.high);
    });

    it('ends on the same figure the single-shot forecast gives', () => {
        const p = f.project(series, { horizonDays: 7, decimals: 0 });
        const one = f.forecast(series, { horizonDays: 7, decimals: 0 });
        expect(p.days[6].value).toBe(one.point);
    });
});

describe('the model can never change a number', () => {
    const forecast = {
        confidence: 0.82,
        components: [
            { key: 'systolic', label: 'Systolic', point: 126, low: 120, high: 132, margin: 6, currentValue: 118, changePct: 6.8, direction: 'rising', confidence: 0.82, basis: { points: 20, spanDays: 30, staleDays: 1 } },
            { key: 'diastolic', label: 'Diastolic', point: 96, low: 92, high: 100, margin: 4, currentValue: 88, changePct: 9.1, direction: 'rising', confidence: 0.85, basis: { points: 20, spanDays: 30, staleDays: 1 } },
        ],
    };
    const merge = (data) => engine.mergeNarrative(data, {
        forecast, horizonDays: 7, fallbackHeadline: 'FALLBACK',
    });

    it('overwrites a risk chance with the forecast confidence, whatever the model said', () => {
        const out = merge({
            headline: 'x', summary: 'y', tone: 'watchful', key_factors: [], suggestions: [],
            risks: [{ label: 'Possible hypertension', detail: 'd', risk: 'high', preventable: true, chance: 0.99 }],
            component_notes: [],
        });
        expect(out.risks[0].chance).toBe(0.82);
    });

    it('clamps an unrecognised risk level DOWN, never up', () => {
        const out = merge({
            headline: 'x', summary: 'y', tone: 'neutral', key_factors: [], suggestions: [],
            risks: [{ label: 'Something', detail: 'd', risk: 'catastrophic', preventable: true }],
            component_notes: [],
        });
        expect(out.risks[0].risk).toBe('low');
    });

    it('drops a note about a component that was not forecast', () => {
        const out = merge({
            headline: 'x', summary: 'y', tone: 'neutral', key_factors: [], suggestions: [],
            risks: [],
            component_notes: [
                { component: 'systolic', note: 'ok' },
                { component: 'glucose', note: 'invented' },
            ],
        });
        expect(out.componentNotes).toHaveLength(1);
        expect(out.componentNotes[0].component).toBe('systolic');
    });

    it('discards a headline carrying a figure the forecast does not contain', () => {
        expect(engine.inventsFigure('your blood pressure will reach 165/104', forecast, 7)).toBe(true);
        expect(engine.inventsFigure('In 1 week, your blood pressure will elevate to 126/96', forecast, 7)).toBe(false);

        const out = merge({
            headline: 'Your blood pressure will reach 165 mmHg',
            summary: 'y', tone: 'urgent', key_factors: [], suggestions: [], risks: [], component_notes: [],
        });
        expect(out.headline).toBe('FALLBACK');
    });

    it('caps the risk list at three', () => {
        const out = merge({
            headline: 'x', summary: 'y', tone: 'neutral', key_factors: [], suggestions: [],
            risks: Array.from({ length: 8 }, (_, i) => ({ label: `r${i}`, detail: 'd', risk: 'low', preventable: true })),
            component_notes: [],
        });
        expect(out.risks).toHaveLength(3);
    });
});

describe('the deterministic narrative stands in for the model', () => {
    const forecast = {
        confidence: 0.44,
        components: [{
            key: 'value', label: 'Weight', point: 82.4, low: 80.1, high: 84.7, margin: 2.3,
            currentValue: 81, changePct: 1.7, direction: 'rising', confidence: 0.44,
            basis: { points: 6, spanDays: 12, staleDays: 1 },
        }],
    };

    it('says plainly that a weak forecast is weak', () => {
        const n = engine.deterministicNarrative({
            metric: registry.get('weight'), horizonDays: 7, forecast, band: null, headline: 'H',
        });
        expect(n.degraded).toBe(true);
        expect(n.summary).toMatch(/low/i);
        expect(n.model).toBeNull();
    });

    it('leads with the emergency when the band is a crisis', () => {
        const n = engine.deterministicNarrative({
            metric: registry.get('blood_pressure'),
            horizonDays: 7,
            forecast,
            band: { key: 'crisis', label: 'Hypertensive crisis', crisis: true },
            headline: 'H',
        });
        expect(n.summary.startsWith('This projection is in a range that needs medical attention now.')).toBe(true);
        expect(n.tone).toBe('urgent');
    });
});

describe('the registry', () => {
    it('stages a predicted blood pressure with the same table a measured one uses', () => {
        // 118/92 is stage 2 on its diastolic alone. A predicted pair must not be staged more
        // leniently than a logged one — that is the whole reason `band` delegates.
        expect(registry.get('blood_pressure').band(null, { systolic: 118, diastolic: 92 }).key)
            .toBe('stage_2');
    });

    it('gives weight and calories no better direction', () => {
        // A weight forecast drawn in green would be the app taking a view on someone's body.
        expect(registry.get('weight').betterWhen).toBeNull();
        expect(registry.get('calories').betterWhen).toBeNull();
    });

    it('knows which way is better for the metrics that have one', () => {
        expect(registry.get('blood_pressure').betterWhen).toBe('falling');
        expect(registry.get('resting_heart_rate').betterWhen).toBe('falling');
        expect(registry.get('turing_score').betterWhen).toBe('rising');
        expect(registry.get('sleep').betterWhen).toBe('rising');
    });

    it('offers only horizons its own chips can name', () => {
        for (const key of registry.METRIC_KEYS) {
            for (const days of registry.get(key).horizons) {
                expect(registry.HORIZON_LABELS[days]).toBeDefined();
            }
        }
    });
});

describe('the direction calendar', () => {
    const { _buildCalendar } = require('../controllers/predictionController');

    const component = (days, currentValue, margin = 4) => ({
        confidence: 0.8,
        components: [{ key: 'value', currentValue, margin, days }],
    });

    it('compares every day against today, not against the day before it', () => {
        // A steady climb compared day-on-day is a wall of identical arrows that says nothing
        // the line above it does not. Compared against today it answers the real question.
        const days = [121, 124, 126, 128].map((value, i) => ({ day: `d${i}`, value }));
        const cal = _buildCalendar(registry.get('blood_pressure'), component(days, 120));
        expect(cal.map((d) => d.direction)).toEqual(['level', 'up', 'up', 'up']);
    });

    it('calls a day inside the uncertainty level rather than picking a direction', () => {
        const days = [120.5, 119.6, 121].map((value, i) => ({ day: `d${i}`, value }));
        const cal = _buildCalendar(registry.get('blood_pressure'), component(days, 120, 10));
        expect(cal.every((d) => d.direction === 'level')).toBe(true);
    });

    it('tones a rise as bad for blood pressure and good for steps', () => {
        const days = [{ day: 'd0', value: 200 }];
        expect(_buildCalendar(registry.get('blood_pressure'), component(days, 120))[0].tone).toBe('bad');
        expect(_buildCalendar(registry.get('steps'), component(days, 120))[0].tone).toBe('good');
    });

    it('stays neutral for a metric with no better direction', () => {
        const days = [{ day: 'd0', value: 200 }];
        expect(_buildCalendar(registry.get('weight'), component(days, 120))[0].tone).toBe('neutral');
    });
});
