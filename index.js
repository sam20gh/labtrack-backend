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
const planItemRoutes = require('./routes/planItemRoutes');
const orderRoutes = require('./routes/orderRoutes');
const appointmentRoutes = require('./routes/appointmentRoutes');
const reportRoutes = require('./routes/reportRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const reviewRoutes = require('./routes/reviewRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const interpretationRoutes = require('./routes/interpretationRoutes');
const assistantRoutes = require('./routes/assistantRoutes');

const app = express();
app.use(cors());

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
app.use('/api/plan-items', planItemRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/appointments', appointmentRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/interpretation', interpretationRoutes);
app.use('/api/assistant', assistantRoutes);


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
