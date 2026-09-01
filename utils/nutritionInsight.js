/**
 * The arithmetic behind the Nutrition Insight screen.
 *
 * Pure functions over `MealLog` rows, kept out of the controller so they can be tested
 * without a database and so the two screens that read them — Insight and the dashboard's
 * insight card — cannot drift apart on what "average" means.
 *
 * One rule runs through all of it, and it is the same one `alignment: 'unassessed'`,
 * `medicationSchedule.adherence` and `hydration.levelFor` already follow: **a day with
 * nothing logged is absent, never zero.** Averaging over calendar days rather than over
 * logged days turns a fortnight's honest gap into a fortnight of apparent starvation, and
 * a chart that says so is one people stop opening.
 */

/** Sum the macros of a set of meals. */
const totalsOf = (meals) => meals.reduce((acc, m) => ({
    calories: acc.calories + (m.calories || 0),
    protein: acc.protein + (m.protein || 0),
    carbs: acc.carbs + (m.carbs || 0),
    fat: acc.fat + (m.fat || 0),
    fibre: acc.fibre + (m.fibre || 0),
}), { calories: 0, protein: 0, carbs: 0, fat: 0, fibre: 0 });

/** Group meals by their local day string. */
const byDay = (meals) => {
    const map = new Map();
    for (const m of meals) {
        if (!map.has(m.day)) map.set(m.day, []);
        map.get(m.day).push(m);
    }
    return map;
};

/**
 * Mean of a list, or null when the list is empty.
 *
 * Null rather than 0 throughout this file. `Math.round(0/0)` is NaN and JSON-serialises to
 * null anyway, but relying on that means the next person to touch it reintroduces a zero
 * without noticing why it was never there.
 */
const mean = (values) => (values.length
    ? Math.round(values.reduce((a, b) => a + b, 0) / values.length)
    : null);

/**
 * Average intake per weekday, over the window.
 *
 * The design's bar chart. Seven bars, Monday first, each one the mean of the days that
 * actually had meals on them. A weekday nothing was ever logged on returns null and the
 * chart draws a gap — the same claim the day rows make.
 */
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const weekdayProfile = (dayTotals) => {
    const buckets = WEEKDAYS.map(() => []);
    for (const { day, totals } of dayTotals) {
        // Parsed at noon UTC so a timezone can never shift a date string onto the day before
        const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
        buckets[(dow + 6) % 7].push(totals);
    }
    return WEEKDAYS.map((label, i) => ({
        label,
        days: buckets[i].length,
        calories: mean(buckets[i].map((t) => t.calories)),
        protein: mean(buckets[i].map((t) => t.protein)),
        fat: mean(buckets[i].map((t) => t.fat)),
        carbs: mean(buckets[i].map((t) => t.carbs)),
    }));
};

/**
 * How each macro sits against its target, over the window.
 *
 * The design's "Goal Progress" section, which draws a bar per macro and marks it Reached.
 * `reached` compares the *average* day against the target, not the sum: someone who logged
 * four days out of thirty has not reached a monthly protein goal thirty times over, and a
 * running total against a daily target is a bar that only ever goes up.
 *
 * With no target the macro returns `target: null` and the client omits it, rather than
 * drawing a full bar against nothing.
 */
const goalProgress = (averages, targets = {}) =>
    ['protein', 'carbs', 'fat'].map((key) => {
        const target = targets[key] ?? null;
        const average = averages?.[key] ?? null;
        return {
            key,
            average,
            target,
            /** 0-1, or null when either half is missing. Uncapped so overshoot is visible. */
            ratio: target && average != null ? Number((average / target).toFixed(3)) : null,
            /** Within a tenth either side counts as met. A macro is a range, not a threshold. */
            reached: target && average != null ? average >= target * 0.9 : null,
        };
    });

/**
 * Everything the Insight screen draws.
 *
 * @param {Array} meals              MealLog rows in the window, any order
 * @param {object|null} targets      the plan's daily targets
 * @param {number} windowDays        how many calendar days were asked for
 */
const summariseWindow = (meals, targets = null, windowDays = 30) => {
    const grouped = byDay(meals);
    const dayTotals = [...grouped.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, dayMeals]) => ({
            day,
            mealCount: dayMeals.length,
            totals: totalsOf(dayMeals),
        }));

    const loggedDays = dayTotals.length;
    const totals = totalsOf(meals);

    // Divided by days logged, not by `windowDays` — see the note at the top of the file
    const averages = loggedDays ? {
        calories: Math.round(totals.calories / loggedDays),
        protein: Math.round(totals.protein / loggedDays),
        carbs: Math.round(totals.carbs / loggedDays),
        fat: Math.round(totals.fat / loggedDays),
        fibre: Math.round(totals.fibre / loggedDays),
        meals: Number((meals.length / loggedDays).toFixed(1)),
    } : null;

    return {
        windowDays,
        loggedDays,
        mealCount: meals.length,
        totals,
        averages,
        days: dayTotals,
        weekdays: weekdayProfile(dayTotals),
        goals: goalProgress(averages, targets || {}),
        /**
         * The chart's dashed average line. Null when nothing was logged, which the client
         * must handle rather than drawing a line at zero.
         */
        averageCalories: averages?.calories ?? null,
        calorieTarget: targets?.calories ?? null,
    };
};

module.exports = { summariseWindow, weekdayProfile, goalProgress, totalsOf, byDay, mean, WEEKDAYS };
