/**
 * Health resources — the library behind `app/resources/*`.
 *
 * Read paths are deliberately shaped around the screens rather than around the collection:
 * `getHub` answers the whole Resources home in one round trip because the design draws five
 * rails on it, and five requests on a mobile connection is five chances to show a spinner.
 * `listResources` is one endpoint behind four list screens, the search screen and the filter
 * sheet, because they differ only in which facets are pinned.
 *
 * Write paths split into two families and the split is enforced by the router:
 *   - engagement (view, like, save, rate, progress, join) — any signed-in reader, always
 *     scoped to `req.user.id`, never trusting a userId in the body;
 *   - authoring (create, update, delete, import) — admin only.
 */
const mongoose = require('mongoose');
const Resource = require('../models/Resource');
const ResourceCategory = require('../models/ResourceCategory');
const ResourceAuthor = require('../models/ResourceAuthor');
const ResourceEngagement = require('../models/ResourceEngagement');
const ResourceAuthorFollow = require('../models/ResourceAuthorFollow');
const User = require('../models/userModel');
const rating = require('../utils/resourceRating');
const { cardView, detailView, authorDetailView, categoryView } = require('../utils/resourceView');

const POPULATE = [
    { path: 'categoryId', select: 'slug name group icon' },
    { path: 'authorId', select: 'slug name speciality headline avatar' },
];

const PUBLISHED = { status: 'published' };

/** Does this reader hold a Pro subscription? One lookup, cached on the request. */
const hasProAccess = async (req) => {
    if (!req.user?.id) return false;
    if (req._proAccess !== undefined) return req._proAccess;
    const user = await User.findById(req.user.id).select('proMember').lean();
    req._proAccess = Boolean(user?.proMember);
    return req._proAccess;
};

/** This reader's engagement rows for a set of resources, keyed by resource id. */
const engagementMap = async (userId, resources) => {
    if (!userId || !resources.length) return new Map();
    const rows = await ResourceEngagement.find({
        userId,
        resourceId: { $in: resources.map((r) => r._id) },
    }).lean();
    return new Map(rows.map((r) => [String(r.resourceId), r]));
};

/** Serialise a list, attaching each reader's own like/save state in one extra query. */
const cardsFor = async (userId, resources) => {
    const map = await engagementMap(userId, resources);
    return resources.map((r) => cardView(r, userId ? (map.get(String(r._id)) || null) : undefined));
};

const slugify = (value) => String(value || '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);

/** Resolve `:idOrSlug` to a published resource without letting a slug be read as an id. */
const findResource = async (idOrSlug, { requirePublished = true } = {}) => {
    const filter = mongoose.isValidObjectId(idOrSlug) ? { _id: idOrSlug } : { slug: String(idOrSlug).toLowerCase() };
    if (requirePublished) filter.status = 'published';
    return Resource.findOne(filter).populate(POPULATE);
};

// ─────────────────────────────────────────────────────────────────────────────
// Browse
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The Resources home, in one call.
 *
 * Six queries in parallel rather than six requests in series. Each rail is capped small —
 * the design's rails are horizontal and nobody scrolls forty cards sideways — and every
 * "See All" goes to `listResources`, which is paginated.
 */
exports.getHub = async (req, res) => {
    try {
        const userId = req.user?.id || null;
        const rail = (filter, sort, limit) =>
            Resource.find({ ...PUBLISHED, ...filter }).sort(sort).limit(limit).populate(POPULATE);

        const newest = { publishedAt: -1 };

        const [featured, articles, shorts, courses, workshops, categories] = await Promise.all([
            rail({ featured: true }, newest, 8),
            rail({ type: 'article' }, newest, 10),
            rail({ type: 'short' }, newest, 10),
            rail({ type: 'course' }, newest, 8),
            rail({ type: 'workshop' }, newest, 8),
            ResourceCategory.find({ active: true }).sort({ groupOrder: 1, group: 1, order: 1, name: 1 }).limit(12).lean(),
        ]);

        // One engagement lookup for every card on the screen, not one per rail.
        const all = [...featured, ...articles, ...shorts, ...courses, ...workshops];
        const map = await engagementMap(userId, all);
        const draw = (list) => list.map((r) => cardView(r, userId ? (map.get(String(r._id)) || null) : undefined));

        res.json({
            categories: categories.map(categoryView),
            featured: draw(featured),
            articles: draw(articles),
            shorts: draw(shorts),
            courses: draw(courses),
            workshops: draw(workshops),
        });
    } catch (error) {
        console.error('❌ getHub failed:', error);
        res.status(500).json({ message: 'Could not load resources' });
    }
};

/**
 * Explore Categories — every active category, grouped, each with a live count.
 *
 * The count is aggregated rather than stored. See the note on `ResourceCategory`: a stored
 * count is wrong the first time anything is unpublished, and a tile that promises 125
 * resources and opens onto 12 is worse than one that promised 12.
 */
exports.getCategories = async (req, res) => {
    try {
        const [categories, counts] = await Promise.all([
            ResourceCategory.find({ active: true }).sort({ groupOrder: 1, group: 1, order: 1, name: 1 }).lean(),
            Resource.aggregate([
                { $match: { status: 'published' } },
                { $group: { _id: '$categoryId', count: { $sum: 1 } } },
            ]),
        ]);

        const countOf = new Map(counts.map((c) => [String(c._id), c.count]));

        const groups = [];
        for (const category of categories) {
            let group = groups.find((g) => g.name === category.group);
            if (!group) groups.push(group = { name: category.group, categories: [] });
            group.categories.push({
                ...categoryView(category),
                resourceCount: countOf.get(String(category._id)) || 0,
            });
        }

        res.json({ groups });
    } catch (error) {
        console.error('❌ getCategories failed:', error);
        res.status(500).json({ message: 'Could not load categories' });
    }
};

const SORTS = {
    newest: { publishedAt: -1 },
    oldest: { publishedAt: 1 },
    popular: { 'stats.views': -1, publishedAt: -1 },
    relevant: { score: { $meta: 'textScore' }, publishedAt: -1 },
};

/**
 * The one list endpoint. Four "Our X" screens, search, and the filter sheet all land here.
 *
 * Returns `total` alongside the page because the filter sheet's button says
 * "Show results (23)" — a count the sheet needs *before* it navigates anywhere.
 */
/**
 * GET /api/resources/admin/all — the content library including drafts (admin only).
 *
 * `listResources` hardcodes `status: 'published'`, which is right for every patient-facing
 * screen and useless for managing a library: a draft is invisible to the only person who
 * can publish it. This is the editorial view, so it must show all three statuses.
 *
 * Deliberately projected — no `body`. An article's blocks are a large payload and a list
 * screen renders none of it; shipping every body to draw a table of titles is how a content
 * index becomes the slowest page in the console. The detail fetch already exists for that.
 *
 * Query: ?status=draft|published|archived|all &type= &search= &page= &limit=
 */
exports.listResourcesForAdmin = async (req, res, next) => {
    try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));

        const filter = {};

        const status = (req.query.status || '').trim();
        if (status && status !== 'all') {
            const allowed = Resource.schema.path('status').enumValues;
            if (!allowed.includes(status)) {
                return res.status(400).json({
                    message: `Unknown status "${status}". Expected one of: ${allowed.join(', ')}`,
                });
            }
            filter.status = status;
        }

        const type = (req.query.type || '').trim();
        if (type && type !== 'all') {
            const allowed = Resource.schema.path('type').enumValues;
            if (!allowed.includes(type)) {
                return res.status(400).json({
                    message: `Unknown type "${type}". Expected one of: ${allowed.join(', ')}`,
                });
            }
            filter.type = type;
        }

        const search = (req.query.search || '').trim();
        if (search) {
            const safe = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const rx = new RegExp(safe, 'i');
            filter.$or = [{ title: rx }, { slug: rx }, { excerpt: rx }];
        }

        const [items, total] = await Promise.all([
            Resource.find(filter)
                .select('type title slug status isPro featured publishedAt updatedAt stats source')
                .sort({ updatedAt: -1 })
                .skip((page - 1) * limit)
                .limit(limit)
                .populate(POPULATE)
                .lean(),
            Resource.countDocuments(filter),
        ]);

        res.json({
            items: items.map((r) => ({
                _id: r._id,
                type: r.type,
                title: r.title,
                slug: r.slug,
                status: r.status,
                isPro: Boolean(r.isPro),
                featured: Boolean(r.featured),
                publishedAt: r.publishedAt || null,
                updatedAt: r.updatedAt,
                views: r.stats?.views ?? 0,
                category: r.categoryId?.name || null,
                author: r.authorId?.name || null,
                // Set by the website import; tells an editor what they may safely edit here.
                importedFrom: r.source?.name || null,
            })),
            page,
            limit,
            total,
            pages: Math.max(1, Math.ceil(total / limit)),
            hasMore: page * limit < total,
        });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/resources/admin/stats — counts by status and type (admin only).
 * One aggregation, for the same reason the order board uses one.
 */
exports.getResourceStats = async (req, res, next) => {
    try {
        const [byStatus, byType] = await Promise.all([
            Resource.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
            Resource.aggregate([{ $group: { _id: '$type', count: { $sum: 1 } } }]),
        ]);

        const statuses = {};
        for (const value of Resource.schema.path('status').enumValues) statuses[value] = 0;
        for (const row of byStatus) if (row._id in statuses) statuses[row._id] = row.count;

        const types = {};
        for (const value of Resource.schema.path('type').enumValues) types[value] = 0;
        for (const row of byType) if (row._id in types) types[row._id] = row.count;

        res.json({
            statuses,
            types,
            total: Object.values(statuses).reduce((a, b) => a + b, 0),
        });
    } catch (error) {
        next(error);
    }
};

exports.listResources = async (req, res) => {
    try {
        const userId = req.user?.id || null;
        const { q, type, category, tag, author, minMinutes, maxMinutes, pro } = req.query;

        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));

        const filter = { ...PUBLISHED };

        if (type && type !== 'all') {
            const types = String(type).split(',').filter(Boolean);
            filter.type = types.length > 1 ? { $in: types } : types[0];
        }

        if (category) {
            const slugs = String(category).split(',').filter(Boolean);
            const ids = await ResourceCategory.find({ slug: { $in: slugs } }).select('_id').lean();
            // An unknown category slug must return nothing, not everything. Without this the
            // filter silently disappears and the screen shows the unfiltered library.
            filter.categoryId = { $in: ids.map((c) => c._id) };
        }

        if (tag) filter.tags = { $in: String(tag).split(',').filter(Boolean) };

        if (author) {
            const doc = await ResourceAuthor.findOne({ slug: String(author).toLowerCase() }).select('_id').lean();
            filter.authorId = doc ? doc._id : null;
        }

        if (minMinutes || maxMinutes) {
            filter.lengthMinutes = {};
            if (minMinutes) filter.lengthMinutes.$gte = Number(minMinutes);
            if (maxMinutes) filter.lengthMinutes.$lte = Number(maxMinutes);
        }

        if (pro === 'true') filter.isPro = true;
        if (pro === 'false') filter.isPro = false;

        // Regex rather than the text index: the search box is incremental and a person
        // typing "sle" expects to see "sleep". A text index matches whole words only, so it
        // returns nothing until the word is finished — which reads as a broken search.
        if (q && String(q).trim()) {
            const safe = String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const rx = new RegExp(safe, 'i');
            filter.$or = [{ title: rx }, { excerpt: rx }, { subtitle: rx }, { tags: rx }];
        }

        const sortKey = SORTS[req.query.sort] ? req.query.sort : 'newest';
        const sort = sortKey === 'relevant' ? SORTS.newest : SORTS[sortKey];

        const [items, total] = await Promise.all([
            Resource.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).populate(POPULATE),
            Resource.countDocuments(filter),
        ]);

        res.json({
            items: await cardsFor(userId, items),
            page,
            limit,
            total,
            pages: Math.max(1, Math.ceil(total / limit)),
            hasMore: page * limit < total,
        });
    } catch (error) {
        console.error('❌ listResources failed:', error);
        res.status(500).json({ message: 'Could not load resources' });
    }
};

/**
 * The facets the filter sheet draws.
 *
 * Served rather than hard-coded in the app so a category added on the website appears in the
 * sheet without an app release — the same reason `biomarkerGlossary` is server-side.
 */
exports.getFilters = async (req, res) => {
    try {
        const [categories, tags] = await Promise.all([
            ResourceCategory.find({ active: true }).sort({ groupOrder: 1, group: 1, order: 1, name: 1 }).lean(),
            Resource.distinct('tags', PUBLISHED),
        ]);

        res.json({
            types: [
                { key: 'all', label: 'All' },
                { key: 'article', label: 'Article' },
                { key: 'short', label: 'Shorts' },
                { key: 'course', label: 'Courses' },
                { key: 'workshop', label: 'Workshops' },
                { key: 'audio', label: 'Audio' },
            ],
            categories: categories.map(categoryView),
            tags: tags.filter(Boolean).sort(),
            durations: [
                { key: 'any', label: 'Any length' },
                { key: 'under5', label: 'Under 5 minutes', maxMinutes: 5 },
                { key: '5to15', label: '5 to 15 minutes', minMinutes: 5, maxMinutes: 15 },
                { key: '15to30', label: '15 to 30 minutes', minMinutes: 15, maxMinutes: 30 },
                { key: 'over30', label: '30 minutes and up', minMinutes: 30 },
            ],
            sorts: [
                { key: 'newest', label: 'Newest first' },
                { key: 'oldest', label: 'Oldest first' },
                { key: 'popular', label: 'Most viewed' },
            ],
        });
    } catch (error) {
        console.error('❌ getFilters failed:', error);
        res.status(500).json({ message: 'Could not load filters' });
    }
};

/**
 * One resource, plus "You might also like".
 *
 * The related rail is same-category-excluding-self, falling back to the same type when a
 * category is thin. A rail that renders empty on a new category looks like a bug; three
 * recent pieces of the same kind is a worse recommendation and a better screen.
 */
exports.getResource = async (req, res) => {
    try {
        const resource = await findResource(req.params.idOrSlug);
        if (!resource) return res.status(404).json({ message: 'Resource not found' });

        const userId = req.user?.id || null;
        const [hasPro, engagement] = await Promise.all([
            hasProAccess(req),
            userId ? ResourceEngagement.findOne({ userId, resourceId: resource._id }).lean() : null,
        ]);

        let related = await Resource.find({
            ...PUBLISHED,
            _id: { $ne: resource._id },
            categoryId: resource.categoryId?._id || resource.categoryId,
        }).sort({ publishedAt: -1 }).limit(6).populate(POPULATE);

        if (related.length < 3) {
            related = await Resource.find({ ...PUBLISHED, _id: { $ne: resource._id }, type: resource.type })
                .sort({ publishedAt: -1 }).limit(6).populate(POPULATE);
        }

        res.json({
            resource: detailView(resource, { engagement: userId ? engagement : undefined, hasPro }),
            related: await cardsFor(userId, related),
        });
    } catch (error) {
        console.error('❌ getResource failed:', error);
        res.status(500).json({ message: 'Could not load resource' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// Engagement
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Record that someone opened a resource.
 *
 * `views` is incremented per open, not per unique reader — that is what the design's eye
 * icon means everywhere else on the internet, and de-duplicating it would make the number
 * disagree with the one the website shows for the same article.
 */
exports.recordView = async (req, res) => {
    try {
        const resource = await findResource(req.params.idOrSlug);
        if (!resource) return res.status(404).json({ message: 'Resource not found' });

        await Promise.all([
            Resource.updateOne({ _id: resource._id }, { $inc: { 'stats.views': 1 } }),
            ResourceEngagement.updateOne(
                { userId: req.user.id, resourceId: resource._id },
                { $inc: { viewCount: 1 }, $set: { lastViewedAt: new Date() } },
                { upsert: true },
            ),
        ]);

        res.json({ views: (resource.stats?.views || 0) + 1 });
    } catch (error) {
        console.error('❌ recordView failed:', error);
        res.status(500).json({ message: 'Could not record view' });
    }
};

/**
 * Toggle a like or a save.
 *
 * The engagement row is the source of truth and `stats.likes` is the cache, so the counter
 * moves only when the row's value actually changed. Tapping a filled heart twice on a slow
 * connection must not leave the count two higher than the number of people who liked it.
 */
const toggleFlag = (field, counter) => async (req, res) => {
    try {
        const resource = await findResource(req.params.idOrSlug);
        if (!resource) return res.status(404).json({ message: 'Resource not found' });

        const existing = await ResourceEngagement.findOne({ userId: req.user.id, resourceId: resource._id });
        const next = typeof req.body?.value === 'boolean' ? req.body.value : !existing?.[field];
        const changed = Boolean(existing?.[field]) !== next;

        await ResourceEngagement.updateOne(
            { userId: req.user.id, resourceId: resource._id },
            { $set: { [field]: next } },
            { upsert: true },
        );

        if (changed && counter) {
            await Resource.updateOne({ _id: resource._id }, { $inc: { [counter]: next ? 1 : -1 } });
        }

        const likes = counter
            ? Math.max(0, (resource.stats?.likes || 0) + (changed ? (next ? 1 : -1) : 0))
            : resource.stats?.likes || 0;

        res.json({ [field]: next, likes });
    } catch (error) {
        console.error(`❌ toggle ${field} failed:`, error);
        res.status(500).json({ message: `Could not update ${field}` });
    }
};

exports.toggleLike = toggleFlag('liked', 'stats.likes');
exports.toggleSave = toggleFlag('saved', null);

/**
 * Rate a resource Bad / Neutral / Great.
 *
 * A changed vote replaces the previous one: the delta applied to `ratingSum` is
 * `new - old`, and `ratingCount` moves only on a first vote. Adding every tap would let one
 * person with a slow connection decide an article's average.
 */
exports.rateResource = async (req, res) => {
    try {
        const value = req.body?.rating;
        if (!rating.isValid(value)) {
            return res.status(400).json({ message: 'rating must be one of: bad, neutral, great' });
        }

        const resource = await findResource(req.params.idOrSlug);
        if (!resource) return res.status(404).json({ message: 'Resource not found' });

        const existing = await ResourceEngagement.findOne({ userId: req.user.id, resourceId: resource._id });
        const previous = rating.scoreOf(existing?.rating);
        const next = rating.scoreOf(value);

        await ResourceEngagement.updateOne(
            { userId: req.user.id, resourceId: resource._id },
            { $set: { rating: value, ratedAt: new Date() } },
            { upsert: true },
        );

        await Resource.updateOne({ _id: resource._id }, {
            $inc: {
                'stats.ratingSum': next - (previous || 0),
                'stats.ratingCount': previous ? 0 : 1,
            },
        });

        const sum = (resource.stats?.ratingSum || 0) + next - (previous || 0);
        const count = (resource.stats?.ratingCount || 0) + (previous ? 0 : 1);

        res.json({
            rating: value,
            average: count ? Math.round((sum / count) * 10) / 10 : null,
            ratingCount: count,
        });
    } catch (error) {
        console.error('❌ rateResource failed:', error);
        res.status(500).json({ message: 'Could not save rating' });
    }
};

/**
 * Save playback position.
 *
 * Monotonic: the stored value only moves forward. A player that posts 0 on mount — which
 * every player does — would otherwise erase the position it was about to seek to.
 */
exports.saveProgress = async (req, res) => {
    try {
        const seconds = Number(req.body?.progressSeconds);
        if (!Number.isFinite(seconds) || seconds < 0) {
            return res.status(400).json({ message: 'progressSeconds must be a positive number' });
        }

        const resource = await findResource(req.params.idOrSlug);
        if (!resource) return res.status(404).json({ message: 'Resource not found' });

        const completed = req.body?.completed === true
            || (resource.durationSeconds > 0 && seconds >= resource.durationSeconds * 0.95);

        await ResourceEngagement.updateOne(
            { userId: req.user.id, resourceId: resource._id },
            {
                $max: { progressSeconds: Math.round(seconds) },
                $set: { lastViewedAt: new Date(), ...(completed ? { completedAt: new Date() } : {}) },
            },
            { upsert: true },
        );

        res.json({ progressSeconds: Math.round(seconds), completed });
    } catch (error) {
        console.error('❌ saveProgress failed:', error);
        res.status(500).json({ message: 'Could not save progress' });
    }
};

/** Everything this person saved, newest save first. */
exports.getSaved = async (req, res) => {
    try {
        const rows = await ResourceEngagement.find({ userId: req.user.id, saved: true })
            .sort({ updatedAt: -1 }).limit(100).lean();

        const resources = await Resource.find({ _id: { $in: rows.map((r) => r.resourceId) }, ...PUBLISHED })
            .populate(POPULATE);

        // Preserve save order — `$in` returns in index order, not the order asked for.
        const order = new Map(rows.map((r, i) => [String(r.resourceId), i]));
        resources.sort((a, b) => order.get(String(a._id)) - order.get(String(b._id)));

        res.json({ items: await cardsFor(req.user.id, resources) });
    } catch (error) {
        console.error('❌ getSaved failed:', error);
        res.status(500).json({ message: 'Could not load saved resources' });
    }
};

/**
 * "Continue watching" — started, not finished.
 *
 * Anything completed drops out. A finished course sitting at the top of a resume rail is a
 * row nobody can clear.
 */
exports.getContinue = async (req, res) => {
    try {
        const rows = await ResourceEngagement.find({
            userId: req.user.id,
            progressSeconds: { $gt: 5 },
            completedAt: null,
        }).sort({ lastViewedAt: -1 }).limit(10).lean();

        const resources = await Resource.find({ _id: { $in: rows.map((r) => r.resourceId) }, ...PUBLISHED })
            .populate(POPULATE);

        const order = new Map(rows.map((r, i) => [String(r.resourceId), i]));
        resources.sort((a, b) => order.get(String(a._id)) - order.get(String(b._id)));

        res.json({ items: await cardsFor(req.user.id, resources) });
    } catch (error) {
        console.error('❌ getContinue failed:', error);
        res.status(500).json({ message: 'Could not load your progress' });
    }
};

/**
 * Register interest in a workshop.
 *
 * **This does not sell a seat.** The design's Checkout button carries a price, and payment
 * runs through `/api/payments` and `Order`; wiring a free "Join" to it here would mean a
 * paid workshop could be joined by anyone who found the endpoint. This records the intent
 * and moves the attendee count, which is what the "1,272 Joined" avatars read from. A paid
 * workshop returns the price and refuses, so the client routes to checkout.
 */
exports.joinWorkshop = async (req, res) => {
    try {
        const resource = await findResource(req.params.idOrSlug);
        if (!resource) return res.status(404).json({ message: 'Resource not found' });
        if (resource.type !== 'workshop') {
            return res.status(400).json({ message: 'Only workshops can be joined' });
        }

        if (resource.workshop?.priceCents > 0) {
            return res.status(402).json({
                message: 'This workshop requires payment',
                priceCents: resource.workshop.priceCents,
                currency: resource.workshop.currency || 'GBP',
            });
        }

        const existing = await ResourceEngagement.findOne({ userId: req.user.id, resourceId: resource._id });
        if (!existing?.saved) {
            await Promise.all([
                ResourceEngagement.updateOne(
                    { userId: req.user.id, resourceId: resource._id },
                    { $set: { saved: true } },
                    { upsert: true },
                ),
                Resource.updateOne({ _id: resource._id }, { $inc: { 'workshop.attendeeCount': 1 } }),
            ]);
        }

        res.json({ joined: true, attendeeCount: (resource.workshop?.attendeeCount || 0) + (existing?.saved ? 0 : 1) });
    } catch (error) {
        console.error('❌ joinWorkshop failed:', error);
        res.status(500).json({ message: 'Could not join workshop' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// Authors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Speaker Details — the author, their content split into the design's three tabs, and the
 * star breakdown.
 *
 * The histogram is counted from the engagement rows because `stats.ratingSum` cannot be
 * un-averaged back into buckets. One aggregation, and only on this screen.
 */
exports.getAuthor = async (req, res) => {
    try {
        const author = await ResourceAuthor.findOne({ slug: String(req.params.slug).toLowerCase() });
        if (!author) return res.status(404).json({ message: 'Author not found' });

        const userId = req.user?.id || null;

        const published = await Resource.find({ ...PUBLISHED, authorId: author._id })
            .sort({ publishedAt: -1 }).populate(POPULATE);

        const counts = await ResourceEngagement.aggregate([
            { $match: { resourceId: { $in: published.map((r) => r._id) }, rating: { $ne: null } } },
            { $group: { _id: '$rating', count: { $sum: 1 } } },
        ]);
        const ratingCounts = Object.fromEntries(counts.map((c) => [c._id, c.count]));

        const following = userId
            ? Boolean(await ResourceAuthorFollow.exists({ userId, authorId: author._id }))
            : undefined;

        const isVideo = (r) => r.type === 'short' || r.type === 'course' || Boolean(r.media?.videoUrl);
        const cards = await cardsFor(userId, published);
        const byId = new Map(published.map((r, i) => [String(r._id), cards[i]]));

        res.json({
            author: authorDetailView(author, {
                ratingCounts,
                following,
                courses: published.filter((r) => r.type === 'course').map((r) => byId.get(String(r._id))),
                videos: published.filter(isVideo).map((r) => byId.get(String(r._id))),
            }),
            resources: cards,
        });
    } catch (error) {
        console.error('❌ getAuthor failed:', error);
        res.status(500).json({ message: 'Could not load author' });
    }
};

/**
 * Follow or unfollow an author.
 *
 * The unique index on `{ userId, authorId }` is what makes the counter safe: a duplicate
 * insert from a second device is rejected by the database rather than counted twice.
 */
exports.toggleFollow = async (req, res) => {
    try {
        const author = await ResourceAuthor.findOne({ slug: String(req.params.slug).toLowerCase() }).select('_id followerCount');
        if (!author) return res.status(404).json({ message: 'Author not found' });

        const existing = await ResourceAuthorFollow.findOne({ userId: req.user.id, authorId: author._id });
        const next = typeof req.body?.value === 'boolean' ? req.body.value : !existing;

        if (next && !existing) {
            await ResourceAuthorFollow.create({ userId: req.user.id, authorId: author._id });
            await ResourceAuthor.updateOne({ _id: author._id }, { $inc: { followerCount: 1 } });
        } else if (!next && existing) {
            await ResourceAuthorFollow.deleteOne({ _id: existing._id });
            await ResourceAuthor.updateOne(
                { _id: author._id, followerCount: { $gt: 0 } },
                { $inc: { followerCount: -1 } },
            );
        }

        const delta = (next && !existing) ? 1 : (!next && existing) ? -1 : 0;
        res.json({ following: next, followerCount: Math.max(0, (author.followerCount || 0) + delta) });
    } catch (error) {
        // A racing duplicate is the index doing its job, not a failure the person caused.
        if (error.code === 11000) return res.json({ following: true });
        console.error('❌ toggleFollow failed:', error);
        res.status(500).json({ message: 'Could not update follow' });
    }
};

exports.listAuthors = async (req, res) => {
    try {
        const authors = await ResourceAuthor.find({ active: true }).sort({ followerCount: -1, name: 1 }).limit(50);
        res.json({ items: authors.map((a) => authorDetailView(a, {})) });
    } catch (error) {
        console.error('❌ listAuthors failed:', error);
        res.status(500).json({ message: 'Could not load authors' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// Authoring — admin only, enforced in the router
// ─────────────────────────────────────────────────────────────────────────────

/** Fields a client may set. Everything else — counters, derived length — is ours. */
const WRITABLE = [
    'type', 'title', 'subtitle', 'excerpt', 'categoryId', 'tags', 'authorId', 'heroImage',
    'thumbnail', 'body', 'media', 'course', 'workshop', 'readMinutes', 'durationSeconds',
    'status', 'publishedAt', 'featured', 'isPro', 'freeBlockCount', 'source',
];

const pickWritable = (payload) => Object.fromEntries(
    Object.entries(payload || {}).filter(([k]) => WRITABLE.includes(k))
);

/**
 * Resolve `category` / `author` given as slugs.
 *
 * An import from the website knows "sleep", not an ObjectId, and requiring it to look one up
 * first turns a single POST into a fetch-then-post per article.
 */
const resolveRefs = async (payload) => {
    const patch = { ...payload };

    if (patch.categorySlug) {
        const category = await ResourceCategory.findOne({ slug: String(patch.categorySlug).toLowerCase() }).select('_id');
        if (!category) throw Object.assign(new Error(`Unknown category: ${patch.categorySlug}`), { status: 400 });
        patch.categoryId = category._id;
        delete patch.categorySlug;
    }

    if (patch.authorSlug) {
        const author = await ResourceAuthor.findOne({ slug: String(patch.authorSlug).toLowerCase() }).select('_id');
        if (!author) throw Object.assign(new Error(`Unknown author: ${patch.authorSlug}`), { status: 400 });
        patch.authorId = author._id;
        delete patch.authorSlug;
    }

    return patch;
};

exports.createResource = async (req, res, next) => {
    try {
        const payload = await resolveRefs({ ...req.body });
        const doc = pickWritable(payload);
        doc.slug = slugify(req.body.slug || req.body.title);
        if (!doc.slug) return res.status(400).json({ message: 'A title or slug is required' });

        const resource = await Resource.create(doc);
        await resource.populate(POPULATE);
        console.log(`📚 Resource created: ${resource.type} / ${resource.slug}`);
        res.status(201).json({ resource: detailView(resource, { hasPro: true }) });
    } catch (error) {
        next(error);
    }
};

exports.updateResource = async (req, res, next) => {
    try {
        const payload = await resolveRefs({ ...req.body });
        const resource = await Resource.findById(req.params.id);
        if (!resource) return res.status(404).json({ message: 'Resource not found' });

        Object.assign(resource, pickWritable(payload));
        if (req.body.slug) resource.slug = slugify(req.body.slug);

        // `save()` rather than `findByIdAndUpdate` on purpose: the pre-validate hook is what
        // keeps `lengthMinutes` and `sessionCount` in step with what was just written, and
        // `findByIdAndUpdate` skips it. That is gotcha 10 in CLAUDE.md, not repeated here.
        await resource.save();
        await resource.populate(POPULATE);
        res.json({ resource: detailView(resource, { hasPro: true }) });
    } catch (error) {
        next(error);
    }
};

exports.deleteResource = async (req, res, next) => {
    try {
        // Archive, never destroy: engagement rows reference this id, and a hard delete turns
        // every person's saved list and reading history into dangling ids. `?purge=true`
        // is the deliberate escape hatch, the same one `DELETE /medications/:id` offers.
        if (req.query.purge === 'true') {
            const removed = await Resource.findByIdAndDelete(req.params.id);
            if (!removed) return res.status(404).json({ message: 'Resource not found' });
            await ResourceEngagement.deleteMany({ resourceId: removed._id });
            return res.json({ message: 'Resource purged' });
        }

        const resource = await Resource.findByIdAndUpdate(
            req.params.id, { $set: { status: 'archived' } }, { new: true },
        );
        if (!resource) return res.status(404).json({ message: 'Resource not found' });
        res.json({ message: 'Resource archived', status: resource.status });
    } catch (error) {
        next(error);
    }
};

/**
 * Bulk import from the marketing site.
 *
 * Idempotent by design: each item is upserted on `{ source.name, source.externalId }`, the
 * pair the partial unique index constrains. Re-running an import updates in place instead of
 * publishing a second copy of every article, which is what makes it safe to put on a timer.
 *
 * Failures are per item, not per batch. One malformed article out of two hundred must not
 * roll back the other hundred and ninety-nine, and the response names which ones failed and
 * why so the mapping on the website's side can be fixed.
 */
exports.importResources = async (req, res) => {
    try {
        const items = Array.isArray(req.body?.items) ? req.body.items : null;
        if (!items) return res.status(400).json({ message: 'Body must be { items: [...] }' });
        if (items.length > 500) return res.status(413).json({ message: 'Import at most 500 items per request' });

        const sourceName = req.body.source || 'website';
        const results = { created: 0, updated: 0, failed: [] };

        for (const [index, item] of items.entries()) {
            try {
                const payload = await resolveRefs({ ...item });
                const doc = pickWritable(payload);
                const externalId = String(item.externalId || item.id || '').trim();
                if (!externalId) throw new Error('externalId is required for an import');

                doc.source = {
                    name: sourceName,
                    externalId,
                    url: item.url || null,
                    importedAt: new Date(),
                };
                doc.slug = slugify(item.slug || item.title);

                const existing = await Resource.findOne({
                    'source.name': sourceName,
                    'source.externalId': externalId,
                });

                if (existing) {
                    Object.assign(existing, doc);
                    await existing.save();
                    results.updated += 1;
                } else {
                    await Resource.create(doc);
                    results.created += 1;
                }
            } catch (error) {
                results.failed.push({ index, externalId: item.externalId || item.id || null, error: error.message });
            }
        }

        console.log(`📚 Import from ${sourceName}: +${results.created} ~${results.updated} ✗${results.failed.length}`);
        res.json(results);
    } catch (error) {
        console.error('❌ importResources failed:', error);
        res.status(500).json({ message: 'Import failed' });
    }
};

/** Create or update a category by slug. Upsert so an import can declare its own taxonomy. */
exports.upsertCategory = async (req, res, next) => {
    try {
        const slug = slugify(req.body.slug || req.body.name);
        if (!slug) return res.status(400).json({ message: 'A name or slug is required' });

        const category = await ResourceCategory.findOneAndUpdate(
            { slug },
            {
                $set: {
                    name: req.body.name,
                    group: req.body.group,
                    ...(req.body.icon ? { icon: req.body.icon } : {}),
                    ...(req.body.order != null ? { order: req.body.order } : {}),
                    ...(req.body.groupOrder != null ? { groupOrder: req.body.groupOrder } : {}),
                    ...(req.body.active != null ? { active: req.body.active } : {}),
                },
                $setOnInsert: { slug },
            },
            { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
        );

        res.json({ category: categoryView(category) });
    } catch (error) {
        next(error);
    }
};

exports.upsertAuthor = async (req, res, next) => {
    try {
        const slug = slugify(req.body.slug || req.body.name);
        if (!slug) return res.status(400).json({ message: 'A name or slug is required' });

        const fields = ['name', 'speciality', 'headline', 'avatar', 'coverImage', 'bio',
            'achievements', 'contact', 'socials', 'professionalId', 'active'];
        const $set = Object.fromEntries(
            Object.entries(req.body).filter(([k, v]) => fields.includes(k) && v !== undefined)
        );

        const author = await ResourceAuthor.findOneAndUpdate(
            { slug },
            { $set, $setOnInsert: { slug } },
            { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
        );

        res.json({ author: authorDetailView(author, {}) });
    } catch (error) {
        next(error);
    }
};

// Exported for the tests, which assert the slug rules without going through HTTP.
exports._internal = { slugify, hasProAccess };
