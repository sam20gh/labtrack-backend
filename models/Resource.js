const mongoose = require('mongoose');

/**
 * One piece of health content: an article, a short, a course, a workshop, or an audio piece.
 *
 * ## Why one collection and not five
 *
 * The design's Resources home draws all five in one scroll, its search returns all five
 * ranked together behind an "All" tab, and its filter sheet treats type as one facet among
 * Category and Duration. Five collections means a five-way union on every one of those
 * screens, five sets of near-identical CRUD, and a search that cannot rank across them.
 *
 * The shape is genuinely shared — a title, a hero image, an author, a category, a length, an
 * engagement count. What differs is carried in three small sub-documents (`media`, `course`,
 * `workshop`) that only the relevant type populates, and the controller validates per type
 * before writing. This is the same call `MetricLog` makes for weight/water/blood pressure.
 *
 * ## Body is blocks, not HTML
 *
 * Article Details renders headings, paragraphs, images and a green-ticked benefits checklist.
 * Storing that as HTML would put a rendering decision in the content and require an HTML
 * renderer (and its sanitiser) on the phone. Blocks are typed data the client draws with its
 * own components, which is also what keeps a piece imported from the website looking like it
 * belongs in the app rather than like a web page in a WebView.
 *
 * ## Pro gating happens on the server
 *
 * `isPro` content is truncated to `freeBlockCount` blocks **before it leaves the API** for a
 * reader without a subscription. A paywall enforced by the client is a paywall in the
 * response body, one `console.log` from being read.
 *
 * ## Counters
 *
 * `stats.views/likes/comments` are `$inc`-ed caches. Likes have a source of truth in
 * `ResourceEngagement`; views and comments do not and are the counter itself. `ratingSum`
 * and `ratingCount` are moved by the rating endpoint, which reads the person's previous
 * rating first so a changed vote replaces rather than adds.
 */

const BLOCK_TYPES = ['paragraph', 'heading', 'list', 'checklist', 'image', 'quote', 'callout'];

const BlockSchema = new mongoose.Schema({
    type: { type: String, required: true, enum: BLOCK_TYPES },
    /** paragraph / heading / quote / callout */
    text: { type: String, default: null },
    /** list / checklist */
    items: { type: [String], default: undefined },
    /** image */
    url: { type: String, default: null },
    caption: { type: String, default: null },
}, { _id: false });

/** One line of a transcript, so the audio player can highlight the sentence being spoken. */
const TranscriptCueSchema = new mongoose.Schema({
    startSeconds: { type: Number, required: true },
    endSeconds: { type: Number, default: null },
    text: { type: String, required: true },
}, { _id: false });

/** One lesson inside a course. The Featured Course card lists these with a play button. */
const SessionSchema = new mongoose.Schema({
    title: { type: String, required: true, trim: true },
    durationSeconds: { type: Number, default: 0, min: 0 },
    videoUrl: { type: String, default: null },
    audioUrl: { type: String, default: null },
    thumbnail: { type: String, default: null },
    /** Free preview lessons stay playable on a Pro course. */
    preview: { type: Boolean, default: false },
}, { _id: true });

const ResourceSchema = new mongoose.Schema({
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },

    type: {
        type: String,
        required: true,
        enum: ['article', 'short', 'course', 'workshop', 'audio'],
        index: true,
    },

    title: { type: String, required: true, trim: true },
    subtitle: { type: String, default: null, trim: true },
    /** The card summary. Never the first paragraph of the body sliced at 120 characters. */
    excerpt: { type: String, default: '', trim: true },

    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'ResourceCategory', required: true, index: true },
    /** Free-text chips that are not categories: "Tips & Tricks", "Health Metrics". */
    tags: { type: [String], default: [] },

    authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'ResourceAuthor', default: null, index: true },

    heroImage: { type: String, default: null },
    /** 16:9 for cards, 9:16 for shorts. Falls back to `heroImage` when absent. */
    thumbnail: { type: String, default: null },

    body: { type: [BlockSchema], default: [] },

    media: {
        videoUrl: { type: String, default: null },
        audioUrl: { type: String, default: null },
        /** Vertical source for a short, where it differs from `videoUrl`. */
        transcript: { type: [TranscriptCueSchema], default: [] },
        captionsUrl: { type: String, default: null },
    },

    course: {
        sessions: { type: [SessionSchema], default: [] },
        /** Drawn on the Featured Course card as "5 SESSIONS". Derived on save. */
        sessionCount: { type: Number, default: 0 },
    },

    workshop: {
        startsAt: { type: Date, default: null },
        endsAt: { type: Date, default: null },
        mode: { type: String, enum: ['online', 'in_person', 'hybrid', null], default: null },
        locationName: { type: String, default: null },
        address: { type: String, default: null },
        timezone: { type: String, default: null },
        whoShouldAttend: { type: [String], default: [] },
        topics: {
            type: [new mongoose.Schema({
                title: { type: String, required: true },
                detail: { type: String, default: '' },
            }, { _id: false })],
            default: [],
        },
        priceCents: { type: Number, default: null, min: 0 },
        compareAtCents: { type: Number, default: null, min: 0 },
        currency: { type: String, default: 'GBP' },
        capacity: { type: Number, default: null, min: 0 },
        /** Cache, moved by the join endpoint. */
        attendeeCount: { type: Number, default: 0, min: 0 },
    },

    // ── length ──────────────────────────────────────────────────────────────
    /** Articles and workshops: "3m read". */
    readMinutes: { type: Number, default: null, min: 0 },
    /** Shorts, audio and courses: the runtime, rendered "12:00". */
    durationSeconds: { type: Number, default: null, min: 0 },
    /**
     * Whichever of the two this resource has, in minutes, so the filter sheet's Duration
     * facet is one indexable comparison rather than a `$or` over two fields with different
     * units. Derived on save — never set it by hand.
     */
    lengthMinutes: { type: Number, default: 0, min: 0, index: true },

    // ── publishing ──────────────────────────────────────────────────────────
    status: { type: String, enum: ['draft', 'published', 'archived'], default: 'draft', index: true },
    publishedAt: { type: Date, default: null },

    /** Promoted into the "Featured Resources" rail on the hub. */
    featured: { type: Boolean, default: false },

    isPro: { type: Boolean, default: false },
    /** How much of a Pro piece a free reader sees before the Go Pro banner. */
    freeBlockCount: { type: Number, default: 3, min: 0 },

    /**
     * Provenance for content imported from the marketing site.
     *
     * `POST /resources/import` upserts on `{ source.name, source.externalId }`, so re-running
     * an import updates in place instead of publishing a second copy of every article. That
     * pair is what makes the import safe to run on a schedule.
     */
    source: {
        name: { type: String, default: null },
        externalId: { type: String, default: null },
        url: { type: String, default: null },
        importedAt: { type: Date, default: null },
    },

    stats: {
        views: { type: Number, default: 0, min: 0 },
        likes: { type: Number, default: 0, min: 0 },
        /**
         * Carried because every card in the design shows one. There is no comment model:
         * a comment thread on health content needs moderation, reporting and a policy, and
         * shipping the counter without those would be a dummy control. Imports may set it;
         * nothing in the app increments it.
         */
        comments: { type: Number, default: 0, min: 0 },
        ratingSum: { type: Number, default: 0, min: 0 },
        ratingCount: { type: Number, default: 0, min: 0 },
    },
}, { timestamps: true });

// Browse: one type, newest first. The hub, the four list screens and the category pages.
ResourceSchema.index({ status: 1, type: 1, publishedAt: -1 });
ResourceSchema.index({ status: 1, categoryId: 1, publishedAt: -1 });
ResourceSchema.index({ status: 1, featured: 1, publishedAt: -1 });
// Popularity sort, offered as "Most viewed" beside "Newest first".
ResourceSchema.index({ status: 1, 'stats.views': -1 });
// Import idempotency. Partial so the millions of hand-authored rows with no source are
// not all colliding on { null, null }.
ResourceSchema.index(
    { 'source.name': 1, 'source.externalId': 1 },
    { unique: true, partialFilterExpression: { 'source.externalId': { $type: 'string' } } },
);
ResourceSchema.index({ title: 'text', excerpt: 'text', tags: 'text' });

/** Derived fields. Kept in one hook so nothing can write a length that disagrees with itself. */
ResourceSchema.pre('validate', function deriveFields() {
    this.course.sessionCount = this.course?.sessions?.length || 0;

    if (this.type === 'course' && this.course.sessions.length && !this.durationSeconds) {
        this.durationSeconds = this.course.sessions.reduce((t, s) => t + (s.durationSeconds || 0), 0);
    }

    this.lengthMinutes = this.readMinutes != null
        ? Math.round(this.readMinutes)
        : Math.round((this.durationSeconds || 0) / 60);

    if (this.status === 'published' && !this.publishedAt) this.publishedAt = new Date();
});

module.exports = mongoose.model('Resource', ResourceSchema);
module.exports.BLOCK_TYPES = BLOCK_TYPES;
