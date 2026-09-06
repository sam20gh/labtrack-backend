/**
 * Achievements.
 *
 * The reason `utils/achievementCatalogue.js` is a table and not a model is the same reason
 * `medicationInteractions.test.js` gives: you cannot assert that a language model will always
 * award the sleep badge to somebody who earned it, and there is no way to find out afterwards
 * which unlock was the one it missed.
 *
 * What has to hold:
 *   - **No achievement measures health.** This is the invariant the whole feature rests on
 *     and the easiest one to break by adding a single reasonable-looking entry.
 *   - **A badge is never taken back.** Progress is derived from live rows and can fall;
 *     the unlock is a stored row and cannot.
 *   - Crossing two thresholds at once awards two levels, and re-evaluating awards none.
 *   - Streaks are runs of consecutive days, not counts of days.
 *   - The leaderboard is invisible until somebody opts in, and carries no health data.
 *   - A share link publishes the badge and nothing else, and can be revoked.
 */
const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const catalogue = require('../utils/achievementCatalogue');
const engine = require('../utils/achievementEngine');
const controller = require('../controllers/achievementController');
const AchievementUnlock = require('../models/AchievementUnlock');
const AchievementProfile = require('../models/AchievementProfile');
const User = require('../models/userModel');
const MealLog = require('../models/MealLog');
const MetricLog = require('../models/MetricLog');

const userId = () => new mongoose.Types.ObjectId();

/** A response double, so handlers can be called without an HTTP server. */
const mockRes = () => {
    const res = { statusCode: 200, body: null, headers: {} };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    res.set = (h) => { Object.assign(res.headers, h); return res; };
    return res;
};

describe('the catalogue is a table, and it measures effort', () => {
    it('reads no clinical value', () => {
        // The invariant. Every metric counts an action; none reads a result, a band, a flag
        // or a score. A badge for a blood pressure in range would reward the people whose
        // bodies already cooperate and would tell everyone else their illness cost them
        // points — see the note at the top of the catalogue.
        const clinical = [
            /systolic/i, /diastolic/i, /\bbmi\b/i, /restingBpm/i, /score/i,
            /flag/i, /inRange/i, /normal/i, /healthy/i, /efficiency/i,
        ];

        for (const a of catalogue.ACHIEVEMENTS) {
            for (const pattern of clinical) {
                expect(a.metric).not.toMatch(pattern);
            }
        }
    });

    it('never promises a health outcome in its copy', () => {
        for (const a of catalogue.ACHIEVEMENTS) {
            expect(a.how).not.toMatch(/healthy|improve|lower|reduce|better/i);
        }
    });

    it('has a metric the engine actually produces for every entry', () => {
        // A metric nothing measures is a badge that can never unlock, and it fails silently:
        // `undefined` grades as 0 and the badge simply sits there locked forever.
        const produced = Object.keys(engine.measure({}));
        for (const metric of catalogue.REQUIRED_METRICS) {
            expect(produced).toContain(metric);
        }
    });

    it('has ascending, reachable thresholds and a drawable badge', () => {
        for (const a of catalogue.ACHIEVEMENTS) {
            expect(a.levels.length).toBeGreaterThan(0);
            for (let i = 1; i < a.levels.length; i++) {
                expect(a.levels[i]).toBeGreaterThan(a.levels[i - 1]);
            }
            // The first rung has to be reachable in a first week, or the grid is a wall.
            expect(a.levels[0]).toBeLessThanOrEqual(5000);
            // ≤34 characters, the cap `medicationCatalogue.plainName` carries: the grid is
            // three columns wide and a name that wraps to three lines ruins the row.
            expect(a.plainName.length).toBeLessThanOrEqual(34);

            expect(catalogue.DRAWABLE_SHAPES).toContain(a.shape);
            expect(catalogue.DRAWABLE_GLYPHS).toContain(a.glyph);
            expect(catalogue.CATEGORIES[a.category]).toBeDefined();
            // A badge somebody is told about and cannot open the tracker for is the dead end
            // `PILLAR_ROUTE` exists to prevent on the score screen.
            expect(catalogue.CATEGORIES[a.category].route).toBeTruthy();
        }
    });

    it('measures progress from the previous rung, not from zero', () => {
        const a = catalogue.BY_KEY.get('first_steps'); // 1,000 / 25,000 / 250,000 / 1,000,000
        expect(catalogue.grade(a, 0).progress).toBe(0);
        expect(catalogue.grade(a, 500).progress).toBeCloseTo(0.5);

        // 1,240 steps is level 1 and barely into level 2 — not 5% of the way, which is what
        // measuring from zero would draw.
        const g = catalogue.grade(a, 1240);
        expect(g.level).toBe(1);
        expect(g.progress).toBeCloseTo(240 / 24000, 4);

        const top = catalogue.grade(a, 5_000_000);
        expect(top.level).toBe(4);
        expect(top.next).toBeNull();
        expect(top.progress).toBe(1);
    });
});

describe('streaks are runs, not counts', () => {
    it('finds the longest unbroken run', () => {
        expect(engine.longestRun(['2026-01-01', '2026-01-02', '2026-01-03'])).toBe(3);
        // Ten days, but never two in a row.
        expect(engine.longestRun(
            ['2026-01-01', '2026-01-03', '2026-01-05', '2026-01-07', '2026-01-09'],
        )).toBe(1);
        // A gap resets, and the best run wins whether it came first or last.
        expect(engine.longestRun(
            ['2026-01-01', '2026-01-02', '2026-01-09', '2026-01-10', '2026-01-11'],
        )).toBe(3);
    });

    it('is unmoved by duplicates and by order', () => {
        expect(engine.longestRun(
            ['2026-03-02', '2026-03-01', '2026-03-02', '2026-03-03'],
        )).toBe(3);
        expect(engine.longestRun([])).toBe(0);
    });

    it('crosses a month and a leap day', () => {
        expect(engine.longestRun(['2026-01-30', '2026-01-31', '2026-02-01'])).toBe(3);
        expect(engine.longestRun(['2028-02-28', '2028-02-29', '2028-03-01'])).toBe(3);
    });
});

describe('measure() is pure and counts only what happened', () => {
    it('sums nulls as absent, not as zero', () => {
        // A watch that was not worn and a day of no steps are different facts.
        const m = engine.measure({
            dailyMetrics: [
                { day: '2026-01-01', activity: { steps: 4000 } },
                { day: '2026-01-02', activity: { steps: null } },
                { day: '2026-01-03', activity: { steps: 6000 } },
            ],
        });
        expect(m.stepsTotal).toBe(10000);
        // Only the two days that reported anything are active days, so the run is not 3.
        expect(m.activeDayStreak).toBe(1);
    });

    it('counts a hydration day only when a target existed for it', () => {
        const m = engine.measure({
            dailyMetrics: [
                { day: '2026-01-01', hydration: { consumedMl: 2500, targetMl: 2000 } },
                { day: '2026-01-02', hydration: { consumedMl: 900, targetMl: 2000 } },
                // No target set: reaching it is a division by nothing, not an achievement.
                { day: '2026-01-03', hydration: { consumedMl: 3000, targetMl: null } },
            ],
        });
        expect(m.hydrationDaysMet).toBe(1);
    });

    it('counts trackers used rather than trackers opened', () => {
        expect(engine.measure({}).trackersUsed).toBe(0);
        expect(engine.measure({
            meals: [{ day: '2026-01-01' }],
            metricLogs: [{ kind: 'water', day: '2026-01-01' }],
        }).trackersUsed).toBe(2);
    });

    it('takes days with LabTrack from a passed clock, not from Date.now', () => {
        const joined = Date.parse('2026-01-01T00:00:00Z');
        const m = engine.measure({ joinedAt: new Date(joined) }, joined + 40 * 86400000);
        expect(m.daysSinceJoining).toBe(40);
    });
});

describe('unlocking', () => {
    let id;

    beforeEach(async () => {
        id = userId();
        await User.create({
            _id: id, username: `ada-${id}`, email: `a${id}@example.com`, password: 'x', firstName: 'Ada',
            createdAt: new Date(Date.now() - 40 * 86400000),
        });
    });

    const logMeals = (count, from = '2026-01-01') => MealLog.insertMany(
        Array.from({ length: count }, (_, i) => ({
            userId: id,
            eatenAt: new Date(Date.parse(`${from}T12:00:00Z`) + i * 86400000),
            day: new Date(Date.parse(`${from}T12:00:00Z`) + i * 86400000).toISOString().slice(0, 10),
            slot: 'lunch',
            name: `Meal ${i}`,
            calories: 500,
        })),
    );

    it('writes one row per level and awards every rung crossed at once', async () => {
        // Twenty-five meals in twenty-five consecutive days clears Nutrition Pro levels 1
        // and 2 in a single evaluation. Awarding only the highest would silently swallow a
        // badge the person earned.
        await logMeals(25);
        const result = await controller.evaluate(id);

        const rows = await AchievementUnlock.find({ userId: id, key: 'nutrition_pro' }).sort({ level: 1 });
        expect(rows.map((r) => r.level)).toEqual([1, 2]);
        expect(rows[1].threshold).toBe(25);

        const pro = result.achievements.find((a) => a.key === 'nutrition_pro');
        expect(pro.level).toBe(2);
        expect(pro.unlocked).toBe(true);
    });

    it('is idempotent — re-evaluating awards nothing new', async () => {
        await logMeals(25);
        await controller.evaluate(id);
        const second = await controller.evaluate(id);

        expect(second.fresh).toBe(0);
        expect(await AchievementUnlock.countDocuments({ userId: id, key: 'nutrition_pro' })).toBe(2);
    });

    it('never takes a badge back when the underlying data goes away', async () => {
        // The whole reason `AchievementUnlock` exists. Progress is derived, so deleting your
        // own meals lowers the count; the badge must survive it, or a card already shared in
        // a chat becomes a lie and tidying your records becomes a punishment.
        await logMeals(25);
        await controller.evaluate(id);

        await MealLog.deleteMany({ userId: id });
        const after = await controller.evaluate(id);

        const pro = after.achievements.find((a) => a.key === 'nutrition_pro');
        expect(pro.level).toBe(2);
        expect(pro.unlocked).toBe(true);
        expect(await AchievementUnlock.countDocuments({ userId: id, key: 'nutrition_pro' })).toBe(2);
    });

    it('marks a celebration seen once and does not repeat it', async () => {
        await logMeals(3);
        await controller.evaluate(id);

        const first = mockRes();
        await controller.getAchievements({ auth: { userId: id } }, first);
        expect(first.body.celebrate.length).toBeGreaterThan(0);
        expect(first.body.celebrate[0]).toHaveProperty('name');

        await controller.markSeen({ auth: { userId: id }, body: {} }, mockRes());

        const second = mockRes();
        await controller.getAchievements({ auth: { userId: id } }, second);
        expect(second.body.celebrate).toEqual([]);
    });

    it('reports a summary the screen can render without recomputing anything', async () => {
        await logMeals(3);
        const res = mockRes();
        await controller.getAchievements({ auth: { userId: id } }, res);

        expect(res.body.summary.total).toBe(catalogue.ACHIEVEMENTS.length);
        expect(res.body.summary.unlocked).toBeGreaterThan(0);
        expect(res.body.summary.maxPoints).toBe(catalogue.MAX_POINTS);
        // The grid draws locked badges too — one you cannot see is one nobody works towards.
        expect(res.body.achievements.length).toBe(catalogue.ACHIEVEMENTS.length);
        expect(res.body.achievements.some((a) => !a.unlocked)).toBe(true);
    });
});

describe('sharing', () => {
    let id;

    beforeEach(async () => {
        id = userId();
        await User.create({ _id: id, username: `sam-${id}`, email: `s${id}@example.com`, password: 'x', firstName: 'Ada' });
        await MetricLog.insertMany(
            Array.from({ length: 6 }, (_, i) => ({
                userId: id, kind: 'water', day: '2026-01-01',
                measuredAt: new Date(), ml: 250,
            })),
        );
        await controller.evaluate(id);
    });

    it('refuses to share a badge that was never unlocked, with 409 not 403', async () => {
        // The request is well formed and the caller is entitled to it. There is simply
        // nothing yet to share, which is a conflict with state, not a permission problem.
        const res = mockRes();
        await controller.shareAchievement({ auth: { userId: id }, params: { key: 'long_hauler' } }, res);
        expect(res.statusCode).toBe(409);
        expect(res.body.code).toBe('not_unlocked');
    });

    it('returns the same link twice, so a card already sent keeps working', async () => {
        const a = mockRes();
        await controller.shareAchievement({ auth: { userId: id }, params: { key: 'hydro_homie' } }, a);
        const b = mockRes();
        await controller.shareAchievement({ auth: { userId: id }, params: { key: 'hydro_homie' } }, b);

        expect(a.body.token).toBeTruthy();
        expect(a.body.token).toBe(b.body.token);
        expect(a.body.token.length).toBeGreaterThanOrEqual(32);
    });

    it('publishes the badge and nothing else', async () => {
        const share = mockRes();
        await controller.shareAchievement({ auth: { userId: id }, params: { key: 'hydro_homie' } }, share);

        const card = mockRes();
        await controller.cardForToken({ params: { token: share.body.token } }, card);

        expect(card.statusCode).toBe(200);
        expect(card.body.badge.name).toBe('Hydro Homie');
        expect(card.body.earned).toMatch(/^\d{4}-\d{2}$/); // month, never a day

        // Nothing identifying and nothing clinical may reach a page anyone with the link
        // can open. This is the assertion that keeps `cardForToken` small.
        const serialised = JSON.stringify(card.body);
        expect(serialised).not.toContain(String(id));
        expect(serialised).not.toMatch(/@example\.com/);
        expect(card.body).not.toHaveProperty('userId');
    });

    it('publishes a name only for somebody who chose to be visible', async () => {
        // `AchievementProfile` seeds `displayName` from the account's first name so the
        // leaderboard opt-in has something in its field. A seeded value is not a choice, and
        // publishing it would put a real first name on a page anyone with the link can open
        // because somebody tapped Share.
        const share = mockRes();
        await controller.shareAchievement({ auth: { userId: id }, params: { key: 'hydro_homie' } }, share);

        const before = mockRes();
        await controller.cardForToken({ params: { token: share.body.token } }, before);
        expect(before.body.person).toEqual({ name: null, avatar: null });
        expect(JSON.stringify(before.body)).not.toContain('Ada');

        await controller.updateLeaderboardProfile(
            { auth: { userId: id }, body: { optedIn: true, displayName: 'Ada L' } }, mockRes(),
        );

        const after = mockRes();
        await controller.cardForToken({ params: { token: share.body.token } }, after);
        expect(after.body.person.name).toBe('Ada L');
    });

    it('previews exactly what it will publish', async () => {
        // The app draws a preview before sharing and the portal draws the public card; they
        // are two drawings of one design and must at least be drawing the same facts.
        const share = mockRes();
        await controller.shareAchievement({ auth: { userId: id }, params: { key: 'hydro_homie' } }, share);

        const detail = mockRes();
        await controller.getAchievement({ auth: { userId: id }, params: { key: 'hydro_homie' } }, detail);
        const card = mockRes();
        await controller.cardForToken({ params: { token: share.body.token } }, card);

        expect(detail.body.person).toEqual(card.body.person);
        expect(detail.body.name).toBe(card.body.badge.name);
        expect(detail.body.shape).toBe(card.body.badge.shape);
        expect(detail.body.glyph).toBe(card.body.badge.glyph);
        expect(detail.body.tone).toBe(card.body.badge.tone);
    });

    it('stops resolving once revoked, and says nothing about having existed', async () => {
        const share = mockRes();
        await controller.shareAchievement({ auth: { userId: id }, params: { key: 'hydro_homie' } }, share);
        const token = share.body.token;

        await controller.revokeShare({ auth: { userId: id }, params: { key: 'hydro_homie' } }, mockRes());

        const card = mockRes();
        await controller.cardForToken({ params: { token } }, card);
        // 404, identical to a token that never existed: confirming that one *used* to work
        // tells a stranger something about somebody.
        expect(card.statusCode).toBe(404);

        const unknown = mockRes();
        await controller.cardForToken({ params: { token: 'never-issued-token' } }, unknown);
        expect(unknown.body).toEqual(card.body);

        // The badge itself is untouched.
        expect(await AchievementUnlock.countDocuments({ userId: id, key: 'hydro_homie' })).toBeGreaterThan(0);
    });
});

describe('the leaderboard', () => {
    let mine;
    let theirs;

    beforeEach(async () => {
        mine = userId();
        theirs = userId();
        await User.create([
            { _id: mine, username: `ada-${mine}`, email: `m${mine}@example.com`, password: 'x', firstName: 'Ada' },
            { _id: theirs, username: `grace-${theirs}`, email: `t${theirs}@example.com`, password: 'x', firstName: 'Grace' },
        ]);
        await AchievementProfile.create([
            { userId: mine, points: 100, unlockedCount: 2, optedIn: false, displayName: 'Ada' },
            { userId: theirs, points: 400, unlockedCount: 6, optedIn: true, displayName: 'Grace' },
        ]);
    });

    it('shows nobody who has not opted in', async () => {
        const res = mockRes();
        await controller.getLeaderboard({ auth: { userId: mine } }, res);

        expect(res.body.board.map((r) => r.name)).toEqual(['Grace']);
        expect(res.body.participants).toBe(1);
        // Their own number is still shown, so opting in is not a blind choice.
        expect(res.body.you.points).toBe(100);
        expect(res.body.you.optedIn).toBe(false);
        expect(res.body.you.rank).toBeNull();
    });

    it('ranks by counting everyone ahead, and says what it is counting', async () => {
        await controller.updateLeaderboardProfile(
            { auth: { userId: mine }, body: { optedIn: true } }, mockRes(),
        );

        const res = mockRes();
        await controller.getLeaderboard({ auth: { userId: mine } }, res);
        expect(res.body.you.rank).toBe(2);
        expect(res.body.board.find((r) => r.isYou).name).toBe('Ada');
        // A scoreboard in a health app has to say what it counts, or a low position reads
        // as a statement about the person.
        expect(res.body.disclaimer).toMatch(/say nothing about anybody's health/);
    });

    it('leaves the board immediately when somebody opts out', async () => {
        await controller.updateLeaderboardProfile(
            { auth: { userId: theirs }, body: { optedIn: false } }, mockRes(),
        );
        const res = mockRes();
        await controller.getLeaderboard({ auth: { userId: mine } }, res);
        expect(res.body.board).toEqual([]);
        expect(res.body.participants).toBe(0);
    });

    it('carries no health data on a board row', async () => {
        await controller.updateLeaderboardProfile(
            { auth: { userId: mine }, body: { optedIn: true } }, mockRes(),
        );
        const res = mockRes();
        await controller.getLeaderboard({ auth: { userId: mine } }, res);

        for (const row of res.body.board) {
            expect(Object.keys(row).sort()).toEqual(
                ['avatar', 'isYou', 'name', 'points', 'rank', 'unlocked'],
            );
        }
    });
});

describe('the stats tab', () => {
    it('reports counts of actions and no clinical figure', async () => {
        const id = userId();
        await User.create({ _id: id, username: `stat-${id}`, email: `st${id}@example.com`, password: 'x' });

        const res = mockRes();
        await controller.getStats({ auth: { userId: id } }, res);

        const labels = res.body.sections.flatMap((s) => s.rows.map((r) => r.label));
        expect(labels).toContain('Steps recorded');
        // The design puts this screen behind a "Share my stats" button, which is the last
        // place a clinical number belongs. The score lives on /score, where it is explained.
        for (const label of labels) {
            expect(label).not.toMatch(/blood pressure reading of|score|weight is|bmi/i);
        }
        expect(res.body.note).toMatch(/none of them are included here/);
    });
});

describe('routing', () => {
    /**
     * Mounted the way `index.js` mounts it, because two things here are only true at the
     * router level and both fail silently:
     *
     *   - `GET /card/:token` sits **above** `router.use(authenticateToken)`. Move it below and
     *     every share link 401s — for an audience that has no session and cannot get one, so
     *     the failure is invisible to everybody who can test it.
     *   - `/:key` is mounted **last**. Move it up and it swallows `/stats` and `/leaderboard`,
     *     which then 404 as unknown badges rather than answering.
     */
    const app = express();
    app.use(express.json());
    app.use('/api/achievements', require('../routes/achievementRoutes'));

    let id;
    let auth;

    beforeEach(async () => {
        id = userId();
        await User.create({ _id: id, username: `r-${id}`, email: `r${id}@example.com`, password: 'x', firstName: 'Ada' });
        await MetricLog.insertMany(Array.from({ length: 6 }, () => ({
            userId: id, kind: 'water', day: '2026-01-01', measuredAt: new Date(), ml: 250,
        })));
        const token = jwt.sign({ id: String(id) }, process.env.SECRET_KEY);
        auth = (r) => r.set('Authorization', `Bearer ${token}`);
    });

    it('serves the card without a token and everything else only with one', async () => {
        await request(app).get('/api/achievements/card/never-issued').expect(404);
        await request(app).get('/api/achievements').expect(401);
        await request(app).get('/api/achievements/leaderboard').expect(401);
    });

    it('does not let /:key swallow the named routes', async () => {
        await auth(request(app).get('/api/achievements/stats')).expect(200);
        await auth(request(app).get('/api/achievements/leaderboard')).expect(200);
        await auth(request(app).get('/api/achievements/hydro_homie')).expect(200);
        await auth(request(app).get('/api/achievements/no_such_badge')).expect(404);
    });

    it('runs share → card → revoke end to end', async () => {
        const hub = await auth(request(app).get('/api/achievements')).expect(200);
        expect(hub.body.achievements.length).toBe(catalogue.ACHIEVEMENTS.length);

        const share = await auth(request(app).post('/api/achievements/hydro_homie/share')).expect(200);
        const card = await request(app).get(`/api/achievements/card/${share.body.token}`).expect(200);
        expect(card.body.badge.name).toBe('Hydro Homie');

        await auth(request(app).delete('/api/achievements/hydro_homie/share')).expect(200);
        await request(app).get(`/api/achievements/card/${share.body.token}`).expect(404);
    });
});
