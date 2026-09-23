/**
 * Example photos on meal suggestions.
 *
 * Two properties matter and both are asserted here: a photo can never cost a suggestion, and
 * a photo Unsplash describes as containing something this person cannot eat is never the one
 * attached. The second is the same `nutritionSafety.screen()` the dish itself passed, so these
 * tests are what keep the picture held to the dish's standard.
 */
jest.mock('axios');
const axios = require('axios');
const MealImage = require('../models/MealImage');
const mealImages = require('../utils/mealImages');

const result = (id, alt, extra = {}) => ({
    id,
    alt_description: alt,
    blur_hash: 'LKO2?U%2Tw=w]~RBVZRi};RPxuwH',
    color: '#c0a080',
    urls: { raw: `https://images.unsplash.com/photo-${id}?ixid=abc` },
    user: { name: `Photographer ${id}`, links: { html: `https://unsplash.com/@p${id}` } },
    links: { html: `https://unsplash.com/photos/${id}`, download_location: `https://api.unsplash.com/photos/${id}/download` },
    ...extra,
});

const searchReturns = (...results) => axios.get.mockImplementation((url) =>
    url.includes('/search/photos')
        ? Promise.resolve({ data: { results } })
        : Promise.resolve({ data: {} }));

const dish = (name, extra = {}) => ({ name, imageQuery: name.toLowerCase(), calories: 400, ...extra });

beforeEach(() => {
    process.env.UNSPLASH_ACCESS_KEY = 'test-key';
    mealImages._reset();
    axios.get.mockReset();
});

afterAll(() => { delete process.env.UNSPLASH_ACCESS_KEY; });

describe('attaching a photo', () => {
    it('attaches a hotlinked, credited, sized photo', async () => {
        searchReturns(result('a1', 'Salmon fillet with vegetables'));

        const [s] = await mealImages.attach([dish('Salmon greens')], null);

        expect(s.image.provider).toBe('unsplash');
        expect(s.image.url).toMatch(/^https:\/\/images\.unsplash\.com\/photo-a1\?ixid=abc&w=800/);
        expect(s.image.author).toBe('Photographer a1');
        expect(s.image.authorUrl).toContain('utm_source=miovix');
        expect(s.image.blurHash).toBeTruthy();
        // The description was for the check, not for the client
        expect(s.image.description).toBeUndefined();
    });

    it('sends the access key as Client-ID, never in the query string', async () => {
        searchReturns(result('a1', 'Oats'));
        await mealImages.attach([dish('Oats')], null);

        const [, config] = axios.get.mock.calls[0];
        expect(config.headers.Authorization).toBe('Client-ID test-key');
        expect(JSON.stringify(config.params)).not.toContain('test-key');
    });

    it('does nothing at all without a key', async () => {
        delete process.env.UNSPLASH_ACCESS_KEY;
        const input = [dish('Oats')];

        expect(await mealImages.attach(input, null)).toBe(input);
        expect(axios.get).not.toHaveBeenCalled();
    });
});

describe('a photo never costs a suggestion', () => {
    it('returns every suggestion unchanged when the search fails', async () => {
        axios.get.mockRejectedValue(Object.assign(new Error('boom'), { response: { status: 500 } }));

        const out = await mealImages.attach([dish('Oats'), dish('Soup')], null);

        expect(out.map((s) => s.name)).toEqual(['Oats', 'Soup']);
        expect(out.every((s) => s.image === undefined)).toBe(true);
    });

    it('does not cache a failed search as "nothing exists"', async () => {
        axios.get.mockRejectedValue(new Error('timeout'));
        await mealImages.attach([dish('Oats')], null);

        expect(await MealImage.countDocuments()).toBe(0);
    });

    it('stops searching after a rate limit instead of failing every card', async () => {
        axios.get.mockRejectedValue(Object.assign(new Error('limit'), { response: { status: 403 } }));

        await mealImages.attach([dish('Oats')], null);
        await mealImages.attach([dish('Soup'), dish('Stew')], null);

        expect(axios.get).toHaveBeenCalledTimes(1);
    });
});

describe('the allergen check on the picture', () => {
    it('skips a photo whose description names an allergen and takes the next', async () => {
        searchReturns(
            result('nutty', 'Green salad topped with walnuts'),
            result('plain', 'Green salad with cucumber and tomato'),
        );

        const [s] = await mealImages.attach([dish('Green salad')], { allergies: ['tree nuts'] });

        expect(s.image.url).toContain('photo-plain');
    });

    it('goes without a photo rather than show an unsafe one', async () => {
        searchReturns(result('p1', 'Satay skewers with peanut sauce'));

        const [s] = await mealImages.attach([dish('Chicken skewers')], { allergies: ['peanut'] });

        expect(s.image).toBeUndefined();
    });

    it('holds the photo to dietary preferences as well', async () => {
        searchReturns(
            result('meat', 'Bowl of rice with chicken and broccoli'),
            result('veg', 'Bowl of rice with tofu and broccoli'),
        );

        const [s] = await mealImages.attach([dish('Rice bowl')], { dietaryPreferences: ['vegetarian'] });

        expect(s.image.url).toContain('photo-veg');
    });

    it('lets the same cached search serve two people differently', async () => {
        searchReturns(
            result('cheese', 'Pasta with parmesan cheese'),
            result('tomato', 'Pasta with tomato sauce'),
        );

        const [a] = await mealImages.attach([dish('Pasta')], null);
        const [b] = await mealImages.attach([dish('Pasta')], { allergies: ['dairy'] });

        expect(a.image.url).toContain('photo-cheese');
        expect(b.image.url).toContain('photo-tomato');
        expect(axios.get.mock.calls.filter(([u]) => u.includes('/search/')).length).toBe(1);
    });
});

describe('the shared cache', () => {
    it('searches a dish name once for everybody', async () => {
        searchReturns(result('a1', 'Oats'));

        await mealImages.attach([dish('Overnight oats')], null);
        await mealImages.attach([dish('Overnight oats')], null);

        expect(axios.get.mock.calls.filter(([u]) => u.includes('/search/')).length).toBe(1);
        expect(await MealImage.countDocuments({ query: 'overnight oats' })).toBe(1);
    });

    it('never gives two suggestions in one set the same photograph', async () => {
        searchReturns(result('x', 'Oats with berries'), result('y', 'Oats with banana'));

        const out = await mealImages.attach([dish('Oats'), dish('Oats')], null);

        expect(out[0].image.url).not.toBe(out[1].image.url);
    });

    it('falls back to the dish name for a suggestion with no search term', () => {
        expect(mealImages.queryFor({ name: 'Baked Salmon & Greens!' })).toBe('baked salmon greens');
    });
});
