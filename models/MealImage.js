const mongoose = require('mongoose');

/**
 * One Unsplash search, cached and shared across everyone.
 *
 * Keyed on the normalised query, not on a person: "overnight oats" is the same search for
 * every account, and the Unsplash demo tier allows 50 requests an hour for the whole app.
 * A per-person cache would spend that allowance on repeats within minutes.
 *
 * Several candidates are kept rather than one because the choice between them is
 * per-person — `mealImages.pickPhoto` skips a photo whose description mentions something
 * this person cannot eat — and that choice must not cost another request.
 *
 * Nothing here is patient data. It records what a dish name searched for, never who asked.
 */
const PhotoSchema = new mongoose.Schema({
    id: { type: String, required: true },
    /** `urls.raw` — sized per surface with imgix parameters, never re-hosted. */
    raw: { type: String, required: true },
    blurHash: { type: String },
    color: { type: String },
    /** Unsplash's own words about the picture. What the allergen check reads. */
    description: { type: String },
    tags: [{ type: String }],
    author: { type: String },
    authorUrl: { type: String },
    photoUrl: { type: String },
    /** Pinged once when a photo is first shown, per the API guidelines. */
    downloadLocation: { type: String },
}, { _id: false });

const MealImageSchema = new mongoose.Schema({
    query: { type: String, required: true, unique: true },
    /** Empty is a result too: a query that found nothing is not retried every hour. */
    photos: [PhotoSchema],
    fetchedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('MealImage', MealImageSchema);
