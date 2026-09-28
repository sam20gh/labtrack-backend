/**
 * One run, recorded twice — a phone's live session and a watch's workout — is one run.
 *
 * Somebody who presses Start on the phone *and* on their watch gets the same run from two
 * places: `source: 'live'` from the upload, and a HealthKit / Health Connect workout from the
 * next sync, each with its own id. `externalId` cannot see it, exactly as it could not see
 * two apps writing the same night (`healthSync.sameNight`), and the rule is the same one:
 * **a person cannot do two runs at the same time.** Workouts that overlap by at least half
 * the shorter one, of compatible types, are two accounts of one.
 *
 * **The live row wins, always.** It has the route, the splits and the server's own
 * arithmetic. What the watch knew that the phone did not — heart rate, cadence — is copied
 * into the live row's **empty** fields and nothing else: a watch's distance never overwrites
 * the GPS track's, and a value already on the row is never replaced.
 *
 * **The store copy is absorbed, not deleted-and-recreated.** A store workout is rewritten on
 * every sync; deleting it would bring it back on the next one. So an incoming duplicate is
 * never inserted (`ingestActivities` checks first), and one that synced *before* the live
 * upload is removed when the live row arrives (`absorbStoreTwins`). Nothing is lost: the
 * health store still holds it.
 *
 * Separate workouts do not overlap and both survive — a warm-up walk and the run after it.
 */

const OVERLAP_SHARE = 0.5;

/** Types that are the same activity seen by different apps. */
const FAMILY = {
    jogging: 'foot', walking: 'foot', hiking: 'foot', running: 'foot',
    biking: 'bike', cycling: 'bike',
};

const familyOf = (type) => FAMILY[type] || type;

const bounds = (w) => {
    const start = new Date(w.startedAt).getTime();
    const end = w.endedAt
        ? new Date(w.endedAt).getTime()
        : start + (Number(w.durationSec) || 0) * 1000;
    return [start, end];
};

/** Fraction of the shorter workout the two share, 0–1. */
const sharedFraction = (a, b) => {
    const [aS, aE] = bounds(a);
    const [bS, bE] = bounds(b);
    const overlap = Math.min(aE, bE) - Math.max(aS, bS);
    const shorter = Math.min(aE - aS, bE - bS);
    if (overlap <= 0 || shorter <= 0) return 0;
    return overlap / shorter;
};

const sameWorkout = (a, b) =>
    familyOf(a.type) === familyOf(b.type) && sharedFraction(a, b) >= OVERLAP_SHARE;

/** The fields a store twin may fill on a live row — only where the live row has none. */
const FILLABLE = ['avgBpm', 'maxBpm', 'cadence'];

/** `$set` for the live row, or null when the twin adds nothing. */
const fillFromTwin = (live, twin) => {
    const set = {};
    for (const k of FILLABLE) {
        const mine = live[k];
        const theirs = twin[k];
        if (!Number.isFinite(mine) && Number.isFinite(theirs) && theirs > 0) set[k] = theirs;
    }
    return Object.keys(set).length ? set : null;
};

module.exports = { sameWorkout, sharedFraction, fillFromTwin, familyOf, OVERLAP_SHARE, FILLABLE };
