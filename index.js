require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');
const userRoutes = require('./routes/userRoutes');
const testResultRoutes = require('./routes/testResultRoutes');
const deepseekRoutes = require('./routes/deepseekRoutes');
const professionalRoutes = require('./routes/professionalRoutes');
const authRoutes = require('./routes/authRoutes');
const imageRoutes = require('./routes/imageRoutes');
const productRoutes = require('./routes/productRoutes');
const planRoutes = require('./routes/planRoutes');
const biomarkerRoutes = require('./routes/biomarkerRoutes');
const dnaReportRoutes = require('./routes/dnaReportRoutes');
const genotypeRoutes = require('./routes/genotypeRoutes');
const planItemRoutes = require('./routes/planItemRoutes');
const orderRoutes = require('./routes/orderRoutes');
const appointmentRoutes = require('./routes/appointmentRoutes');
const reportRoutes = require('./routes/reportRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const reviewRoutes = require('./routes/reviewRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const interpretationRoutes = require('./routes/interpretationRoutes');
const assistantRoutes = require('./routes/assistantRoutes');
const nutritionRoutes = require('./routes/nutritionRoutes');
const wearableRoutes = require('./routes/wearableRoutes');
const activityRoutes = require('./routes/activityRoutes');
const medicationRoutes = require('./routes/medicationRoutes');
const scoreRoutes = require('./routes/scoreRoutes');
const metricsRoutes = require('./routes/metricsRoutes');
const resourceRoutes = require('./routes/resourceRoutes');
const staffRoutes = require('./routes/staffRoutes');

const app = express();

/**
 * CORS.
 *
 * Open to every origin until the staff web portal existed, which was harmless while the
 * only clients were native: an Expo app sends no `Origin` header and is unaffected by CORS
 * either way. A browser client changes that — an open policy lets any page on the internet
 * make credentialed calls to this API from a signed-in staff member's browser.
 *
 * `WEB_ORIGINS` is a comma-separated allow list. Requests with **no** Origin are permitted:
 * that is the native apps, curl, uptime monitors and server-to-server calls, none of which
 * CORS governs. Only a browser sends Origin, and only a browser is being restricted here.
 *
 * An unset WEB_ORIGINS falls back to localhost so a fresh checkout runs the portal without
 * configuration; production sets it explicitly.
 */
const { buildPolicy, describe: describePolicy } = require('./config/cors');
const corsPolicy = buildPolicy(process.env);

/**
 * Rejections are logged once per origin.
 *
 * A CORS refusal is invisible from the server's side and reaches the browser as "no
 * Access-Control-Allow-Origin header" — which names no cause and points at no fix. Without
 * this line, the only way to learn that a deployment's origin was never added to the allow
 * list is to read this file. Once per origin, because a blocked single-page app retries
 * constantly and would otherwise fill the log with one repeated fact.
 */
const rejectedOrigins = new Set();

app.use(cors({
    origin(origin, callback) {
        if (corsPolicy.isAllowed(origin)) return callback(null, true);

        if (!rejectedOrigins.has(origin)) {
            rejectedOrigins.add(origin);
            console.warn(
                `🚫 CORS refused "${origin}". Add it to WEB_ORIGINS (comma-separated) and ` +
                `redeploy. Currently allowed: ${describePolicy(corsPolicy)}`
            );
        }

        // Not an Error: an error here becomes a 500. A plain refusal omits the CORS headers,
        // which is what the browser is meant to see.
        return callback(null, false);
    },
    credentials: true,
}));
console.log(`🌐 CORS allow list: ${describePolicy(corsPolicy)}`);

/**
 * Stripe webhook — mounted before express.json() on purpose.
 *
 * Signature verification hashes the exact bytes Stripe sent. Once express.json() has parsed
 * and discarded the raw body, the signature can never be verified, and every webhook is
 * rejected. This must stay above the JSON parser.
 */
app.post(
    '/api/payments/webhook',
    express.raw({ type: 'application/json' }),
    require('./controllers/paymentController').handleWebhook
);

app.use(express.json({ limit: '2mb' }));
app.use(require('./middleware/requestLogger'));

connectDB();

// Plan statuses are date-derived, so they must be recomputed daily
require('./jobs/statusSweep').scheduleStatusSweep();
// Reminders run after the status sweep, so urgency is current when they fire
require('./jobs/reminderJob').scheduleReminderJob();
// Prunes superseded, unreviewed interpretation drafts. Never touches a reviewed one.
require('./jobs/retentionSweep').scheduleRetentionSweep();
// Dose reminders run every few minutes, not daily: "take your 8pm tablet" is worthless the
// following morning. Refill nudges ride along on a separate daily timer.
require('./jobs/medicationReminderJob').scheduleMedicationReminders();

app.use('/api/users', userRoutes);
app.use('/api/test-results', testResultRoutes);
app.use('/api/deepseek', deepseekRoutes);
app.use('/api/professionals', professionalRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/images', imageRoutes);
app.use('/api/plans', planRoutes);
app.use('/api/products', productRoutes);
app.use('/api/biomarkers', biomarkerRoutes);
app.use('/api/dna-reports', dnaReportRoutes);
app.use('/api/genotypes', genotypeRoutes);
app.use('/api/plan-items', planItemRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/appointments', appointmentRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/interpretation', interpretationRoutes);
app.use('/api/assistant', assistantRoutes);
app.use('/api/nutrition', nutritionRoutes);
// Device health data. Deliberately not '/api/health' — see the note in wearableRoutes.js.
app.use('/api/wearables', wearableRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/medications', medicationRoutes);
app.use('/api/score', scoreRoutes);
app.use('/api/metrics', metricsRoutes);
app.use('/api/resources', resourceRoutes);
// Who may sign in to the staff portal, and as what. Admin-only throughout.
app.use('/api/staff', staffRoutes);


/**
 * Health check.
 *
 * Unauthenticated on purpose: a load balancer or uptime monitor cannot hold a token. It
 * reports only what an operator needs — no counts, no identifiers, nothing about patients.
 */
app.get('/health', (req, res) => {
    const mongoose = require('mongoose');
    const dbUp = mongoose.connection.readyState === 1;

    res.status(dbUp ? 200 : 503).json({
        status: dbUp ? 'ok' : 'degraded',
        database: dbUp ? 'connected' : 'disconnected',
        services: {
            // Capability flags, so a deploy can be checked without guessing from behaviour
            supabaseAuth: require('./config/supabase').isConfigured(),
            payments: require('./config/stripe').isConfigured(),
            aiInterpretation: Boolean(process.env.ANTHROPIC_API_KEY),
        },
        uptimeSeconds: Math.round(process.uptime()),
        timestamp: new Date().toISOString(),
    });
});

// Must come after every route: the first matches anything unrouted, the second catches
// whatever a handler threw.
const { errorHandler, notFound } = require('./middleware/errorHandler');
app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 5002;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
