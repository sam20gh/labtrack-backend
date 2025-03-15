require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');
const userRoutes = require('./routes/userRoutes');
const testResultRoutes = require('./routes/testResultRoutes');
const deepseekRoutes = require('./routes/deepseekRoutes');


const app = express();
app.use(cors());
app.use(express.json());

connectDB();

app.use('/api/users', userRoutes);
app.use('/api/test-results', testResultRoutes);
app.use('/api/deepseek', deepseekRoutes);



const PORT = process.env.PORT || 5002;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
