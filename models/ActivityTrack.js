const mongoose = require('mongoose');

/**
 * The full-resolution GPS track behind one live `ActivitySession`.
 *
 * Its own collection for the reason `EcgRecording` is: a trace is thousands of samples, and
 * the session row is loaded by every list, calendar and dashboard query. The row carries the
 * *simplified* `route` for drawing; this carries what the numbers were computed from, and is
 * read only by the replay and by a recompute.
 *
 * **Columnar**, not an array of point objects. Six parallel number arrays are a fraction of
 * the BSON of 7,000 small documents-within-a-document, and the shape is exactly what the
 * phone uploads and what `trackMetrics.computeTrack` reads.
 *
 * Location history is the most identifying thing this app stores after a name. It is
 * deleted with its session (`deleteSession`), never exposed to the clinician portal, and
 * nothing copies it anywhere else.
 */
const ActivityTrackSchema = new mongoose.Schema({
    sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'ActivitySession', required: true, unique: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /** Milliseconds since the epoch, one per fix. */
    t: { type: [Number], default: undefined },
    lat: { type: [Number], default: undefined },
    lng: { type: [Number], default: undefined },
    /** Metres. `null` entries where the fix carried none. */
    alt: { type: [Number], default: undefined },
    /** Horizontal accuracy, metres, as the OS reported it. */
    acc: { type: [Number], default: undefined },
    /**
     * Heart rate aligned to the fix, where a live source supplied one. See `hrSource`.
     *
     * This is not the bracelet's stream stored a second time: `lib/health/jstyle/live.ts`
     * still stores nothing per-second as `HeartRateSample`. It is the heart rate *of this
     * run*, kept beside the positions it happened at, so splits and zones can be derived.
     */
    hr: { type: [Number], default: undefined },
    /** Manual pauses, `[startMs, endMs]`. Auto-pause is recomputed, never stored. */
    pauses: { type: [[Number]], default: undefined },

    hrSource: { type: String, enum: ['bracelet_live', null], default: null },
    /** The phone's own step count over the session, if it had a pedometer. */
    steps: { type: Number, min: 0 },
}, { timestamps: true });

module.exports = mongoose.model('ActivityTrack', ActivityTrackSchema);
