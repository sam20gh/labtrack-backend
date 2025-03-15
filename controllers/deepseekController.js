const OpenAI = require('openai');

const openai = new OpenAI({
    baseURL: 'https://api.deepseek.com/v1',
    apiKey: process.env.OPENAI_API_KEY,
});

exports.handleDeepSeekRequest = async (req, res) => {
    try {
        const { user, testResult } = req.body;

        if (!user || !testResult) {
            return res.status(400).json({ error: 'Missing user or test result data' });
        }

        // Construct user data text for AI model
        const userDataText = `User data: Gender: ${user.gender}, Height: ${user.height} cm, Weight: ${user.weight} kg, DOB: ${user.dob}. Test Result: Type: ${testResult.type}, Result: ${testResult.result}. Please provide a detailed course of action and regular check recommendations.`;

        const messages = [
            {
                role: 'system',
                content: 'You are a health assistant that provides personalized recommendations based on user data and test results.',
            },
            { role: 'user', content: userDataText },
        ];

        // Make a request to DeepSeek (OpenAI API)
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
};
