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

const app = express();
app.use(cors());
app.use(express.json());

connectDB();

app.use('/api/users', userRoutes);
app.use('/api/test-results', testResultRoutes);
app.use('/api/deepseek', deepseekRoutes);
app.use('/api/aifeedback', aiFeedbackRoutes);
app.use('/api/professionals', professionalRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/images', imageRoutes);
app.use('/api/plans', planRoutes);
app.use('/api/products', productRoutes);


const PORT = process.env.PORT || 5002;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
