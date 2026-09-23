/**
 * An example photograph for each AI meal suggestion, from Unsplash.
 *
 * **The picture is illustrative, and every surface that draws it says so.** Nothing has been
 * cooked: this is somebody else's version of a dish with a similar name, and the card carries
 * an "Example photo" chip so a stock image cannot read as a picture of what the person is
 * being told to eat. `SuggestionCard.tsx` records the rest of that argument.
 *
 * Three things this file guarantees, in code rather than by convention:
 *
 *   1. **A photo never costs a suggestion.** No key, a rate limit, a timeout, an empty
 *      search, a Cloudflare-style outage on Unsplash's side — every one of them returns the
 *      suggestion unchanged and the card falls back to its tinted panel. `attach` cannot
 *      throw. The same trade `imageStore.uploadImageOrNull` makes.
 *   2. **A photo whose description names something this person cannot eat is skipped.** The
 *      ingredient screen in `nutritionSafety.js` guarantees the *dish* is safe; it says
 *      nothing about a stock photo of a salad scattered with walnuts. So Unsplash's own
 *      description and tags go through the very same `screen()` with the same plan, and a
 *      candidate that fails is passed over for the next. It cannot catch what a description
 *      does not mention — which is why the chip exists as well — but it removes every case
 *      the photographer named.
 *   3. **One search per dish name, shared by everybody.** The demo tier is 50 requests an
 *      hour for the whole app. `MealImage` caches the candidates on the normalised query, and
 *      a 403/429 pauses searching entirely rather than failing six times per set.
 *
 * Unsplash's API terms, which approval for the production tier is checked against: images
 * are hotlinked from `urls.raw` and never re-hosted; the photographer and Unsplash are
 * credited with `utm_source` links; and `download_location` is pinged when a photo is first
 * shown.
 */
const axios = require('axios');
const MealImage = require('../models/MealImage');
const { screen } = require('./nutritionSafety');

const API = 'https://api.unsplash.com';
const UTM = 'utm_source=miovix&utm_medium=referral';

/** Candidates kept per query. Enough for the allergen check to have somewhere to go. */
const CANDIDATES = 10;
/** Per request. The suggestion set already waited seconds for the model; not much longer. */
const TIMEOUT_MS = 3500;
/** A found photo can stay a month; an empty search is retried sooner. */
const FRESH_MS = 30 * 24 * 3600 * 1000;
const EMPTY_FRESH_MS = 3 * 24 * 3600 * 1000;
/** How long to stop searching after Unsplash says we have used the hour's allowance. */
const RATE_LIMIT_PAUSE_MS = 15 * 60 * 1000;

/** One size for every surface — 250pt rail card to full-width sheet, at up to 3x. */
const SIZING = 'w=800&h=520&fit=crop&crop=entropy&auto=format&q=70';

const isConfigured = () => Boolean(process.env.UNSPLASH_ACCESS_KEY);

let pausedUntil = 0;
const inFlight = new Map();
const pinged = new Set();

const headers = () => ({
    Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}`,
    'Accept-Version': 'v1',
});

const withUtm = (url) => (url ? `${url}${url.includes('?') ? '&' : '?'}${UTM}` : undefined);

/**
 * The search term for one suggestion. The model writes a short `imageQuery` for exactly this;
 * a row from before that field existed falls back to the dish name, which searches worse but
 * still searches.
 */
const queryFor = (suggestion) => String(suggestion.imageQuery || suggestion.name || '')
    .toLowerCase()
    .replace(/[^a-z\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);

/** Unsplash's result → the cached shape. Anything without a usable URL is dropped. */
const toPhoto = (r) => (r?.urls?.raw ? {
    id: r.id,
    raw: r.urls.raw,
    blurHash: r.blur_hash || undefined,
    color: r.color || undefined,
    description: [r.description, r.alt_description].filter(Boolean).join('. ') || undefined,
    tags: (r.tags || []).map((t) => t?.title).filter(Boolean),
    author: r.user?.name || r.user?.username,
    authorUrl: withUtm(r.user?.links?.html),
    photoUrl: withUtm(r.links?.html),
    downloadLocation: r.links?.download_location,
} : null);

const search = async (query) => {
    try {
        const { data } = await axios.get(`${API}/search/photos`, {
            params: {
                // "food" steers an ambiguous dish name ("buddha bowl") away from ceramics
                query: /\bfood\b/.test(query) ? query : `${query} food`,
                per_page: CANDIDATES,
                orientation: 'landscape',
                content_filter: 'high',
            },
            headers: headers(),
            timeout: TIMEOUT_MS,
        });
        return (data?.results || []).map(toPhoto).filter(Boolean);
    } catch (error) {
        const status = error.response?.status;
        if (status === 403 || status === 429) {
            pausedUntil = Date.now() + RATE_LIMIT_PAUSE_MS;
            console.warn('⚠️ Unsplash rate limit reached; meal photos paused for 15 minutes');
        } else {
            console.warn('⚠️ Unsplash search failed:', status || error.message);
        }
        // null, not []: a failed search must not be cached as "nothing exists"
        return null;
    }
};

/** Cached candidates for a query, searching only when the cache is missing or stale. */
const candidatesFor = async (query) => {
    if (!query) return [];

    const cached = await MealImage.findOne({ query }).lean();
    const age = cached ? Date.now() - new Date(cached.fetchedAt).getTime() : Infinity;
    const fresh = cached && age < (cached.photos.length ? FRESH_MS : EMPTY_FRESH_MS);
    if (fresh || Date.now() < pausedUntil) return cached?.photos || [];

    // Two suggestions in one set can share a query; search once
    if (!inFlight.has(query)) {
        inFlight.set(query, (async () => {
            const photos = await search(query);
            if (photos == null) return cached?.photos || [];
            await MealImage.updateOne(
                { query },
                { $set: { photos, fetchedAt: new Date() } },
                { upsert: true }
            ).catch((e) => {
                // A duplicate-key race with another instance is harmless; the row exists
                if (e.code !== 11000) throw e;
            });
            return photos;
        })().finally(() => inFlight.delete(query)));
    }
    return inFlight.get(query);
};

/**
 * The first candidate this person may be shown.
 *
 * `screen()` is reused on purpose rather than reimplemented: the photo is held to exactly the
 * allergen and preference tables the dish was, so the two cannot drift. A vegan is not shown
 * a photo Unsplash describes as containing chicken, any more than the dish itself.
 */
const pickPhoto = (photos, plan, exclude = new Set()) => photos.find((p) => {
    if (exclude.has(p.id)) return false;
    const { kept } = screen([{ name: p.description || '', tags: p.tags || [] }], plan);
    return kept.length === 1;
}) || null;

/** The fields a client draws. The description stays on the server; it was for the check. */
const toImage = (p) => ({
    provider: 'unsplash',
    url: `${p.raw}${p.raw.includes('?') ? '&' : '?'}${SIZING}`,
    blurHash: p.blurHash,
    color: p.color,
    author: p.author,
    authorUrl: p.authorUrl,
    photoUrl: p.photoUrl,
});

/** Unsplash asks for this when a photo is used. Once per photo per process; never awaited. */
const trackUse = (p) => {
    if (!p.downloadLocation || pinged.has(p.id)) return;
    pinged.add(p.id);
    axios.get(p.downloadLocation, { headers: headers(), timeout: TIMEOUT_MS })
        .catch(() => pinged.delete(p.id));
};

/**
 * Attach an example photo to each suggestion that can have one.
 *
 * @param {Array} suggestions  already screened and normalised
 * @param {object|null} plan   the person's NutritionPlan — what the photo is checked against
 * @returns {Promise<Array>}   the same suggestions, some with `image`. Never rejects.
 */
const attach = async (suggestions = [], plan = null) => {
    if (!isConfigured() || !suggestions.length) return suggestions;

    try {
        const lists = await Promise.all(suggestions.map((s) =>
            candidatesFor(queryFor(s)).catch((error) => {
                console.warn('⚠️ Meal photo lookup failed:', error.message);
                return [];
            })));

        // Sequential on purpose: two suggestions must not wear the same photograph
        const used = new Set();
        return suggestions.map((s, i) => {
            const photo = pickPhoto(lists[i], plan, used);
            if (!photo) return s;
            used.add(photo.id);
            trackUse(photo);
            return { ...s, image: toImage(photo) };
        });
    } catch (error) {
        console.warn('⚠️ Meal photos skipped:', error.message);
        return suggestions;
    }
};

module.exports = {
    attach,
    isConfigured,
    queryFor,
    pickPhoto,
    toPhoto,
    _reset: () => { pausedUntil = 0; inFlight.clear(); pinged.clear(); },
};
