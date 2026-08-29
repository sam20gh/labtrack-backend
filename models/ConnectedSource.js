const mongoose = require('mongoose');

/**
 * A health-data source the person has connected.
 *
 * There is no server API for Apple Health, and Health Connect has no server API either —
 * the phone reads its own store and posts a batch. So this document is not a credential or
 * an OAuth grant. It is the *sync cursor plus what we were granted*, and it exists so a
 * sync can be incremental instead of re-uploading a year of samples on every app launch.
 *
 * `lastSyncCursor` is opaque on purpose. On iOS it is a HealthKit anchor; on Android a
 * Health Connect changes token; from an aggregator it would be a webhook sequence number.
 * The server never interprets it — it stores what the client gave it and hands it back on
 * the next `/status` call.
 */

/**
 * A device that actually wrote data, as the health store reported it.
 *
 * The design draws a device card with a battery percentage and a Connected badge. Neither
 * HealthKit nor Health Connect exposes a paired wearable's battery or its online state:
 * HealthKit attaches an `HKDevice` (name/model/manufacturer) to samples, Health Connect
 * attaches `metadata.device`, and that is the whole of it. So the client renders "last
 * wrote data 2h ago" from `lastSeenAt`. A battery bar that is always 90% is a dummy control.
 */
const SourceDeviceSchema = new mongoose.Schema({
    name: { type: String },
    model: { type: String },
    manufacturer: { type: String },
    lastSeenAt: { type: Date },
}, { _id: false });

const ConnectedSourceSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    platform: {
        type: String,
        enum: ['apple_health', 'health_connect', 'aggregator'],
        required: true,
    },

    /** What to call it on screen, e.g. 'Apple Health' or 'Health Connect'. */
    providerLabel: { type: String },

    /**
     * The read scopes the person actually granted, as the platform names them.
     *
     * Stored because permission is per-data-type and partial grants are normal: someone
     * may allow steps and workouts but refuse sleep. A screen that asks for sleep data we
     * were never granted should say so rather than render an empty chart.
     */
    permissions: [{ type: String }],

    devices: [SourceDeviceSchema],

    lastSyncAt: { type: Date },
    lastSyncCursor: { type: String, default: null },

    /**
     * `revoked` is set when a sync reports the permission was withdrawn in system settings.
     * Kept rather than deleted so the reconnect screen can say what was there before.
     */
    status: {
        type: String,
        enum: ['connected', 'revoked', 'error'],
        default: 'connected',
    },
    lastError: { type: String, default: null },
}, { timestamps: true });

// One row per platform per person: connecting Apple Health twice is the same connection.
ConnectedSourceSchema.index({ userId: 1, platform: 1 }, { unique: true });

module.exports = mongoose.model('ConnectedSource', ConnectedSourceSchema);
