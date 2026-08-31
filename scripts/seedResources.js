/**
 * Seed the health resource library with placeholder content.
 *
 * Idempotent — categories and authors upsert on `slug`, resources on `source.externalId`
 * under the source name `seed`. Re-running updates in place rather than publishing a second
 * copy of everything.
 *
 *   node scripts/seedResources.js
 *   node scripts/seedResources.js --purge     # remove seeded rows and stop
 *
 * ## This content is placeholder and is marked as such
 *
 * Every row carries `source.name = 'seed'`, so the real import from the website can be told
 * apart from this and this can be removed in one query when it arrives. The copy is written
 * to be *safe* rather than clinically authoritative: general wellbeing guidance, no numbers,
 * no dosing, no thresholds — the same rule `biomarkerGlossary` and `medicationCatalogue`
 * follow, because a placeholder that states a reference range will eventually be read by
 * someone as though it were reviewed.
 *
 * Images are Unsplash URLs so the app has something real to lay out against. Replace them
 * with Cloudflare delivery URLs before launch — read from the upload response, never
 * assembled. See the imageStore note in CLAUDE.md.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Resource = require('../models/Resource');
const ResourceCategory = require('../models/ResourceCategory');
const ResourceAuthor = require('../models/ResourceAuthor');

const SOURCE = 'seed';
const img = (id, w = 1200) => `https://images.unsplash.com/photo-${id}?w=${w}&q=80&auto=format&fit=crop`;

// ── taxonomy ────────────────────────────────────────────────────────────────
const CATEGORIES = [
    { slug: 'healthcare', name: 'Healthcare', group: 'Wellness', groupOrder: 1, icon: 'medkit-outline', order: 1 },
    { slug: 'wellness', name: 'Wellness', group: 'Wellness', groupOrder: 1, icon: 'heart-outline', order: 2 },
    { slug: 'sleep', name: 'Sleep', group: 'Wellness', groupOrder: 1, icon: 'moon-outline', order: 3 },
    { slug: 'mental-health', name: 'Mental Health', group: 'Wellness', groupOrder: 1, icon: 'happy-outline', order: 4 },

    { slug: 'jogging', name: 'Jogging', group: 'Fitness', groupOrder: 2, icon: 'walk-outline', order: 1 },
    { slug: 'meditation', name: 'Meditation', group: 'Fitness', groupOrder: 2, icon: 'body-outline', order: 2 },
    { slug: 'strength', name: 'Strength', group: 'Fitness', groupOrder: 2, icon: 'barbell-outline', order: 3 },

    { slug: 'vitamins', name: 'Vitamins', group: 'Nutrition', groupOrder: 3, icon: 'flask-outline', order: 1 },
    { slug: 'nutrients', name: 'Nutrients', group: 'Nutrition', groupOrder: 3, icon: 'nutrition-outline', order: 2 },
    { slug: 'hydration', name: 'Hydration', group: 'Nutrition', groupOrder: 3, icon: 'water-outline', order: 3 },

    { slug: 'health-metrics', name: 'Health Metrics', group: 'Understanding your results', groupOrder: 4, icon: 'pulse-outline', order: 1 },
    { slug: 'lab-results', name: 'Lab Results', group: 'Understanding your results', groupOrder: 4, icon: 'document-text-outline', order: 2 },
];

// ── authors ─────────────────────────────────────────────────────────────────
const AUTHORS = [
    {
        slug: 'lorna-gray', name: 'Dr. Lorna Gray, MBBS', speciality: 'General Practice',
        headline: 'Preventive medicine and everyday wellbeing',
        avatar: img('1594824476967-48c8b964273f', 300),
        coverImage: img('1576091160399-112ba8d25d1d'),
        bio: 'Dr. Lorna Gray writes about the everyday decisions that add up over a decade — sleep, movement, what is on the plate — and about reading a lab report without panicking about it.',
        achievements: [
            { icon: 'medkit-outline', title: '12 years in general practice', detail: 'Community clinics, with a focus on preventive care.' },
            { icon: 'school-outline', title: 'Preventive medicine faculty', detail: 'Teaches on screening and risk communication.' },
        ],
        contact: { email: 'editorial@labtrack.example' },
        socials: { linkedin: 'https://linkedin.com/in/example', website: 'https://labtrack.example' },
        followerCount: 25400,
    },
    {
        slug: 'julis-teal', name: 'Julis Teal, RD', speciality: 'Registered Dietitian',
        headline: 'Balanced eating without the rules',
        avatar: img('1438761681033-6461ffad8d80', 300),
        coverImage: img('1490645935967-10de6ba17061'),
        bio: 'Julis Teal is a registered dietitian who spends most of her time undoing things people read on the internet. She writes about building meals rather than restricting them.',
        achievements: [
            { icon: 'restaurant-outline', title: 'Clinical dietetics', detail: 'Ten years across hospital and outpatient nutrition.' },
            { icon: 'book-outline', title: 'Published author', detail: 'Writes a weekly column on practical nutrition.' },
        ],
        contact: { email: 'editorial@labtrack.example' },
        socials: { instagram: 'https://instagram.com/example' },
        followerCount: 18200,
    },
    {
        slug: 'mark-james', name: 'Mark James, MSc', speciality: 'Exercise Physiologist',
        headline: 'Movement that fits around a life',
        avatar: img('1500648767791-00dcc994a43e', 300),
        coverImage: img('1552674605-db6ffd4facb5'),
        bio: 'Mark James works with people starting from nothing, and writes about the first six weeks — the part most training plans skip.',
        achievements: [
            { icon: 'fitness-outline', title: 'Exercise physiology, MSc', detail: 'Cardiac rehabilitation and return-to-activity programmes.' },
        ],
        contact: { email: 'editorial@labtrack.example' },
        socials: { x: 'https://x.com/example' },
        followerCount: 9800,
    },
    {
        slug: 'azunyan-mcdonalds', name: 'Dr. Azunyan McDonalds, PhD', speciality: 'Clinical Biochemistry',
        headline: 'What your results actually measure',
        avatar: img('1559839734-2b71ea197ec2', 300),
        coverImage: img('1579154204601-01588f351e67'),
        bio: 'Dr. McDonalds explains laboratory medicine to the people whose blood it came from — what a marker is, what moves it, and what a single reading can and cannot tell you.',
        achievements: [
            { icon: 'flask-outline', title: 'Clinical biochemistry, PhD', detail: 'Research on reference intervals and result interpretation.' },
            { icon: 'mic-outline', title: 'Audio series host', detail: 'Presents the "Understanding your results" audio series.' },
        ],
        contact: { email: 'editorial@labtrack.example' },
        socials: { linkedin: 'https://linkedin.com/in/example' },
        followerCount: 31500,
    },
];

// ── content ─────────────────────────────────────────────────────────────────
const p = (text) => ({ type: 'paragraph', text });
const h = (text) => ({ type: 'heading', text });
const check = (items) => ({ type: 'checklist', items });
const list = (items) => ({ type: 'list', items });
const image = (id, caption) => ({ type: 'image', url: img(id), caption });

const RESOURCES = [
    // ── articles ────────────────────────────────────────────────────────────
    {
        externalId: 'seed-article-sleep-science', type: 'article', featured: true,
        title: 'The Science Behind Sleep: How Better Rest Improves Your Health',
        excerpt: 'Sleep is not a daily reset. It is a pillar of health that touches almost every system in the body.',
        categorySlug: 'sleep', authorSlug: 'lorna-gray', tags: ['Tips & Tricks', 'Health'],
        heroImage: img('1541781774459-bb2af2f05b55'), readMinutes: 4,
        body: [
            h('Overview'),
            p('Sleep is not just a daily reset; it is a fundamental pillar of health that affects nearly every aspect of your body and mind. Yet in a world driven by productivity, sleep often takes a back seat. This article looks at what happens while you are asleep and why it matters over the long term.'),
            image('1520206183501-b80df61043c2', 'Consistency matters more than any single long night.'),
            h('Why sleep is essential'),
            p('Cellular repair and recovery: during deep sleep your body repairs tissue, builds muscle and synthesises proteins. This is a large part of how you recover from ordinary daily wear, and it matters more when you are physically active.'),
            p('Brain maintenance: the glymphatic system is more active during sleep, clearing metabolic by-products from brain tissue. Memory consolidation happens here too — sleep is part of how the day is filed rather than merely paused.'),
            h('What better sleep tends to bring'),
            check([
                'Steadier cardiovascular health',
                'More predictable appetite and energy',
                'A more resilient immune response',
                'Better mood stability',
            ]),
            h('Where to start'),
            list([
                'Keep the wake time fixed, even at weekends — it anchors everything else.',
                'Get daylight early; it does more for the body clock than any evening routine.',
                'Treat the last hour before bed as a wind-down rather than a deadline.',
                'If you are lying awake, get up. Bed should not become the place you worry in.',
            ]),
            h('Final thoughts'),
            p('Sleep is a cornerstone of good health that no shortcut replaces. Small consistent changes to your sleep tend to outperform occasional dramatic ones. If poor sleep persists despite them, it is worth raising with a clinician rather than optimising around.'),
        ],
        stats: { views: 2500, likes: 33, comments: 5 },
    },
    {
        externalId: 'seed-article-macros', type: 'article',
        title: 'Understanding Essential Macronutrients and Micronutrients',
        excerpt: 'Protein, fat and carbohydrate do the heavy lifting. Vitamins and minerals decide how well it goes.',
        categorySlug: 'nutrients', authorSlug: 'julis-teal', tags: ['Nutrition', 'Health Metrics'],
        heroImage: img('1490645935967-10de6ba17061'), readMinutes: 5,
        body: [
            h('Overview'),
            p('Macronutrients are the three things your body needs in quantity: protein, fat and carbohydrate. Micronutrients — vitamins and minerals — are needed in far smaller amounts, and shortfalls in them are easy to miss because the symptoms are vague.'),
            h('The three macronutrients'),
            list([
                'Protein builds and repairs tissue, and is the one most often under-eaten.',
                'Fat carries fat-soluble vitamins and is part of every cell membrane.',
                'Carbohydrate is the body\'s most accessible fuel, particularly for the brain.',
            ]),
            h('Why micronutrients get missed'),
            p('A diet can meet every calorie and macro target and still be short on iron, vitamin D or B12. Those shortfalls show up as tiredness and low mood long before anything more specific, which is why they are worth measuring rather than guessing at.'),
            h('A practical approach'),
            check([
                'Build the plate around a protein source first',
                'Aim for variety of colour rather than a supplement for each gap',
                'Treat supplements as a response to a measured shortfall',
            ]),
            p('If you have recent blood work, it is a better guide than any general advice here — including this article.'),
        ],
        stats: { views: 12000, likes: 121, comments: 2 },
    },
    {
        externalId: 'seed-article-hydration', type: 'article', featured: true,
        title: 'Hydration: Essential for Optimal Bodily Function',
        excerpt: 'How much water you need is not a fixed number, and the colour of the answer is on your own chart.',
        categorySlug: 'hydration', authorSlug: 'mark-james', tags: ['Wellness', 'Tips & Tricks'],
        heroImage: img('1523362628745-0c100150b504'), readMinutes: 3,
        body: [
            h('Overview'),
            p('Water carries nutrients, regulates temperature and keeps joints lubricated. Needs vary with body size, activity, climate and what else you are drinking, which is why a single universal target has never held up well.'),
            h('What actually moves your needs'),
            list([
                'Body mass — larger bodies need more, roughly proportionally.',
                'Exercise — sweat losses can be substantial in a single session.',
                'Heat and altitude.',
                'Some medications and conditions, which is a conversation for your clinician.',
            ]),
            h('Things worth knowing'),
            check([
                'Tea and coffee count towards your intake',
                'Thirst is a late signal, not an early one',
                'More is not always better — there is such a thing as too much',
            ]),
            p('The tracker in this app derives a target from your recorded body mass and activity rather than asking you to pick one.'),
        ],
        stats: { views: 25000, likes: 32, comments: 5 },
    },
    {
        externalId: 'seed-article-labels', type: 'article', isPro: true, freeBlockCount: 3,
        title: 'Informed Food Choices: Reading Labels and Understanding Ingredients',
        excerpt: 'The front of the packet is marketing. The back is information.',
        categorySlug: 'nutrients', authorSlug: 'julis-teal', tags: ['Nutrition'],
        heroImage: img('1543168256-418811576931'), readMinutes: 6,
        body: [
            h('Overview'),
            p('Front-of-pack claims are chosen by whoever is selling the product. The ingredients list and the nutrition panel are the parts subject to rules, and they are where the useful information is.'),
            p('This piece walks through a panel line by line and shows what each row is actually telling you.'),
            h('Ingredients are ordered by weight'),
            p('The first three ingredients are most of what is in the packet. If a form of sugar appears twice under two names, read them together.'),
            h('Per 100g versus per serving'),
            p('Comparison is only fair per 100g. A serving size is chosen by the manufacturer and is frequently smaller than what anyone eats.'),
            h('Claims with legal meanings'),
            p('Some phrases are regulated and some are not. Knowing which is which is most of the skill.'),
        ],
        stats: { views: 250000, likes: 551, comments: 55 },
    },
    {
        externalId: 'seed-article-swaps', type: 'article',
        title: 'Making Smart Swaps: Reducing Added Sugars and Sodium',
        excerpt: 'Changing what is already in the trolley beats adding rules to it.',
        categorySlug: 'nutrients', authorSlug: 'julis-teal', tags: ['Nutrition', 'Tips & Tricks'],
        heroImage: img('1493770348161-369560ae357d'), readMinutes: 4,
        body: [
            h('Overview'),
            p('Most reduction happens by substitution rather than subtraction. The swap keeps the meal intact, which is why it survives past the second week.'),
            h('Where added sugar hides'),
            list(['Sauces and dressings', 'Breakfast cereals', 'Flavoured yoghurt', 'Drinks, including the ones marketed as healthy']),
            h('Where sodium hides'),
            list(['Bread', 'Processed meats', 'Stock and gravy', 'Anything tinned in brine']),
            h('Swaps that tend to stick'),
            check(['Buy the plain version and flavour it yourself', 'Rinse tinned pulses', 'Use herbs and acid before reaching for salt']),
        ],
        stats: { views: 250000, likes: 44, comments: 2 },
    },
    {
        externalId: 'seed-article-metrics', type: 'article',
        title: 'Understanding Your Health: The Metrics That Matter',
        excerpt: 'Six numbers explain more about your day-to-day health than most people expect.',
        categorySlug: 'health-metrics', authorSlug: 'azunyan-mcdonalds', tags: ['Health Metrics'],
        heroImage: img('1576091160550-2173dba999ef'), readMinutes: 5,
        body: [
            h('Overview'),
            p('Weight, blood pressure, resting heart rate, sleep duration, activity and hydration are measurable at home and move in response to things you can change. That combination is what makes them worth tracking.'),
            h('What a single reading is worth'),
            p('Very little on its own. Almost every one of these fluctuates hour to hour. What matters is the direction over weeks, which is why this app draws a trend rather than a verdict.'),
            h('When to bring one to a clinician'),
            check([
                'A reading that is repeatedly outside your usual range',
                'A change you cannot explain',
                'Anything accompanied by symptoms',
            ]),
        ],
        stats: { views: 100000, likes: 551, comments: 3 },
    },
    {
        externalId: 'seed-article-nutrition-power', type: 'article', featured: true,
        title: 'The Power of Nutrition: Key Foods for a Healthier Life',
        excerpt: 'A short list of foods that earn their place, and why.',
        categorySlug: 'nutrients', authorSlug: 'julis-teal', tags: ['Nutrition'],
        heroImage: img('1512621776951-a57141f2eefd'), readMinutes: 3,
        body: [
            h('Overview'),
            p('No single food changes an outcome. Patterns do. These are the ones that show up repeatedly in patterns associated with better long-term health.'),
            h('The short list'),
            list(['Leafy greens', 'Oily fish', 'Pulses and beans', 'Nuts and seeds', 'Whole grains', 'Fermented foods']),
            p('The point is not to eat all six today. It is that a week containing most of them looks different from a week containing none.'),
        ],
        stats: { views: 2500, likes: 22, comments: 10 },
    },

    // ── shorts ──────────────────────────────────────────────────────────────
    {
        externalId: 'seed-short-sleep', type: 'short',
        title: '3 Easy Ways to Improve Your Sleep Tonight',
        excerpt: 'Three things that work, in under two minutes.',
        categorySlug: 'sleep', authorSlug: 'lorna-gray', tags: ['Tips & Tricks'],
        heroImage: img('1531353826977-0941b4779a1c'), thumbnail: img('1531353826977-0941b4779a1c', 600),
        durationSeconds: 135,
        media: { videoUrl: 'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4' },
        stats: { views: 2200, likes: 128, comments: 6 },
    },
    {
        externalId: 'seed-short-hydration', type: 'short',
        title: 'Why Hydration Is Your Superpower',
        excerpt: 'What actually happens when you are two per cent down.',
        categorySlug: 'hydration', authorSlug: 'mark-james', tags: ['Wellness'],
        heroImage: img('1502740479091-635887520276'), thumbnail: img('1502740479091-635887520276', 600),
        durationSeconds: 115,
        media: { videoUrl: 'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4' },
        stats: { views: 90000, likes: 340, comments: 12 },
    },
    {
        externalId: 'seed-short-checkup', type: 'short',
        title: 'Top 5 Signs You Need to Check Your Blood Pressure',
        excerpt: 'Most of them are not what people expect.',
        categorySlug: 'health-metrics', authorSlug: 'azunyan-mcdonalds', tags: ['Health Metrics'],
        heroImage: img('1559757148-5c350d0d3c56'), thumbnail: img('1559757148-5c350d0d3c56', 600),
        durationSeconds: 72,
        media: { videoUrl: 'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4' },
        stats: { views: 1200000, likes: 5400, comments: 210 },
    },
    {
        externalId: 'seed-short-20s', type: 'short', featured: true,
        title: 'Things I Wish I Knew About Health in My 20s',
        excerpt: 'What a decade of general practice changes about your own habits.',
        categorySlug: 'wellness', authorSlug: 'lorna-gray', tags: ['Tips & Tricks'],
        heroImage: img('1594824476967-48c8b964273f'), thumbnail: img('1594824476967-48c8b964273f', 600),
        durationSeconds: 98,
        media: { videoUrl: 'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4' },
        stats: { views: 480000, likes: 128, comments: 22 },
    },

    // ── courses ─────────────────────────────────────────────────────────────
    {
        externalId: 'seed-course-metrics', type: 'course', featured: true,
        title: 'How to Measure Your Health Metrics',
        subtitle: 'Five short sessions on taking readings you can trust',
        excerpt: 'Blood pressure, weight, resting heart rate and hydration — how to measure each one properly.',
        categorySlug: 'health-metrics', authorSlug: 'azunyan-mcdonalds', tags: ['Health Metrics'],
        heroImage: img('1505576399279-565b52d4ac71'),
        course: {
            sessions: [
                { title: 'What is blood pressure?', durationSeconds: 72, preview: true, videoUrl: 'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4' },
                { title: 'What is cholesterol?', durationSeconds: 228, videoUrl: 'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4' },
                { title: 'Taking a reading at home', durationSeconds: 195, videoUrl: 'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4' },
                { title: 'Weighing yourself consistently', durationSeconds: 148, videoUrl: 'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4' },
                { title: 'Reading a trend, not a number', durationSeconds: 210, videoUrl: 'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerMeltdowns.mp4' },
            ],
        },
        stats: { views: 41000, likes: 620, comments: 18 },
    },
    {
        externalId: 'seed-course-jog', type: 'course',
        title: 'How to Jog Properly',
        subtitle: 'With 10 methods explained',
        excerpt: 'Form, pacing and the first six weeks — for people who have not run since school.',
        categorySlug: 'jogging', authorSlug: 'mark-james', tags: ['Fitness'],
        heroImage: img('1552674605-db6ffd4facb5'),
        course: {
            sessions: [
                { title: 'Before your first run', durationSeconds: 240, preview: true, videoUrl: 'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4' },
                { title: 'Cadence and form', durationSeconds: 300, videoUrl: 'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4' },
                { title: 'Run-walk, and why it works', durationSeconds: 180, videoUrl: 'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4' },
            ],
        },
        stats: { views: 12000, likes: 35, comments: 9 },
    },
    {
        externalId: 'seed-course-mental-health', type: 'course',
        title: 'Mental Health 101',
        subtitle: 'And why you should care about yourself',
        excerpt: 'An introduction to noticing, naming and acting on how you are actually doing.',
        categorySlug: 'mental-health', authorSlug: 'lorna-gray', tags: ['Wellness'],
        heroImage: img('1499209974431-9dddcece7f88'),
        course: {
            sessions: [
                { title: 'Noticing the early signals', durationSeconds: 145, preview: true, videoUrl: 'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4' },
                { title: 'What helps, and what only looks like it', durationSeconds: 220, videoUrl: 'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4' },
            ],
        },
        stats: { views: 15000, likes: 25, comments: 1 },
    },

    // ── workshops ───────────────────────────────────────────────────────────
    {
        externalId: 'seed-workshop-metrics', type: 'workshop', featured: true,
        title: 'Understanding Your Health: Metrics That Matter',
        excerpt: 'A live session on heart rate, blood pressure, hydration, sleep quality and activity tracking.',
        categorySlug: 'health-metrics', authorSlug: 'azunyan-mcdonalds', tags: ['Health Metrics', 'Wellness'],
        heroImage: img('1518611012118-696072aa579a'), readMinutes: 3,
        body: [
            h('Description'),
            p('Take control of your health with this workshop designed to demystify key health metrics.'),
            p('From heart rate to hydration, we will go through what these measurements mean, how to track them properly, and how they relate to each other — so the numbers in your app become something you can act on.'),
        ],
        workshop: {
            startsAt: new Date(Date.now() + 21 * 864e5), endsAt: new Date(Date.now() + 21 * 864e5 + 36e5),
            mode: 'hybrid', locationName: 'LabTrack Studio', address: '123 Springfield, Faze Avenue 22',
            timezone: 'Europe/London',
            whoShouldAttend: ['Health-conscious people', 'People new to tracking', 'Anyone with recent blood work', 'Anyone told to "keep an eye on" a number'],
            topics: [
                { title: 'Core health metrics', detail: 'What each of the six measures, and what moves it.' },
                { title: 'Personalised context', detail: 'Why your normal is not the same as anyone else\'s.' },
                { title: 'Interpreting metrics', detail: 'Reading a trend, and knowing when to raise one.' },
            ],
            priceCents: 3099, compareAtCents: 6099, currency: 'GBP', capacity: 200, attendeeCount: 1272,
        },
        stats: { views: 18500, likes: 240, comments: 12 },
    },
    {
        externalId: 'seed-workshop-eating', type: 'workshop',
        title: 'Principles of Healthy Eating and Balanced Diets',
        excerpt: 'A practical session on building meals rather than following rules.',
        categorySlug: 'nutrients', authorSlug: 'julis-teal', tags: ['Nutrition'],
        heroImage: img('1498837167922-ddd27525d352'), readMinutes: 3,
        body: [
            h('Description'),
            p('A working session on assembling meals that hold up on a Tuesday evening — planning, shopping and the handful of principles that survive contact with a real week.'),
        ],
        workshop: {
            startsAt: new Date(Date.now() + 35 * 864e5), endsAt: new Date(Date.now() + 35 * 864e5 + 54e5),
            mode: 'online', timezone: 'Europe/London',
            whoShouldAttend: ['Anyone cooking for a household', 'People starting from takeaways', 'Shift workers'],
            topics: [
                { title: 'Building a plate', detail: 'Protein first, then everything else.' },
                { title: 'Shopping once', detail: 'A list that survives the week.' },
            ],
            priceCents: 0, currency: 'GBP', capacity: 500, attendeeCount: 340,
        },
        stats: { views: 2200, likes: 33, comments: 1 },
    },
    {
        externalId: 'seed-workshop-meal-planning', type: 'workshop',
        title: 'Foundations of Meal Planning and Preparation',
        excerpt: 'Batch cooking, storage and the week-ahead plan.',
        categorySlug: 'nutrients', authorSlug: 'julis-teal', tags: ['Nutrition', 'Tips & Tricks'],
        heroImage: img('1466637574441-749b8f19452f'), readMinutes: 4,
        body: [h('Description'), p('Two hours on planning, prepping and storing a week of meals without cooking on every one of the seven days.')],
        workshop: {
            startsAt: new Date(Date.now() + 49 * 864e5), mode: 'online', timezone: 'Europe/London',
            whoShouldAttend: ['Busy households', 'Anyone who cooks in batches'],
            topics: [{ title: 'The week-ahead plan', detail: 'Deciding once instead of seven times.' }],
            priceCents: 1999, compareAtCents: 3999, currency: 'GBP', attendeeCount: 115100,
        },
        stats: { views: 115100, likes: 66, comments: 4 },
    },

    // ── audio ───────────────────────────────────────────────────────────────
    {
        externalId: 'seed-audio-cholesterol', type: 'audio', featured: true,
        title: 'Monitoring Your Cholesterol 101',
        excerpt: 'What the four numbers on a lipid panel are, and what they are for.',
        categorySlug: 'lab-results', authorSlug: 'azunyan-mcdonalds', tags: ['Health Metrics', 'Lab Results'],
        heroImage: img('1628348070889-cb656235b4eb'), durationSeconds: 301,
        media: {
            audioUrl: 'https://file-examples.com/storage/fe9278ad7f66ab53f4b8c4e/2017/11/file_example_MP3_700KB.mp3',
            transcript: [
                { startSeconds: 0, endSeconds: 31, text: 'Keeping track of your cholesterol levels is part of looking after your heart, and it is one of the more straightforward things to measure.' },
                { startSeconds: 31, endSeconds: 74, text: 'Cholesterol is a fatty substance found in your blood. Your body needs some of it to function, and the panel you get back separates it into parts rather than reporting one figure.' },
                { startSeconds: 74, endSeconds: 128, text: 'LDL is often called the "bad" cholesterol because, over time, higher levels are associated with build-up in the arteries.' },
                { startSeconds: 128, endSeconds: 186, text: 'HDL is described as the "good" cholesterol; it is involved in moving cholesterol away from the arteries and back to the liver.' },
                { startSeconds: 186, endSeconds: 240, text: 'Triglycerides are a separate fat measured on the same panel, and they respond quite quickly to what you have eaten recently — which is why fasting is sometimes asked for.' },
                { startSeconds: 240, endSeconds: 301, text: 'A single panel is a snapshot. What your clinician is looking at is the pattern across several, alongside everything else they know about you.' },
            ],
        },
        stats: { views: 34000, likes: 410, comments: 7 },
    },
    {
        externalId: 'seed-audio-preventive', type: 'audio',
        title: 'Understanding Preventive Care Screenings and Check-ups',
        excerpt: 'Why screening is offered by age band, and what a normal result actually means.',
        categorySlug: 'healthcare', authorSlug: 'lorna-gray', tags: ['Healthcare'],
        heroImage: img('1576091160399-112ba8d25d1d'), durationSeconds: 412,
        media: {
            audioUrl: 'https://file-examples.com/storage/fe9278ad7f66ab53f4b8c4e/2017/11/file_example_MP3_700KB.mp3',
            transcript: [
                { startSeconds: 0, endSeconds: 45, text: 'Screening is offered by age band because risk changes with age, not because a birthday changes anything about you personally.' },
                { startSeconds: 45, endSeconds: 110, text: 'A normal screening result means nothing was found at the time it was taken. It is not a guarantee about the future, which is why the intervals exist.' },
            ],
        },
        stats: { views: 10000, likes: 88, comments: 3 },
    },
    {
        externalId: 'seed-audio-vitamins', type: 'audio',
        title: 'Understanding Vitamins and Their Benefits',
        excerpt: 'Which vitamins are commonly short, and how you would know.',
        categorySlug: 'vitamins', authorSlug: 'julis-teal', tags: ['Nutrition', 'Vitamins'],
        heroImage: img('1490645935967-10de6ba17061'), durationSeconds: 288,
        media: {
            audioUrl: 'https://file-examples.com/storage/fe9278ad7f66ab53f4b8c4e/2017/11/file_example_MP3_700KB.mp3',
            transcript: [
                { startSeconds: 0, endSeconds: 40, text: 'Most vitamin shortfalls have vague symptoms, which is why they are usually found by measuring rather than by noticing.' },
            ],
        },
        stats: { views: 5200, likes: 60, comments: 2 },
    },
];

const run = async () => {
    await connectDB();

    if (process.argv.includes('--purge')) {
        const { deletedCount } = await Resource.deleteMany({ 'source.name': SOURCE });
        console.log(`🧹 Removed ${deletedCount} seeded resources`);
        await mongoose.connection.close();
        return;
    }

    const categoryIds = new Map();
    for (const category of CATEGORIES) {
        const doc = await ResourceCategory.findOneAndUpdate(
            { slug: category.slug }, { $set: category },
            { new: true, upsert: true, setDefaultsOnInsert: true },
        );
        categoryIds.set(category.slug, doc._id);
    }
    console.log(`✅ ${CATEGORIES.length} categories`);

    const authorIds = new Map();
    for (const author of AUTHORS) {
        const doc = await ResourceAuthor.findOneAndUpdate(
            { slug: author.slug }, { $set: author },
            { new: true, upsert: true, setDefaultsOnInsert: true },
        );
        authorIds.set(author.slug, doc._id);
    }
    console.log(`✅ ${AUTHORS.length} authors`);

    let created = 0;
    let updated = 0;
    // Spread publication dates backwards so "Newest first" has something to sort on and the
    // hub rails are not all stamped with the same minute.
    let day = 0;

    for (const item of RESOURCES) {
        const { externalId, categorySlug, authorSlug, ...rest } = item;
        const doc = {
            ...rest,
            /**
             * Only the `seed-` prefix comes off, not the type segment.
             *
             * Stripping both produced `hydration` from BOTH `seed-article-hydration` and
             * `seed-short-hydration`, and the unique index on `slug` rejected the second —
             * which is the index doing exactly its job. The type stays in the slug so an
             * article and a short on the same subject can coexist.
             */
            slug: externalId.replace(/^seed-/, ''),
            categoryId: categoryIds.get(categorySlug),
            authorId: authorIds.get(authorSlug),
            status: 'published',
            publishedAt: new Date(Date.now() - (day += 3) * 864e5),
            source: { name: SOURCE, externalId, url: null, importedAt: new Date() },
        };

        const existing = await Resource.findOne({ 'source.name': SOURCE, 'source.externalId': externalId });
        if (existing) {
            Object.assign(existing, doc);
            await existing.save();
            updated += 1;
        } else {
            await Resource.create(doc);
            created += 1;
        }
    }

    console.log(`✅ Resources: ${created} created, ${updated} updated`);
    console.log('   Types:', Object.entries(
        RESOURCES.reduce((acc, r) => ({ ...acc, [r.type]: (acc[r.type] || 0) + 1 }), {})
    ).map(([k, v]) => `${k}×${v}`).join(' '));

    await mongoose.connection.close();
};

run().catch(async (error) => {
    console.error('❌ Seed failed:', error);
    await mongoose.connection.close();
    process.exit(1);
});
