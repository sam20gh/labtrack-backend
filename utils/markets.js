/**
 * Where we sell, and how each place is served — as a table.
 *
 * A **market** is a country or group of countries that shares a currency, a timezone and a
 * way of getting samples to a laboratory. It is not the currency: EUR covers twenty-one
 * countries, and a technician service in Dubai says nothing about Madrid. Today a market is
 * resolved from the currency somebody buys in (`CURRENCY_MARKET`), because that is the
 * choice the storefronts already make; the countries it delivers to stay where checkout
 * already reads them, `utils/currency.js` `CURRENCIES[].shipTo`.
 *
 * Each market serves orders one or both of two ways:
 *
 *   - **post**             kits go in the post, the customer posts the samples back
 *   - **home_collection**  a technician visits at a booked time, collects the samples, and
 *                          hands over the bracelet if the package has one
 *
 * Administrators change a market in the portal (`models/Market.js`); until they do, the
 * defaults below apply and are reported as `source: 'default'`, the convention
 * `ExchangeRates` set — so a screen can say a setting was never chosen.
 *
 * **Slot times are in the market's timezone, always.** A person in London booking a visit to
 * their mother's flat in Dubai is booking 08:00 *Dubai* time. Nothing here reads the
 * customer's phone offset. Times are stored as UTC instants and labelled with the market's
 * own clock, using the platform's ICU data rather than a date library.
 *
 * Pure: no database, no clock it was not handed. `__tests__/collection.test.js`.
 */

const { CURRENCIES, normaliseCurrency } = require('./currency');

/** Which market a currency's buyers are in. One market per currency, for now. */
const CURRENCY_MARKET = { GBP: 'GB', AED: 'AE', SAR: 'SA', EUR: 'EU' };

const METHODS = ['post', 'home_collection'];
const DAY_MINUTES = 24 * 60;

/** The UAE's seven emirates — the default service areas for the UAE market. */
const UAE_EMIRATES = ['Abu Dhabi', 'Dubai', 'Sharjah', 'Ajman', 'Umm Al Quwain', 'Ras Al Khaimah', 'Fujairah'];

const POST_ONLY = { post: true, homeCollection: false, default: 'post' };

/** Visit settings for a market that has none — every field present, collection off. */
const BLANK_VISITS = {
    price: 0,
    days: [0, 1, 2, 3, 4, 5, 6],
    openMinute: 8 * 60,
    closeMinute: 20 * 60,
    slotMinutes: 30,
    capacityMode: 'fixed',
    capacityPerSlot: 1,
    leadHours: 24,
    bookAheadDays: 14,
    rescheduleCutoffHours: 12,
    serviceAreas: [],
    blackoutDates: [],
};

/**
 * The markets as they ship. The UAE is the first market with home collection, configured as
 * decided on 2026-10-09: 30-minute slots, five visits per slot, around the clock, every day.
 * `leadHours` is the one number nobody gave — six hours, so a technician can be found and
 * kitted; change it in the portal.
 */
const DEFAULT_MARKETS = {
    GB: { code: 'GB', name: 'United Kingdom', currency: 'GBP', timezone: 'Europe/London', fulfilment: POST_ONLY, visits: BLANK_VISITS, labs: {} },
    AE: {
        code: 'AE',
        name: 'United Arab Emirates',
        currency: 'AED',
        timezone: 'Asia/Dubai',
        fulfilment: { post: true, homeCollection: true, default: 'home_collection' },
        visits: {
            price: 0,
            days: [0, 1, 2, 3, 4, 5, 6],
            openMinute: 0,
            closeMinute: DAY_MINUTES,
            slotMinutes: 30,
            // A fixed five until the roster is entered; then switch to 'roster' in the portal.
            capacityMode: 'fixed',
            capacityPerSlot: 5,
            leadHours: 6,
            bookAheadDays: 14,
            rescheduleCutoffHours: 3,
            serviceAreas: UAE_EMIRATES,
            blackoutDates: [],
        },
        // Where each kind of sample goes. Provisional — see docs/LAB-INTEGRATION.md.
        labs: { blood: 'MICRO_HEALTH', dna: 'M42' },
    },
    SA: { code: 'SA', name: 'Saudi Arabia', currency: 'SAR', timezone: 'Asia/Riyadh', fulfilment: POST_ONLY, visits: BLANK_VISITS, labs: {} },
    EU: { code: 'EU', name: 'Eurozone', currency: 'EUR', timezone: 'Europe/Brussels', fulfilment: POST_ONLY, visits: BLANK_VISITS, labs: {} },
};

const CODES = Object.keys(DEFAULT_MARKETS);

// ── Validation ───────────────────────────────────────────────────────────────

const SLOT_LENGTHS = [15, 20, 30, 45, 60, 90, 120];
const YMD = /^\d{4}-\d{2}-\d{2}$/;

const intIn = (v, lo, hi) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
};

/**
 * Clean an administrator's edit to one market. Returns `{ ok, value }` or `{ ok: false,
 * errors[] }`. Every field is checked, because a market saved with a slot longer than its
 * opening hours, or no way at all to receive an order, is a market that silently sells
 * nothing.
 */
const cleanMarketPatch = (code, body = {}) => {
    const base = DEFAULT_MARKETS[code];
    if (!base) return { ok: false, errors: [`Unknown market ${code}`] };
    const errors = [];
    const f = body.fulfilment ?? {};
    const c = body.visits ?? {};

    const fulfilment = {
        post: f.post === undefined ? base.fulfilment.post : f.post === true,
        homeCollection: f.homeCollection === undefined ? base.fulfilment.homeCollection : f.homeCollection === true,
        default: f.default ?? base.fulfilment.default,
    };
    if (!fulfilment.post && !fulfilment.homeCollection) errors.push('Offer at least one of post or home collection.');
    if (!METHODS.includes(fulfilment.default)) errors.push('The default must be post or home_collection.');
    else if ((fulfilment.default === 'post' && !fulfilment.post) || (fulfilment.default === 'home_collection' && !fulfilment.homeCollection)) {
        // Fall to whichever is on rather than refusing — the admin turned the other off.
        fulfilment.default = fulfilment.post ? 'post' : 'home_collection';
    }

    const pick = (key, parse, message) => {
        if (c[key] === undefined) return base.visits[key];
        const v = parse(c[key]);
        if (v === null) errors.push(message);
        return v;
    };

    const visits = {
        price: pick('price', (v) => {
            const n = Number(v);
            return Number.isFinite(n) && n >= 0 && n <= 100000 ? Math.round(n * 100) / 100 : null;
        }, 'The collection price must be zero or more.'),
        days: pick('days', (v) => {
            const days = Array.isArray(v) ? [...new Set(v.map((d) => intIn(d, 0, 6)))] : null;
            return days && days.length && !days.includes(null) ? days.sort() : null;
        }, 'Choose at least one day of the week.'),
        openMinute: pick('openMinute', (v) => intIn(v, 0, DAY_MINUTES - 15), 'Opening time must be within the day.'),
        closeMinute: pick('closeMinute', (v) => intIn(v, 15, DAY_MINUTES), 'Closing time must be within the day.'),
        slotMinutes: pick('slotMinutes', (v) => (SLOT_LENGTHS.includes(Number(v)) ? Number(v) : null), `Slot length must be one of ${SLOT_LENGTHS.join(', ')} minutes.`),
        capacityPerSlot: pick('capacityPerSlot', (v) => intIn(v, 1, 100), 'Visits per slot must be between 1 and 100.'),
        /**
         * `fixed` offers `capacityPerSlot` places in every slot; `roster` offers as many as there
         * are technicians on shift (`utils/roster.capacityAt`). Roster mode with nobody rostered
         * offers nothing, which is correct and is why it is not the default.
         */
        capacityMode: pick('capacityMode', (v) => (['fixed', 'roster'].includes(v) ? v : null), 'Capacity must be fixed or roster.'),
        leadHours: pick('leadHours', (v) => intIn(v, 0, 168), 'Notice must be between 0 and 168 hours.'),
        bookAheadDays: pick('bookAheadDays', (v) => intIn(v, 1, 60), 'Booking ahead must be between 1 and 60 days.'),
        rescheduleCutoffHours: pick('rescheduleCutoffHours', (v) => intIn(v, 0, 72), 'The change cut-off must be between 0 and 72 hours.'),
        serviceAreas: pick('serviceAreas', (v) => (Array.isArray(v)
            ? [...new Set(v.map((a) => String(a ?? '').trim().slice(0, 60)).filter(Boolean))].slice(0, 50)
            : null), 'Service areas must be a list.'),
        blackoutDates: pick('blackoutDates', (v) => (Array.isArray(v) && v.every((d) => YMD.test(String(d)))
            ? [...new Set(v.map(String))].sort().slice(0, 200)
            : null), 'Closed dates must be YYYY-MM-DD.'),
    };

    if (errors.length === 0) {
        if (visits.closeMinute <= visits.openMinute) errors.push('Closing time must be after opening time.');
        else if (visits.closeMinute - visits.openMinute < visits.slotMinutes) errors.push('Opening hours are shorter than one slot.');
        if (fulfilment.homeCollection && !visits.serviceAreas.length) errors.push('Home collection needs at least one service area.');
    }

    const labs = body.labs && typeof body.labs === 'object'
        ? {
            blood: String(body.labs.blood ?? base.labs.blood ?? '').trim().toUpperCase().slice(0, 40) || undefined,
            dna: String(body.labs.dna ?? base.labs.dna ?? '').trim().toUpperCase().slice(0, 40) || undefined,
        }
        : undefined;

    return errors.length ? { ok: false, errors } : { ok: true, value: { fulfilment, visits, ...(labs ? { labs } : {}) } };
};

/** A stored market merged over its defaults, field by field. */
const completeMarket = (code, stored) => {
    const base = DEFAULT_MARKETS[code];
    if (!base) return null;
    if (!stored) return { ...base, source: 'default' };
    return {
        ...base,
        fulfilment: { ...base.fulfilment, ...(stored.fulfilment || {}) },
        visits: { ...base.visits, ...(stored.visits || {}) },
        labs: { ...base.labs, ...(stored.labs || {}) },
        source: 'set',
        updatedAt: stored.updatedAt || null,
    };
};

const marketCodeForCurrency = (currency) => CURRENCY_MARKET[normaliseCurrency(currency)] || null;

/** Where the market delivers — the same list Stripe Checkout restricts to. */
const countriesFor = (market) => CURRENCIES[market.currency]?.shipTo || [];

/**
 * The ways an order in this market can be fulfilled, cheapest first, each with its price in
 * the market's currency. What both storefronts draw as the choice.
 */
const fulfilmentOptions = (market) => {
    const out = [];
    if (market.fulfilment.homeCollection) {
        out.push({
            method: 'home_collection',
            label: 'Home sample collection',
            description: 'A technician visits at a time you choose, collects your samples and hands over anything in your package.',
            price: market.visits.price,
            default: market.fulfilment.default === 'home_collection',
        });
    }
    if (market.fulfilment.post) {
        out.push({
            method: 'post',
            label: 'By post',
            description: 'Kits are posted to you. You collect the samples yourself and post them back.',
            price: 0,
            default: market.fulfilment.default === 'post',
        });
    }
    return out.sort((a, b) => a.price - b.price || (b.default - a.default));
};

// ── Time ─────────────────────────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, '0');

/** The wall-clock parts of an instant in a timezone. */
const partsIn = (date, timeZone) => {
    const f = new Intl.DateTimeFormat('en-GB', {
        timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
    return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
};

/** Minutes the timezone's clock is ahead of UTC at that instant. */
const offsetMinutes = (date, timeZone) => {
    const p = partsIn(date, timeZone);
    return Math.round((Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - date.getTime()) / 60000);
};

/** The UTC instant of minute `minutes` after local midnight on `ymd`, in `timeZone`. */
const localToUtc = (ymd, minutes, timeZone) => {
    const [y, m, d] = ymd.split('-').map(Number);
    const naive = Date.UTC(y, m - 1, d) + minutes * 60000;
    const first = offsetMinutes(new Date(naive), timeZone);
    let t = naive - first * 60000;
    // Across a clock change the offset at the guess and at the answer differ; settle once.
    const second = offsetMinutes(new Date(t), timeZone);
    if (second !== first) t = naive - second * 60000;
    return new Date(t);
};

/** Minutes after local midnight of an instant, in the timezone. */
const partsInMinutes = (date, timeZone) => {
    const p = partsIn(date, timeZone);
    return p.h * 60 + p.mi;
};

/** YYYY-MM-DD of an instant on the timezone's own calendar. */
const localDay = (date, timeZone) => {
    const p = partsIn(date, timeZone);
    return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
};

const addDays = (ymd, n) => {
    const [y, m, d] = ymd.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d + n));
    return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
};

const weekdayOf = (ymd) => {
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

const timeLabel = (date, timeZone) => {
    const p = partsIn(date, timeZone);
    return `${pad(p.h)}:${pad(p.mi)}`;
};

const dayLabel = (ymd) => {
    const [y, m, d] = ymd.split('-').map(Number);
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' })
        .format(new Date(Date.UTC(y, m - 1, d)));
};

/**
 * "Tue 14 Oct, 08:00–08:30" in the market's own clock. Server-side, so every client — the app
 * on Hermes, the website, the portal, a push notification — prints the same words.
 */
const describeSlot = (start, end, timeZone) =>
    `${dayLabel(localDay(start, timeZone))}, ${timeLabel(start, timeZone)}–${timeLabel(end, timeZone)}`;

// ── Slots ────────────────────────────────────────────────────────────────────

/**
 * Every bookable slot from now to `bookAheadDays` ahead, with what is left in each.
 *
 * @param {object} market   a completed market
 * @param {object} opts
 * @param {Date}   opts.now
 * @param {Map<string, number>} [opts.taken]  slot start (ISO) → visits already holding it
 * @param {(start: Date) => number} [opts.capacityAt]  places in a slot; defaults to the fixed figure
 * @returns {{ date, label, closed, slots: { start, end, label, remaining }[] }[]}
 */
const slotsFor = (market, { now, taken = new Map(), capacityAt }) => {
    const c = market.visits;
    const tz = market.timezone;
    const earliest = now.getTime() + c.leadHours * 3600000;
    const today = localDay(now, tz);
    const days = [];

    for (let i = 0; i < c.bookAheadDays; i++) {
        const date = addDays(today, i);
        const closed = c.blackoutDates.includes(date) || !c.days.includes(weekdayOf(date));
        const slots = [];
        if (!closed) {
            for (let m = c.openMinute; m + c.slotMinutes <= c.closeMinute; m += c.slotMinutes) {
                const start = localToUtc(date, m, tz);
                if (start.getTime() < earliest) continue;
                const end = new Date(start.getTime() + c.slotMinutes * 60000);
                const iso = start.toISOString();
                slots.push({
                    start: iso,
                    end: end.toISOString(),
                    label: timeLabel(start, tz),
                    remaining: Math.max(0, (capacityAt ? capacityAt(start) : c.capacityPerSlot) - (taken.get(iso) || 0)),
                });
            }
        }
        days.push({ date, label: dayLabel(date), closed, slots });
    }
    return days;
};

/**
 * Is `start` a slot this market would offer right now? Checked server-side on every booking,
 * because the client's slot list is a picture taken some minutes ago: hours change, a date
 * gets closed, the lead time passes while somebody hesitates.
 */
const isBookableStart = (market, start, now) => {
    const t = start instanceof Date ? start : new Date(start);
    if (Number.isNaN(t.getTime())) return { ok: false, reason: 'invalid' };
    const c = market.visits;
    const tz = market.timezone;

    if (t.getTime() < now.getTime() + c.leadHours * 3600000) return { ok: false, reason: 'too_soon' };
    const date = localDay(t, tz);
    const last = addDays(localDay(now, tz), c.bookAheadDays - 1);
    if (date > last) return { ok: false, reason: 'too_far' };
    if (c.blackoutDates.includes(date) || !c.days.includes(weekdayOf(date))) return { ok: false, reason: 'closed' };

    const p = partsIn(t, tz);
    const minute = p.h * 60 + p.mi;
    const aligned = p.s === 0 && minute >= c.openMinute && minute + c.slotMinutes <= c.closeMinute
        && (minute - c.openMinute) % c.slotMinutes === 0
        && localToUtc(date, minute, tz).getTime() === t.getTime();
    return aligned ? { ok: true } : { ok: false, reason: 'not_a_slot' };
};

const REFUSAL = {
    invalid: 'That time could not be read. Choose a slot from the list.',
    too_soon: 'That slot is too soon for us to send a technician. Choose a later one.',
    too_far: 'We cannot book that far ahead yet. Choose an earlier day.',
    closed: 'We are not visiting on that day. Choose another.',
    not_a_slot: 'That is not one of our visit times. Choose a slot from the list.',
    full: 'That slot has just been taken. Choose another.',
};

module.exports = {
    CURRENCY_MARKET,
    DEFAULT_MARKETS,
    CODES,
    METHODS,
    UAE_EMIRATES,
    cleanMarketPatch,
    completeMarket,
    marketCodeForCurrency,
    countriesFor,
    fulfilmentOptions,
    localToUtc,
    localDay,
    partsInMinutes,
    offsetMinutes,
    describeSlot,
    slotsFor,
    isBookableStart,
    REFUSAL,
};
