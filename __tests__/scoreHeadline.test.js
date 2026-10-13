const { _headlineFor: headlineFor } = require('../utils/labtrackScore');

const hydration = { key: 'hydration', label: 'Hydration', value: 24, detail: 'Averaging 24% of your target across 17 logged days.' };
const sleep = { key: 'sleep', label: 'Sleep', value: 94, detail: '6.5h a night across 22 nights.' };

describe('the sentence under the score', () => {
    test('names the pillar its weakest detail belongs to', () => {
        expect(headlineFor(79, { key: 'healthy' }, [sleep, hydration], 98))
            .toBe('You are doing well. Your lowest area is hydration: averaging 24% of your target across 17 logged days.');
    });

    test('a lower band leads with the area and asks for a look', () => {
        expect(headlineFor(52, { key: 'fair' }, [sleep, hydration], 98))
            .toBe('Your lowest area is hydration: averaging 24% of your target across 17 logged days. Worth a look.');
    });

    test('a detail starting with an acronym or a number keeps its case', () => {
        const markers = { key: 'biomarkers', label: 'Markers', value: 40, detail: 'LDL 4.2 mmol/L is above your range.' };
        expect(headlineFor(60, { key: 'fair' }, [markers], 98)).toMatch(/markers: LDL 4\.2/);
    });

    test('a high score still just says keep it up', () => {
        expect(headlineFor(90, { key: 'healthy' }, [sleep, hydration], 98)).toBe('You are doing well. Keep it up.');
    });
});
