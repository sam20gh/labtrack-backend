const mongoose = require('mongoose');

/**
 * A stretch of time a bracelet's own clock was wrong, and what to do with what it stamped.
 *
 * Every record a J-Style bracelet hands over is timestamped from its own clock, and the phone
 * sets that clock at the start of every sync. On 2026-10-01 a V8 was found running 10h 34m
 * behind for an hour and a half after a sync — it had gone back to roughly the time the sync
 * before had set — so a morning nap arrived filed as the previous evening, and its
 * temperature and SpO2 readings landed in an hour that already held real ones. Seven such
 * stretches were found in four days of data. See `utils/clockFault.js` for the rules.
 *
 * One row per stretch. **Not a reading and not the person's data**, so nothing on a patient
 * screen reads it; it exists so the next sync that re-sends a mis-stamped record — the band
 * never deletes sleep or blood pressure, so every sync does — is corrected the same way the
 * first one was, and so the stretches can be counted.
 *
 * All instants in `window` are **band time** — the clock the stamps were written in — and
 * everything else is real time.
 */
const ClockFaultSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    platform: { type: String, enum: ['jstyle_bracelet'], required: true },

    /**
     * `jstyle:<deviceId>:`. Only rows whose `externalId` starts with this are ever judged, so
     * a different bracelet paired later cannot have its readings caught by this stretch.
     */
    idPrefix: { type: String, required: true },

    /** Real time minus band time. Positive: the band was behind. */
    skewSec: { type: Number, required: true },

    /** The band-time span a wrong stamp can fall in. See `detectFault`. */
    window: {
        from: { type: Date, required: true },
        to: { type: Date, required: true },
    },

    /**
     * `shift` when nothing genuine could carry a stamp in `window`, so every unknown row in it
     * is moved by `skewSec`. `hold` when the window overlaps real time a genuine reading could
     * have been taken in — those rows are kept here instead of being filed anywhere.
     */
    mode: { type: String, enum: ['shift', 'hold'], required: true },

    /**
     * Rows stored before the stretch began, stamped inside the window. Genuine, already on
     * the record, and dropped from any later batch: a re-send adds nothing, and the band gives
     * a mis-stamped reading the **same id** as a genuine one taken at the same band second, so
     * letting it through would overwrite the genuine value with the wrong one.
     */
    knownIds: { type: [String], default: [] },

    /** Rows judged mis-stamped and moved. A re-send is moved again, to the same id. */
    shiftedIds: { type: [String], default: [] },

    /** `hold` rows as the band sent them, capped. Nothing files them; see `mode`. */
    held: { type: [mongoose.Schema.Types.Mixed], default: [] },

    /**
     * Local days whose whole-day figures (steps, the heart spread, HRV) the band kept adding
     * to while its calendar was wrong. Later `days` rows for them are dropped, so a day
     * already complete on the record is not overwritten with one the stretch was mixed into.
     */
    frozenDays: { type: [String], default: [] },

    /**
     * The clock as the phone saw it either side of the stretch, in seconds of skew. Written to
     * find out what moves the clock: a skew already present when the previous sync finished
     * points at something that sync sent; none points at the band.
     */
    diagnostics: { type: mongoose.Schema.Types.Mixed, default: null },

    origin: { type: String, enum: ['sync', 'repair'], default: 'sync' },
    detectedAt: { type: Date, default: Date.now },

    /**
     * The band's buffers roll over in a few weeks; past that nothing it sends can be stamped
     * in this window, and the row has done its job.
     */
    expiresAt: { type: Date, required: true },
}, { timestamps: true });

ClockFaultSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('ClockFault', ClockFaultSchema);
