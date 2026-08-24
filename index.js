require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');
const userRoutes = require('./routes/userRoutes');
const testResultRoutes = require('./routes/testResultRoutes');
const deepseekRoutes = require('./routes/deepseekRoutes');
const aiFeedbackRoutes = require('./routes/aifeedback');
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
const interpretationRoutes = require('./routes/interpretationRoutes');

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

app.use(express.json());

connectDB();

// Plan statuses are date-derived, so they must be recomputed daily
require('./jobs/statusSweep').scheduleStatusSweep();

app.use('/api/users', userRoutes);
app.use('/api/test-results', testResultRoutes);
app.use('/api/deepseek', deepseekRoutes);
app.use('/api/aifeedback', aiFeedbackRoutes);
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
app.use('/api/interpretation', interpretationRoutes);


const PORT = process.env.PORT || 5002;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
