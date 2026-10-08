/**
 * The currencies the catalogue sells in, and how one product is priced in each.
 *
 * **GBP is the base.** `Product.price` is a GBP figure and every reader that predates this
 * file still reads it that way. Each other currency is priced one of two ways, per product:
 *
 *   - **set**        `Product.prices.<CODE>` holds an explicit figure an administrator typed.
 *                    It is used exactly, never converted and never rounded further.
 *   - **converted**  no figure is set, so the GBP price is multiplied by the stored rate
 *                    (`models/ExchangeRates.js`) and rounded to a whole unit.
 *
 * A set price always wins. That is the point of having one: "AED 699" is a price somebody
 * chose for a market, and a rate change must not move it.
 *
 * Converted prices round to a **whole unit** because a converted figure is a number nobody
 * chose — £149 at 4.91 is AED 731.59, and a storefront printing that reads as a currency
 * calculator rather than a price. Whoever wants AED 729 or AED 735 sets it.
 *
 * This is a deterministic table, like `bloodPressure.js` and `reviewSla.js`: a price each
 * screen worked out for itself is a price the basket, the order and Stripe eventually
 * disagree about. Everything that charges or displays a price calls `priceFor`.
 */

const BASE = 'GBP';

/**
 * `shipTo` is where an order paid in that currency may be delivered — Stripe Checkout's
 * `allowed_countries`. Regional pricing implies regional delivery: without it a set AED
 * price lower than the GBP one is a discount anybody in London can take by switching the
 * picker. Eurozone is the 21 members as of 2026 (Bulgaria joined on 1 January).
 */
const CURRENCIES = {
    GBP: { code: 'GBP', label: 'British pound', symbol: '£', shipTo: ['GB'] },
    AED: { code: 'AED', label: 'UAE dirham', symbol: 'AED', shipTo: ['AE'] },
    SAR: { code: 'SAR', label: 'Saudi riyal', symbol: 'SAR', shipTo: ['SA'] },
    EUR: {
        code: 'EUR', label: 'Euro', symbol: '€',
        shipTo: ['AT', 'BE', 'BG', 'HR', 'CY', 'EE', 'FI', 'FR', 'DE', 'GR', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PT', 'SK', 'SI', 'ES'],
    },
};

const CODES = Object.keys(CURRENCIES);
/** Every currency but the base — the ones a product can carry its own price in. */
const OTHER_CODES = CODES.filter((c) => c !== BASE);

/**
 * Placeholder rates, used only until an administrator saves real ones in the portal. They
 * are reported as `source: 'default'` so the portal can say so rather than presenting a
 * guess as a decision.
 */
const DEFAULT_RATES = { AED: 4.9, SAR: 5.0, EUR: 1.17 };

/** Upper-case a currency code, or null when it is not one we sell in. */
const normaliseCurrency = (value) => {
    if (typeof value !== 'string') return null;
    const code = value.trim().toUpperCase();
    return CURRENCIES[code] ? code : null;
};

const roundMinor = (n) => Math.round(Number(n) * 100) / 100;

/** A usable price — finite and not negative — rounded to the minor unit, or null. */
const cleanAmount = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? roundMinor(n) : null;
};

/** A usable rate: finite, positive, and not absurd. Null otherwise. */
const cleanRate = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 && n < 1000 ? Math.round(n * 1e6) / 1e6 : null;
};

/** Fill any missing or unusable rate from the defaults, so pricing never divides by nothing. */
const completeRates = (rates = {}) => {
    const out = {};
    for (const code of OTHER_CODES) out[code] = cleanRate(rates?.[code]) ?? DEFAULT_RATES[code];
    return out;
};

/**
 * The explicit per-currency prices a product carries, cleaned. Only non-base codes, only
 * usable figures; anything else is dropped, which means "convert".
 */
const setPrices = (product) => {
    const raw = product?.prices || {};
    const out = {};
    for (const code of OTHER_CODES) {
        const amount = cleanAmount(raw[code]);
        if (amount !== null) out[code] = amount;
    }
    return out;
};

/**
 * What one product costs in one currency.
 *
 * → `{ currency, amount, source }`, `source` one of `base` | `set` | `converted`.
 * An unknown currency is a programming error at the call site and throws, so it can never
 * silently charge the GBP figure in another currency's units.
 */
const priceFor = (product, currency, rates) => {
    const code = normaliseCurrency(currency);
    if (!code) throw new Error(`Unsupported currency: ${currency}`);

    const base = cleanAmount(product?.price) ?? 0;
    if (code === BASE) return { currency: code, amount: base, source: 'base' };

    const set = setPrices(product)[code];
    if (set !== undefined) return { currency: code, amount: set, source: 'set' };

    const rate = completeRates(rates)[code];
    return { currency: code, amount: Math.round(base * rate), source: 'converted' };
};

/** Every currency at once — what a product read carries as `pricing`. */
const pricingFor = (product, rates) => {
    const out = {};
    for (const code of CODES) {
        const { amount, source } = priceFor(product, code, rates);
        out[code] = { amount, source };
    }
    return out;
};

/** The list the clients draw a picker from. */
const currencyList = () => CODES.map((code) => {
    const { label, symbol } = CURRENCIES[code];
    return { code, label, symbol };
});

module.exports = {
    BASE,
    CURRENCIES,
    CODES,
    OTHER_CODES,
    DEFAULT_RATES,
    normaliseCurrency,
    cleanAmount,
    cleanRate,
    completeRates,
    setPrices,
    priceFor,
    pricingFor,
    currencyList,
};
