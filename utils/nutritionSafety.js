/**
 * Whether a suggested meal is safe to put in front of *this* person.
 *
 * A deterministic table, not a model — the same argument `medicationCatalogue.js` and
 * `bloodPressure.js` make. `nutritionSchema.RECOMMENDATION_PROMPT` tells the model that a
 * declared allergy is absolute, and it will usually obey; "usually" is not a property you
 * can assert in a test, and there is no way to know which call was the one it missed. So
 * the prompt asks and this file guarantees: every suggestion is screened here before it
 * reaches the client, and one that trips a declared allergy is dropped rather than
 * flagged.
 *
 * Dropping rather than warning is deliberate. A card captioned "contains peanuts — you are
 * allergic" is still a recommendation for a meal that could hospitalise the person, drawn
 * in the same rail as the ones that cannot.
 *
 * The screen is one-directional: it can only remove a suggestion, never add or amend one.
 * That is the same subordinate role `mergeFindings` gives the model in the interaction
 * checker, pointing the other way.
 */

/**
 * Words that indicate an allergen is present, keyed by the allergen as people write it in
 * the health assessment.
 *
 * Deliberately over-broad. A false positive costs one suggestion out of six; a false
 * negative is the failure this file exists to prevent, so where a token is ambiguous
 * ("butter" against dairy, which also catches peanut butter and shea butter) it stays in.
 */
const ALLERGEN_TOKENS = {
    peanut: ['peanut', 'groundnut', 'arachis', 'satay', 'peanut butter'],
    treenut: ['almond', 'cashew', 'walnut', 'pecan', 'pistachio', 'hazelnut', 'macadamia',
        'brazil nut', 'pine nut', 'praline', 'marzipan', 'nut butter', 'mixed nuts', 'nuts'],
    milk: ['milk', 'dairy', 'cheese', 'butter', 'cream', 'yoghurt', 'yogurt', 'ghee',
        'custard', 'paneer', 'mozzarella', 'parmesan', 'feta', 'ricotta', 'whey', 'casein',
        'halloumi', 'cheddar', 'brie', 'camembert', 'gouda', 'gruyere', 'mascarpone',
        'burrata', 'gorgonzola', 'stilton', 'manchego', 'pecorino', 'creme fraiche',
        'kefir', 'labneh', 'quark', 'buttermilk'],
    egg: ['egg', 'omelet', 'omelette', 'frittata', 'mayonnaise', 'mayo', 'meringue', 'aioli'],
    gluten: ['wheat', 'gluten', 'bread', 'pasta', 'noodle', 'flour', 'barley', 'rye',
        'couscous', 'bulgur', 'semolina', 'seitan', 'panko', 'breadcrumb', 'cracker',
        'pastry', 'tortilla', 'pita', 'bagel', 'croissant', 'cereal', 'oats', 'orzo'],
    soy: ['soy', 'soya', 'tofu', 'edamame', 'tempeh', 'miso', 'tamari'],
    fish: ['fish', 'salmon', 'tuna', 'cod', 'haddock', 'mackerel', 'sardine', 'anchovy',
        'trout', 'halibut', 'sea bass', 'tilapia', 'pollock', 'worcestershire'],
    shellfish: ['shellfish', 'prawn', 'shrimp', 'crab', 'lobster', 'crayfish', 'langoustine',
        'mussel', 'clam', 'oyster', 'scallop', 'squid', 'calamari', 'octopus'],
    sesame: ['sesame', 'tahini', 'hummus', 'houmous', 'halva', 'za\'atar'],
    mustard: ['mustard', 'dijon', 'wholegrain mustard'],
    celery: ['celery', 'celeriac'],
    sulphite: ['sulphite', 'sulfite'],
    lupin: ['lupin'],
};

/**
 * How a free-text allergy from the health assessment maps onto a token list.
 *
 * People write "nuts", "tree nuts", "lactose intolerant" and "shellfish allergy" — the
 * questionnaire is free text, so this has to absorb the wording rather than demand a
 * vocabulary. Anything unmatched falls through to a literal substring test on the words
 * they wrote, which is the honest fallback: it will not know that "shrimp" is shellfish,
 * but it will catch an ingredient they named themselves.
 */
const ALLERGY_ALIASES = [
    { match: /peanut|groundnut/i, group: 'peanut' },
    { match: /tree ?nut|\bnuts?\b|almond|cashew|walnut|pecan|pistachio|hazelnut/i, group: 'treenut' },
    { match: /milk|dairy|lactose|cheese/i, group: 'milk' },
    { match: /\begg/i, group: 'egg' },
    { match: /gluten|wheat|coeliac|celiac/i, group: 'gluten' },
    { match: /\bsoya?\b/i, group: 'soy' },
    { match: /shell ?fish|crustacean|prawn|shrimp|crab|lobster|mollusc/i, group: 'shellfish' },
    { match: /\bfish\b|salmon|tuna|cod\b/i, group: 'fish' },
    { match: /sesame|tahini/i, group: 'sesame' },
    { match: /mustard/i, group: 'mustard' },
    { match: /celery|celeriac/i, group: 'celery' },
    { match: /sulph?ite|sulfite/i, group: 'sulphite' },
    { match: /lupin/i, group: 'lupin' },
];

/**
 * What each dietary preference excludes.
 *
 * A preference is not an allergy and a violation is not a safety incident — but a vegan
 * shown a chicken salad has been told the app was not listening, and the whole point of
 * this tracker is that it reads the person's own record rather than generic advice. So the
 * same screen applies, with the same one-directional rule.
 *
 * Values are token lists, resolved through ALLERGEN_TOKENS where the group already exists
 * so the two tables cannot drift apart on, say, what counts as dairy.
 */
const MEAT = ['chicken', 'beef', 'pork', 'lamb', 'mutton', 'veal', 'duck', 'turkey', 'goose',
    'bacon', 'ham', 'sausage', 'salami', 'chorizo', 'prosciutto', 'pepperoni', 'steak',
    'mince', 'meatball', 'burger', 'brisket', 'venison', 'liver', 'gelatin', 'gelatine',
    'lard', 'pancetta', 'jerky'];

const SEAFOOD = [...ALLERGEN_TOKENS.fish, ...ALLERGEN_TOKENS.shellfish];

const PREFERENCE_EXCLUSIONS = {
    vegetarian: [...MEAT, ...SEAFOOD],
    vegan: [...MEAT, ...SEAFOOD, ...ALLERGEN_TOKENS.milk, ...ALLERGEN_TOKENS.egg, 'honey'],
    pescatarian: MEAT,
    halal: ['pork', 'bacon', 'ham', 'gammon', 'lard', 'pancetta', 'prosciutto', 'chorizo',
        'salami', 'pepperoni', 'gelatin', 'gelatine', 'wine', 'beer', 'rum', 'vodka',
        'brandy', 'sherry', 'alcohol'],
    kosher: ['pork', 'bacon', 'ham', 'gammon', 'lard', 'pancetta', 'prosciutto',
        ...ALLERGEN_TOKENS.shellfish],
    gluten_free: ALLERGEN_TOKENS.gluten,
    dairy_free: ALLERGEN_TOKENS.milk,
    low_fodmap: ['onion', 'garlic', 'wheat', 'rye', 'apple', 'pear', 'mango', 'honey',
        'cashew', 'pistachio', 'lentil', 'chickpea', 'kidney bean', 'baked bean'],
};

/** Every word a suggestion is searchable by: its name, its ingredients, its own tags. */
const haystack = (suggestion) => [
    suggestion.name,
    suggestion.why,
    ...(suggestion.ingredients || []),
    ...(suggestion.tags || []),
].filter(Boolean).join(' ').toLowerCase();

/**
 * Whole-word-ish containment.
 *
 * `includes()` alone matches "ham" inside "hamburger" — right by luck — but also inside
 * "chamomile", which is wrong and would silently drop a safe suggestion. Bounding on
 * non-letters keeps multi-word tokens ("peanut butter", "sea bass") working, which a `\b`
 * regex over a word list would not.
 */
const mentions = (text, token) =>
    new RegExp(`(^|[^a-z])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i').test(text);

/** Token list for one free-text allergy, plus the person's own words as a literal fallback. */
const tokensForAllergy = (allergy) => {
    const text = String(allergy || '').trim();
    if (!text) return [];
    const alias = ALLERGY_ALIASES.find((a) => a.match.test(text));
    const own = text.toLowerCase().replace(/\s*(allergy|allergic to|intolerance|intolerant)\s*/gi, '').trim();
    const literal = own.length >= 3 ? [own] : [];
    return alias ? [...ALLERGEN_TOKENS[alias.group], ...literal] : literal;
};

/**
 * Screen a set of suggestions against one person's plan.
 *
 * @param {Array} suggestions  as the model returned them
 * @param {object|null} plan   their NutritionPlan
 * @returns {{ kept: Array, dropped: Array<{ name: string, reason: string }> }}
 *
 * `dropped` is returned rather than discarded so the controller can log it. A model that
 * starts suggesting allergens is a prompt regression, and a silent filter hides it.
 */
const screen = (suggestions = [], plan = null) => {
    const allergies = plan?.allergies || [];
    const preferences = plan?.dietaryPreferences || [];

    const kept = [];
    const dropped = [];

    for (const suggestion of suggestions) {
        const text = haystack(suggestion);

        const allergen = allergies.find((allergy) =>
            tokensForAllergy(allergy).some((token) => mentions(text, token)));
        if (allergen) {
            dropped.push({ name: suggestion.name, reason: `allergy: ${allergen}` });
            continue;
        }

        const preference = preferences.find((pref) =>
            (PREFERENCE_EXCLUSIONS[pref] || []).some((token) => mentions(text, token)));
        if (preference) {
            dropped.push({ name: suggestion.name, reason: `preference: ${preference}` });
            continue;
        }

        kept.push(suggestion);
    }

    return { kept, dropped };
};

module.exports = {
    screen,
    tokensForAllergy,
    ALLERGEN_TOKENS,
    ALLERGY_ALIASES,
    PREFERENCE_EXCLUSIONS,
    _mentions: mentions,
};
