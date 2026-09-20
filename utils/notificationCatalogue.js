/**
 * What a notification *is*, as a table.
 *
 * The ninth deterministic table in the series with `medicationCatalogue.js`,
 * `bloodPressure.js`, `nutritionSafety.js`, `reviewSla.js`, `predictionForecast.js`,
 * `achievementCatalogue.js`, `sleepTargets.js` and `appState.ts`, and it exists for the
 * same reason every one of those does: a producer that picks its own icon, its own tint
 * and its own destination is a producer the notification centre eventually disagrees with.
 *
 * Six things travel with a category and are **not** a producer's to choose:
 *
 *   - `icon` and `tint` — so two reminders about the same tracker never arrive wearing
 *     different marks. A job that passed its own icon would drift the first time somebody
 *     added a second sender for the same feature.
 *   - `route` — the default destination. A notification a person cannot open is the dead
 *     end `PILLAR_ROUTE` exists to prevent on the score screen, so a category with no route
 *     is rejected by the tests rather than silently producing an unopenable card.
 *   - `label` — what the filter chip says, and what a screen reader reads before the title.
 *   - `channel` — which `notificationPreferences` switch silences it. A category whose
 *     channel nobody can turn off is a category that will get the whole feature muted.
 *   - `priority` — whether the push may interrupt. Only `critical` may; see `publish()`.
 *
 * **Priority is about interruption, never about how worried to be.** `critical` means the
 * push is allowed through quiet hours, and nothing else: it is not a clinical severity and
 * no screen renders it as one. The same line `bloodPressure.isCrisis` holds by staying off
 * the band ladder, and the reason is identical — a screen that could paint priority as a
 * colour would turn "we sent this at 3am" into a statement about somebody's health.
 */

/**
 * Categories, keyed by the value stored on the row.
 *
 * `icon` is an Ionicons name. The server names it and the client draws it verbatim, which
 * means **a typo here renders as nothing**: Ionicons draws an unknown glyph as empty space,
 * on every phone, with no error anywhere. Nothing in this repo can check a name against a
 * font it does not have, so the guard lives on the other side — `SERVER_ICONS` in
 * `labtrack-frontend/lib/__tests__/notificationCentre-test.ts` vendors this column and
 * asserts every entry is a real glyph. **Adding a category means adding its icon there
 * too**, the same obligation the shared types carry and for the same reason: the two repos
 * deploy independently, so neither can import the other at build time.
 */
const CATEGORIES = {
    plan: {
        label: 'Health plan',
        icon: 'calendar-outline',
        tint: 'violet',
        route: '/myplans',
        channel: 'overdueReminders',
        priority: 'normal',
    },
    medication: {
        label: 'Medication',
        icon: 'medkit-outline',
        tint: 'violet',
        route: '/medications',
        channel: 'enabled',
        priority: 'normal',
    },
    sleep: {
        label: 'Sleep',
        icon: 'moon-outline',
        tint: 'indigo',
        route: '/sleep',
        channel: 'enabled',
        priority: 'normal',
    },
    hydration: {
        label: 'Hydration',
        icon: 'water-outline',
        tint: 'blue',
        route: '/metrics/log/water',
        channel: 'enabled',
        priority: 'normal',
    },
    activity: {
        label: 'Activity',
        icon: 'walk-outline',
        tint: 'green',
        route: '/activity',
        channel: 'enabled',
        priority: 'normal',
    },
    nutrition: {
        label: 'Nutrition',
        icon: 'restaurant-outline',
        tint: 'green',
        route: '/nutrition',
        channel: 'enabled',
        priority: 'normal',
    },
    vitals: {
        label: 'Vitals',
        icon: 'pulse-outline',
        tint: 'rose',
        route: '/metrics',
        channel: 'enabled',
        // The one category allowed to interrupt. A blood pressure in the crisis band is the
        // case this exists for; see `utils/bloodPressure.js`.
        priority: 'critical',
    },
    results: {
        label: 'Results',
        icon: 'document-text-outline',
        tint: 'violet',
        route: '/results',
        channel: 'resultsReady',
        priority: 'normal',
    },
    insight: {
        label: 'Insights',
        icon: 'sparkles-outline',
        tint: 'violet',
        route: '/',
        channel: 'enabled',
        priority: 'normal',
    },
    appointment: {
        label: 'Appointments',
        icon: 'time-outline',
        tint: 'indigo',
        route: '/appointments',
        channel: 'enabled',
        priority: 'normal',
    },
    order: {
        label: 'Orders',
        icon: 'cube-outline',
        tint: 'amber',
        route: '/orders-history',
        channel: 'orderUpdates',
        priority: 'normal',
    },
    achievement: {
        label: 'Badges',
        icon: 'trophy-outline',
        tint: 'amber',
        route: '/achievements',
        channel: 'enabled',
        priority: 'normal',
    },
    account: {
        label: 'Account',
        icon: 'person-outline',
        tint: 'slate',
        route: '/profile',
        channel: 'enabled',
        priority: 'normal',
    },
};

const CATEGORY_KEYS = Object.keys(CATEGORIES);

/** Tints the client knows how to paint. A tint outside this list renders as `slate`. */
const TINTS = ['violet', 'indigo', 'blue', 'green', 'rose', 'amber', 'slate'];

/**
 * The preference switches a category may be gated on.
 *
 * `enabled` is the master switch and is what a category falls back to; the other three are
 * the per-topic switches `notificationPreferences` already carries. A category naming a
 * switch that does not exist would be silently un-silenceable, which the tests catch.
 */
const CHANNELS = ['enabled', 'overdueReminders', 'orderUpdates', 'resultsReady'];

/** The table entry for a category, or `null` when nothing knows about it. */
const describe = (category) => CATEGORIES[category] ?? null;

/**
 * Is this category currently allowed to *push*?
 *
 * Note what this does not decide: whether to record it. A suppressed push still writes an
 * inbox row — see `notificationCentre.publish`. Somebody who has turned order updates off
 * has said they do not want to be interrupted by them, not that the order did not ship.
 */
const pushAllowed = (category, preferences) => {
    const spec = describe(category);
    if (!spec) return false;
    const prefs = preferences ?? {};
    if (prefs.enabled === false) return false;
    if (spec.channel === 'enabled') return true;
    return prefs[spec.channel] !== false;
};

module.exports = { CATEGORIES, CATEGORY_KEYS, TINTS, CHANNELS, describe, pushAllowed };
