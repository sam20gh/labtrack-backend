/**
 * Request logging.
 *
 * Deliberately minimal and PHI-aware: the path, method, status, and duration — never the
 * body, and never query strings, which in this API carry `user_id`. Logs are retained,
 * shipped, and read by people who should not need access to patient identifiers to debug a
 * 500.
 */
const SLOW_MS = 2000;

const requestLogger = (req, res, next) => {
    const start = Date.now();

    res.on('finish', () => {
        const ms = Date.now() - start;

        // Strip the query string: it carries user ids on several endpoints
        const path = req.originalUrl.split('?')[0];

        // Health checks would otherwise dominate the log
        if (path === '/health') return;

        const marker = res.statusCode >= 500 ? '🔴' : res.statusCode >= 400 ? '🟡' : '⚪';
        const slow = ms > SLOW_MS ? '  ⏱ SLOW' : '';

        console.log(`${marker} ${req.method} ${path} ${res.statusCode} ${ms}ms${slow}`);
    });

    next();
};

module.exports = requestLogger;
