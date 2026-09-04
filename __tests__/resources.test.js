/**
 * The health resource library.
 *
 * Three things carry real consequences and are asserted here:
 *
 *   1. **The Pro paywall is applied server-side.** The single most likely regression is
 *      someone "simplifying" `gateBody` into a flag the client honours, at which point the
 *      whole article is in the response body for anyone with a proxy.
 *   2. **Counters cannot drift.** Likes are cached on the resource and sourced from the
 *      engagement row, and a rating can be changed. Double-tapping a heart or changing a
 *      vote must not move the number twice.
 *   3. **The import is idempotent.** It is meant to run on a timer against the website; if
 *      re-running it duplicates rows, the library doubles in size every night.
 */
const mongoose = require('mongoose');
const Resource = require('../models/Resource');
const ResourceCategory = require('../models/ResourceCategory');
const ResourceAuthor = require('../models/ResourceAuthor');
const ResourceEngagement = require('../models/ResourceEngagement');
const { gateBody, cardView, detailView, editView } = require('../utils/resourceView');
const rating = require('../utils/resourceRating');

let categoryId;
let authorId;

beforeEach(async () => {
    const category = await ResourceCategory.create({ slug: 'sleep', name: 'Sleep', group: 'Wellness' });
    const author = await ResourceAuthor.create({ slug: 'lorna-gray', name: 'Dr. Lorna Gray' });
    categoryId = category._id;
    authorId = author._id;
});

const makeResource = (overrides = {}) => Resource.create({
    slug: overrides.slug || `r-${new mongoose.Types.ObjectId()}`,
    type: 'article',
    title: 'The Science Behind Sleep',
    categoryId,
    authorId,
    status: 'published',
    body: [
        { type: 'paragraph', text: 'one' },
        { type: 'paragraph', text: 'two' },
        { type: 'paragraph', text: 'three' },
        { type: 'paragraph', text: 'four' },
        { type: 'paragraph', text: 'five' },
    ],
    ...overrides,
});

describe('the Pro paywall', () => {
    it('truncates a Pro article to its free blocks for a reader without a subscription', async () => {
        const resource = await makeResource({ isPro: true, freeBlockCount: 2 });
        const view = detailView(resource, { hasPro: false });

        expect(view.locked).toBe(true);
        expect(view.body).toHaveLength(2);
        expect(view.hiddenBlocks).toBe(3);

        // The point of the test: the withheld text is not somewhere else in the response.
        expect(JSON.stringify(view)).not.toContain('three');
    });

    it('sends the whole article to a Pro reader', async () => {
        const resource = await makeResource({ isPro: true, freeBlockCount: 2 });
        const view = detailView(resource, { hasPro: true });

        expect(view.locked).toBe(false);
        expect(view.body).toHaveLength(5);
        expect(view.hiddenBlocks).toBe(0);
    });

    it('never locks a resource that is not Pro, whatever freeBlockCount says', async () => {
        const resource = await makeResource({ isPro: false, freeBlockCount: 1 });
        expect(gateBody(resource, false)).toMatchObject({ locked: false, hiddenBlocks: 0 });
        expect(gateBody(resource, false).body).toHaveLength(5);
    });

    it('strips media and non-preview lesson URLs from a locked course', async () => {
        const resource = await makeResource({
            type: 'course',
            isPro: true,
            freeBlockCount: 0,
            media: { videoUrl: 'https://cdn.example/full.mp4' },
            course: {
                sessions: [
                    { title: 'Free lesson', preview: true, videoUrl: 'https://cdn.example/1.mp4' },
                    { title: 'Paid lesson', preview: false, videoUrl: 'https://cdn.example/2.mp4' },
                ],
            },
        });

        const view = detailView(resource, { hasPro: false });

        expect(view.media.videoUrl).toBeNull();
        // The lesson list survives — it is the sales pitch — but only the preview plays.
        expect(view.course.sessions).toHaveLength(2);
        expect(view.course.sessions[0].videoUrl).toBe('https://cdn.example/1.mp4');
        expect(view.course.sessions[1].videoUrl).toBeNull();
    });
});

describe('card views', () => {
    it('never carries the article body', async () => {
        const resource = await makeResource();
        await resource.populate([{ path: 'categoryId' }, { path: 'authorId' }]);

        const card = cardView(resource, null);
        expect(card.body).toBeUndefined();
        expect(JSON.stringify(card)).not.toContain('three');
    });

    it('omits the reader\'s own state entirely when there is no reader', async () => {
        const resource = await makeResource();
        const card = cardView(resource, undefined);

        // Absent, not false: an empty heart that means "we don't know" must not be drawn
        // as though it meant "not liked".
        expect(card.stats).not.toHaveProperty('liked');
        expect(cardView(resource, null).stats.liked).toBe(false);
    });
});

describe('derived length', () => {
    it('folds read minutes and runtime into one comparable field', async () => {
        const article = await makeResource({ readMinutes: 4, slug: 'a1' });
        const short = await makeResource({ type: 'short', durationSeconds: 135, slug: 's1' });

        expect(article.lengthMinutes).toBe(4);
        expect(short.lengthMinutes).toBe(2);
    });

    it('sums a course runtime from its sessions and counts them', async () => {
        const course = await makeResource({
            type: 'course', slug: 'c1',
            course: { sessions: [{ title: 'a', durationSeconds: 600 }, { title: 'b', durationSeconds: 300 }] },
        });

        expect(course.course.sessionCount).toBe(2);
        expect(course.durationSeconds).toBe(900);
        expect(course.lengthMinutes).toBe(15);
    });

    it('stamps publishedAt when a draft is published, and only then', async () => {
        const draft = await makeResource({ status: 'draft', slug: 'd1' });
        expect(draft.publishedAt).toBeNull();

        draft.status = 'published';
        await draft.save();
        expect(draft.publishedAt).toBeInstanceOf(Date);
    });
});

describe('ratings', () => {
    it('maps the three-point vocabulary to stars in exactly one place', () => {
        expect(rating.scoreOf('bad')).toBe(1);
        expect(rating.scoreOf('neutral')).toBe(3);
        expect(rating.scoreOf('great')).toBe(5);
        expect(rating.scoreOf('excellent')).toBeNull();
    });

    it('reports an unrated author as null, never as zero', () => {
        // Same distinction `alignment: 'unassessed'` makes. A 0.0 beside "Avg. Rating"
        // says someone scored badly; nobody has scored them at all.
        expect(rating.histogramFrom({}).average).toBeNull();
        expect(rating.histogramFrom({}).count).toBe(0);
    });

    it('leaves the 2 and 4 buckets empty rather than inventing votes', () => {
        const { histogram, average } = rating.histogramFrom({ bad: 1, neutral: 2, great: 7 });
        expect(histogram).toEqual({ 1: 1, 2: 0, 3: 2, 4: 0, 5: 7 });
        expect(average).toBe(4.2);
    });
});

describe('engagement rows', () => {
    it('allows one row per person per resource', async () => {
        const resource = await makeResource();
        const userId = new mongoose.Types.ObjectId();

        await ResourceEngagement.create({ userId, resourceId: resource._id, liked: true });
        await expect(
            ResourceEngagement.create({ userId, resourceId: resource._id, saved: true })
        ).rejects.toMatchObject({ code: 11000 });
    });

    it('keeps progress monotonic under $max, so a player posting 0 on mount cannot erase it', async () => {
        const resource = await makeResource();
        const userId = new mongoose.Types.ObjectId();

        await ResourceEngagement.updateOne(
            { userId, resourceId: resource._id }, { $max: { progressSeconds: 120 } }, { upsert: true },
        );
        await ResourceEngagement.updateOne(
            { userId, resourceId: resource._id }, { $max: { progressSeconds: 0 } },
        );

        const row = await ResourceEngagement.findOne({ userId, resourceId: resource._id });
        expect(row.progressSeconds).toBe(120);
    });
});

describe('import idempotency', () => {
    it('refuses a second row for the same external id', async () => {
        const source = { name: 'website', externalId: 'post-42', importedAt: new Date() };
        await makeResource({ slug: 'imported', source });

        await expect(makeResource({ slug: 'imported-again', source }))
            .rejects.toMatchObject({ code: 11000 });
    });

    it('does not constrain hand-authored rows, which all carry no external id', async () => {
        // The partial index exists precisely so these do not all collide on { null, null }.
        await expect(makeResource({ slug: 'hand-1' })).resolves.toBeTruthy();
        await expect(makeResource({ slug: 'hand-2' })).resolves.toBeTruthy();
    });
});

/**
 * The editor round-trip.
 *
 * The failure this guards against is silent and destructive in one direction: an editor that
 * loads a *reading* shape and saves it back writes the truncated body, the blanked category
 * and the reset paywall depth over the real record, and nothing errors.
 */
describe('the editorial view', () => {
    it('carries the whole body of a Pro piece, because a paywall is about readers', async () => {
        const resource = await makeResource({ isPro: true, freeBlockCount: 2 });
        const view = editView(resource);

        expect(view.body).toHaveLength(5);
        expect(view.freeBlockCount).toBe(2);
        // The reading shape of the same document withholds three blocks and says so.
        expect(detailView(resource, { hasPro: false }).body).toHaveLength(2);
    });

    it('names the category and author by id, which is what a save writes back', async () => {
        const resource = await makeResource();
        await resource.populate([{ path: 'categoryId' }, { path: 'authorId' }]);
        const view = editView(resource);

        expect(view.categoryId).toBe(String(categoryId));
        expect(view.authorId).toBe(String(authorId));
        // …and by name too, so the form can label its pickers without a second fetch.
        expect(view.category.name).toBe('Sleep');
        expect(view.author.name).toBe('Dr. Lorna Gray');
    });

    it('exposes the fields no reader is given and every editor needs', async () => {
        const resource = await makeResource({
            status: 'draft',
            source: { name: 'website', externalId: 'post-9' },
        });
        const view = editView(resource);

        expect(view.status).toBe('draft');
        expect(view.source.externalId).toBe('post-9');
        expect(view).toHaveProperty('featured');
        expect(view).toHaveProperty('freeBlockCount');
    });

    it('keeps course session ids, so editing a lesson title does not mint a new lesson', async () => {
        const resource = await makeResource({
            type: 'course',
            course: { sessions: [{ title: 'Lesson one', durationSeconds: 600 }] },
        });
        const view = editView(resource);

        expect(view.course.sessions[0]._id).toBe(String(resource.course.sessions[0]._id));
    });

    it('survives a save-what-you-loaded round trip without losing a field', async () => {
        const resource = await makeResource({ isPro: true, freeBlockCount: 2, featured: true });
        const before = editView(resource);

        // Exactly what the editor does: assign the loaded shape back and save.
        Object.assign(resource, {
            title: before.title,
            body: before.body,
            isPro: before.isPro,
            freeBlockCount: before.freeBlockCount,
            featured: before.featured,
            status: before.status,
        });
        await resource.save();

        const after = editView(await Resource.findById(resource._id));
        expect(after.body).toHaveLength(5);
        expect(after.freeBlockCount).toBe(2);
        expect(after.featured).toBe(true);
    });
});
