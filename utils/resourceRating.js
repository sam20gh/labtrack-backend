/**
 * The one place the three-point rating vocabulary is turned into a number.
 *
 * The design asks "How would you rate this article?" and offers Bad / Neutral / Great, while
 * Speaker Details draws a five-star histogram. Those are the same votes seen twice, so the
 * mapping between them has to live in exactly one function — otherwise the article screen and
 * the author screen eventually disagree about what a "neutral" is worth, and neither is
 * obviously wrong.
 *
 * Bad → 1, Neutral → 3, Great → 5. The 2 and 4 buckets exist in the histogram and stay empty
 * until something in the product actually collects them; drawing a five-star breakdown with
 * three populated bars is honest, and quietly redistributing votes into 2 and 4 to make the
 * chart look fuller would be inventing data.
 */

const VALUES = { bad: 1, neutral: 3, great: 5 };

/** @returns 1 | 3 | 5, or null for an unrecognised vote. */
const scoreOf = (rating) => VALUES[rating] ?? null;

const isValid = (rating) => Object.prototype.hasOwnProperty.call(VALUES, rating);

/**
 * Average of a set of resources' rating counters.
 *
 * Returns `null`, never 0, when nothing has been rated. Same distinction
 * `alignment: 'unassessed'` and `medicationSchedule.adherence` make: an unrated author has
 * not scored badly, and a 0.0 beside "Avg. Rating" says they have.
 */
const averageOf = (resources) => {
    const sum = resources.reduce((t, r) => t + (r.stats?.ratingSum || 0), 0);
    const count = resources.reduce((t, r) => t + (r.stats?.ratingCount || 0), 0);
    if (!count) return { average: null, count: 0, histogram: emptyHistogram() };
    return { average: Math.round((sum / count) * 10) / 10, count, histogram: emptyHistogram() };
};

const emptyHistogram = () => ({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });

/**
 * Exact star histogram for a set of resources, counted from the engagement rows.
 *
 * `stats.ratingSum` cannot be un-averaged back into buckets, so the breakdown needs the votes
 * themselves. One aggregation over the author's resources, run only on Speaker Details.
 */
const histogramFrom = (ratingCounts) => {
    const histogram = emptyHistogram();
    let sum = 0;
    let count = 0;
    for (const [rating, n] of Object.entries(ratingCounts || {})) {
        const score = scoreOf(rating);
        if (score == null) continue;
        histogram[score] += n;
        sum += score * n;
        count += n;
    }
    return {
        average: count ? Math.round((sum / count) * 10) / 10 : null,
        count,
        histogram,
    };
};

module.exports = { VALUES, scoreOf, isValid, averageOf, histogramFrom, emptyHistogram };
