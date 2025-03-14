// routes/deepseek.js
const express = require('express');
const router = express.Router();
const OpenAI = require('openai');

// Initialize the OpenAI SDK for DeepSeek.
const openai = new OpenAI({
    baseURL: 'https://api.deepseek.com/v1',
    apiKey: process.env.OPENAI_API_KEY, // ensure your API key is stored in an env variable
});

router.post('/', async (req, res) => {
    try {
        const { user, testResult } = req.body;

        if (!user || !testResult) {
            return res.status(400).json({ error: 'Missing user or testResult data' });
        }

        // Create the prompt text based on the received data.
        const userDataText = `User data: Gender: ${user.gender}, Height: ${user.height} cm, Weight: ${user.weight} kg, DOB: ${user.dob}. Test Result: Type: ${testResult.type}, Result: ${testResult.result}. Please provide a detailed course of action and regular check recommendations.`;

        const messages = [
            {
                role: 'system',
                content: 'You are a health assistant that provides personalized recommendations based on user data and test results.',
            },
            { role: 'user', content: userDataText },
        ];

        const completion = await openai.chat.completions.create({
            messages,
            model: 'deepseek-chat',
        });

        res.json({
            recommendation: completion.choices[0].message.content,
        });
    } catch (error) {
        console.error('DeepSeek API error:', error);
        res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
});

module.exports = router;
