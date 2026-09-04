/**
 * Turning a `Resource` document into what a screen actually needs.
 *
 * Three shapes, and the split is the point:
 *
 *   `cardView`   — everything a list, rail or search result draws, and **nothing else**. No
 *                  body, no transcript, no session list. The hub asks for about forty of
 *                  these in one call; shipping each one's article body with it is how a
 *                  200KB response becomes 4MB on a phone connection.
 *
 *   `detailView` — one resource in full, with the Pro paywall already applied.
 *
 *   `editView`   — one resource as it is *stored*, for the portal's editor. Ungated, and
 *                  admin-only in the router. See its own note for why the reading shape
 *                  cannot be saved back.
 *
 * ## The paywall is applied here
 *
 * `gateBody` truncates a Pro piece to `freeBlockCount` blocks and sets `locked: true` before
 * the document leaves the process. Sending the whole body with a flag telling the client not
 * to render it is not a paywall — it is the article, in the response, with a note attached.
 * The same rule covers `media` and course sessions: a locked resource's video and audio URLs
 * are stripped, and only sessions marked `preview` keep theirs.
 */

const { histogramFrom } = require('./resourceRating');

/** Populated ref, raw id, or null → a plain id string or null. */
const idOf = (ref) => (ref && (ref._id || ref)) ? String(ref._id || ref) : null;

const authorView = (author) => {
    if (!author || !author.name) return null;
    return {
        id: idOf(author),
        slug: author.slug,
        name: author.name,
        speciality: author.speciality || null,
        headline: author.headline || null,
        avatar: author.avatar || null,
    };
};

const categoryView = (category) => {
    if (!category || !category.name) return null;
    return {
        id: idOf(category),
        slug: category.slug,
        name: category.name,
        group: category.group,
        icon: category.icon,
    };
};

/**
 * The engagement counters, plus this reader's own state where a reader is known.
 *
 * `liked`/`saved`/`rating` are absent rather than false for an anonymous read, so a screen
 * cannot draw an empty heart that means "we don't know" as though it meant "not liked".
 */
const statsView = (resource, engagement) => ({
    views: resource.stats?.views || 0,
    likes: resource.stats?.likes || 0,
    comments: resource.stats?.comments || 0,
    rating: resource.stats?.ratingCount
        ? Math.round((resource.stats.ratingSum / resource.stats.ratingCount) * 10) / 10
        : null,
    ratingCount: resource.stats?.ratingCount || 0,
    ...(engagement === undefined ? {} : {
        liked: Boolean(engagement?.liked),
        saved: Boolean(engagement?.saved),
        myRating: engagement?.rating || null,
        progressSeconds: engagement?.progressSeconds || 0,
    }),
});

const cardView = (resource, engagement) => ({
    id: String(resource._id),
    slug: resource.slug,
    type: resource.type,
    title: resource.title,
    subtitle: resource.subtitle || null,
    excerpt: resource.excerpt || '',
    thumbnail: resource.thumbnail || resource.heroImage || null,
    heroImage: resource.heroImage || null,
    tags: resource.tags || [],
    category: categoryView(resource.categoryId),
    author: authorView(resource.authorId),
    readMinutes: resource.readMinutes ?? null,
    durationSeconds: resource.durationSeconds ?? null,
    lengthMinutes: resource.lengthMinutes || 0,
    sessionCount: resource.course?.sessionCount || 0,
    isPro: Boolean(resource.isPro),
    featured: Boolean(resource.featured),
    publishedAt: resource.publishedAt,
    stats: statsView(resource, engagement),
    ...(resource.type === 'workshop' ? {
        workshop: {
            startsAt: resource.workshop?.startsAt || null,
            mode: resource.workshop?.mode || null,
            priceCents: resource.workshop?.priceCents ?? null,
            compareAtCents: resource.workshop?.compareAtCents ?? null,
            currency: resource.workshop?.currency || 'GBP',
            attendeeCount: resource.workshop?.attendeeCount || 0,
        },
    } : {}),
});

/**
 * Apply the paywall.
 *
 * @returns `{ body, locked, hiddenBlocks }` — `locked` is what draws the Go Pro banner, and
 *          `hiddenBlocks` is what lets it say how much is behind it rather than just "more".
 */
const gateBody = (resource, hasPro) => {
    const body = resource.body || [];
    if (!resource.isPro || hasPro) return { body, locked: false, hiddenBlocks: 0 };

    const free = body.slice(0, resource.freeBlockCount ?? 3);
    return { body: free, locked: true, hiddenBlocks: Math.max(0, body.length - free.length) };
};

const sessionView = (session, locked) => ({
    id: String(session._id),
    title: session.title,
    durationSeconds: session.durationSeconds || 0,
    thumbnail: session.thumbnail || null,
    preview: Boolean(session.preview),
    // A locked course keeps its lesson list — that is the sales pitch — but only the
    // lessons marked as previews keep a playable URL.
    videoUrl: !locked || session.preview ? session.videoUrl || null : null,
    audioUrl: !locked || session.preview ? session.audioUrl || null : null,
});

const detailView = (resource, { engagement, hasPro = false } = {}) => {
    const { body, locked, hiddenBlocks } = gateBody(resource, hasPro);

    return {
        ...cardView(resource, engagement),
        body,
        locked,
        hiddenBlocks,
        media: {
            videoUrl: locked ? null : resource.media?.videoUrl || null,
            audioUrl: locked ? null : resource.media?.audioUrl || null,
            captionsUrl: locked ? null : resource.media?.captionsUrl || null,
            transcript: locked ? [] : resource.media?.transcript || [],
        },
        course: resource.type === 'course' ? {
            sessionCount: resource.course?.sessionCount || 0,
            sessions: (resource.course?.sessions || []).map((s) => sessionView(s, locked)),
        } : null,
        workshop: resource.type === 'workshop' ? {
            startsAt: resource.workshop?.startsAt || null,
            endsAt: resource.workshop?.endsAt || null,
            mode: resource.workshop?.mode || null,
            locationName: resource.workshop?.locationName || null,
            address: resource.workshop?.address || null,
            timezone: resource.workshop?.timezone || null,
            whoShouldAttend: resource.workshop?.whoShouldAttend || [],
            topics: resource.workshop?.topics || [],
            priceCents: resource.workshop?.priceCents ?? null,
            compareAtCents: resource.workshop?.compareAtCents ?? null,
            currency: resource.workshop?.currency || 'GBP',
            capacity: resource.workshop?.capacity ?? null,
            attendeeCount: resource.workshop?.attendeeCount || 0,
        } : null,
        source: resource.source?.url ? { name: resource.source.name, url: resource.source.url } : null,
    };
};

/**
 * The editorial shape: one resource exactly as it is stored, for the portal's editor.
 *
 * `detailView` is deliberately unusable for this. It is a *reading* shape — the body is
 * already gated, `categoryId`/`authorId` have become populated display objects, and
 * `status`, `freeBlockCount` and `source.externalId` are absent because no reader needs
 * them. An editor loading that and saving it back would publish a truncated article, blank
 * the piece's category, and reset its paywall depth, all silently.
 *
 * So this one round-trips: every writable field, under the name the API writes it by, with
 * nothing withheld. The paywall does not apply because the paywall is about readers, and
 * the person holding this response is the one who set it. It is admin-only in the router
 * for exactly that reason.
 *
 * `category` and `author` ride along as display objects so the form can label its pickers
 * without a second fetch — and so a piece filed under a category that has since been
 * deactivated still shows the name it actually has rather than an empty select.
 */
const editView = (resource) => ({
    _id: String(resource._id),
    slug: resource.slug,
    type: resource.type,
    title: resource.title,
    subtitle: resource.subtitle || null,
    excerpt: resource.excerpt || '',

    categoryId: idOf(resource.categoryId),
    authorId: idOf(resource.authorId),
    category: categoryView(resource.categoryId),
    author: authorView(resource.authorId),
    tags: resource.tags || [],

    heroImage: resource.heroImage || null,
    thumbnail: resource.thumbnail || null,

    body: (resource.body || []).map((block) => ({
        type: block.type,
        text: block.text ?? null,
        items: block.items || [],
        url: block.url ?? null,
        caption: block.caption ?? null,
    })),

    media: {
        videoUrl: resource.media?.videoUrl || null,
        audioUrl: resource.media?.audioUrl || null,
        captionsUrl: resource.media?.captionsUrl || null,
        transcript: (resource.media?.transcript || []).map((cue) => ({
            startSeconds: cue.startSeconds,
            endSeconds: cue.endSeconds ?? null,
            text: cue.text,
        })),
    },

    course: {
        sessionCount: resource.course?.sessionCount || 0,
        // `_id`, not `id`: sessions are sub-documents and the editor sends the list back
        // whole. Dropping the ids would make every save mint new ones, which is how a
        // typo-fix on a lesson title turns into five brand-new lessons.
        sessions: (resource.course?.sessions || []).map((session) => ({
            _id: String(session._id),
            title: session.title,
            durationSeconds: session.durationSeconds || 0,
            videoUrl: session.videoUrl || null,
            audioUrl: session.audioUrl || null,
            thumbnail: session.thumbnail || null,
            preview: Boolean(session.preview),
        })),
    },

    workshop: {
        startsAt: resource.workshop?.startsAt || null,
        endsAt: resource.workshop?.endsAt || null,
        mode: resource.workshop?.mode || null,
        locationName: resource.workshop?.locationName || null,
        address: resource.workshop?.address || null,
        timezone: resource.workshop?.timezone || null,
        whoShouldAttend: resource.workshop?.whoShouldAttend || [],
        topics: (resource.workshop?.topics || []).map((topic) => ({
            title: topic.title,
            detail: topic.detail || '',
        })),
        priceCents: resource.workshop?.priceCents ?? null,
        compareAtCents: resource.workshop?.compareAtCents ?? null,
        currency: resource.workshop?.currency || 'GBP',
        capacity: resource.workshop?.capacity ?? null,
        attendeeCount: resource.workshop?.attendeeCount || 0,
    },

    readMinutes: resource.readMinutes ?? null,
    durationSeconds: resource.durationSeconds ?? null,
    lengthMinutes: resource.lengthMinutes || 0,

    status: resource.status,
    publishedAt: resource.publishedAt || null,
    featured: Boolean(resource.featured),
    isPro: Boolean(resource.isPro),
    freeBlockCount: resource.freeBlockCount ?? 3,

    source: {
        name: resource.source?.name || null,
        externalId: resource.source?.externalId || null,
        url: resource.source?.url || null,
        importedAt: resource.source?.importedAt || null,
    },

    /** Read-only context. Counters are moved by engagement, never by this form. */
    stats: statsView(resource),
    createdAt: resource.createdAt || null,
    updatedAt: resource.updatedAt || null,
});

const authorDetailView = (author, { ratingCounts, following, courses = [], videos = [] } = {}) => ({
    ...authorView(author),
    coverImage: author.coverImage || null,
    bio: author.bio || '',
    achievements: author.achievements || [],
    contact: {
        tel: author.contact?.tel || null,
        email: author.contact?.email || null,
        fax: author.contact?.fax || null,
    },
    socials: Object.fromEntries(
        Object.entries(author.socials?.toObject?.() || author.socials || {}).filter(([, v]) => v)
    ),
    professionalId: idOf(author.professionalId),
    followerCount: author.followerCount || 0,
    ...(following === undefined ? {} : { following }),
    rating: histogramFrom(ratingCounts),
    courseCount: courses.length,
    courses,
    videos,
});

module.exports = { cardView, detailView, editView, authorView, authorDetailView, categoryView, gateBody, statsView };
