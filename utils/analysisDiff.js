/**
 * What changed between two analyses, in the plan's own nouns.
 *
 * Built for the moment the DNA report lands: somebody has had a first analysis for two weeks
 * and is about to read a second. "Your analysis was updated" says nothing they can act on;
 * "two screenings added, one consultation no longer needed" does. The comparison is over the
 * three lists that become plan items — screenings, consultations and lifestyle advice — and
 * nothing else, because those are what the person will be asked to do differently.
 *
 * Matching is by the item's identifying field, case- and space-insensitive: the model rewords
 * a recommendation between runs often enough that comparing whole sentences would report
 * every item as removed and re-added. A lifestyle item is identified by its area, since its
 * wording is the part that legitimately changes.
 *
 * Pure. `__tests__/onboarding.test.js`.
 */

const norm = (v) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

const LISTS = [
    {
        key: 'screenings',
        field: 'recommended_screenings',
        id: (x) => norm(x?.test),
        title: (x) => x?.test || x?.condition || 'Screening',
        detail: (x) => x?.condition || null,
    },
    {
        key: 'consultations',
        field: 'specialist_consultations',
        id: (x) => norm(x?.speciality),
        title: (x) => x?.speciality || 'Consultation',
        detail: (x) => x?.reason || x?.condition || null,
    },
    {
        key: 'lifestyle',
        field: 'lifestyle_recommendations',
        id: (x) => norm(x?.area),
        title: (x) => x?.recommendation || x?.area || 'Advice',
        detail: (x) => x?.area || null,
    },
];

const diffList = (spec, before, after) => {
    const prev = new Map((before?.[spec.field] || []).map((x) => [spec.id(x), x]));
    const next = new Map((after?.[spec.field] || []).map((x) => [spec.id(x), x]));
    const shape = (x) => ({ title: spec.title(x), detail: spec.detail(x) });

    return {
        added: [...next].filter(([k]) => k && !prev.has(k)).map(([, x]) => shape(x)),
        removed: [...prev].filter(([k]) => k && !next.has(k)).map(([, x]) => shape(x)),
        kept: [...next].filter(([k]) => k && prev.has(k)).length,
    };
};

/**
 * @param {object|null} before  the earlier analysis content, or null for a first analysis
 * @param {object} after        the newer analysis content
 */
const diffAnalyses = (before, after) => {
    const changes = Object.fromEntries(LISTS.map((spec) => [spec.key, diffList(spec, before, after)]));
    const added = LISTS.reduce((n, s) => n + changes[s.key].added.length, 0);
    const removed = LISTS.reduce((n, s) => n + changes[s.key].removed.length, 0);
    return { first: !before, added, removed, changes };
};

module.exports = { diffAnalyses };
