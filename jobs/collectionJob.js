/**
 * The home-collection sweep, every five minutes:
 *
 *   - **expire holds** — a slot held during a checkout nobody finished goes back on sale. Five
 *     minutes is the most a lapsed hold can keep a place from somebody else, against a
 *     35-minute hold; a slot at five visits can absorb that.
 *   - **reminders** — once, twelve hours before each visit, with the fasting note when a
 *     blood test needs it. See `REMINDER_HOURS` for why twelve and not "the evening before".
 *
 * Both are idempotent, so a missed run or two instances running at once does no harm.
 */
const { expireHolds, sendReminders } = require('../utils/collectionCentre');

const runCollectionSweep = async (now = new Date()) => {
    const expired = await expireHolds(now);
    const reminded = await sendReminders(now);
    if (expired || reminded) console.log(`🏠 Collection sweep: ${expired} hold(s) expired, ${reminded} reminder(s) sent`);
    return { expired, reminded };
};

const scheduleCollectionSweep = () => {
    const cron = require('node-cron');
    cron.schedule('*/5 * * * *', () => {
        runCollectionSweep().catch((e) => console.error('❌ Collection sweep failed:', e.message));
    });
    console.log('🏠 Collection sweep scheduled (every 5 minutes)');
};

module.exports = { runCollectionSweep, scheduleCollectionSweep };
