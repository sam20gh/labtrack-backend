/**
 * Global error handler.
 *
 * Until now an unhandled throw in a controller produced Express's default HTML error page —
 * complete with a stack trace, to a mobile client expecting JSON. This turns every failure
 * into a predictable JSON shape and keeps internals out of the response in production.
 */

/** 404 for anything that reached no route. */
const notFound = (req, res) => {
    res.status(404).json({
        message: `No route for ${req.method} ${req.originalUrl.split('?')[0]}`,
    });
};

const errorHandler = (err, req, res, next) => {
    if (res.headersSent) return next(err);

    // Mongoose failures have meaningful shapes worth translating
    if (err.name === 'ValidationError') {
        return res.status(400).json({
            message: 'Validation failed',
            errors: Object.fromEntries(
                Object.entries(err.errors || {}).map(([k, v]) => [k, v.message])
            ),
        });
    }

    if (err.name === 'CastError') {
        return res.status(400).json({ message: `Invalid ${err.path}: ${err.value}` });
    }

    if (err.code === 11000) {
        const field = Object.keys(err.keyPattern || {})[0] || 'value';
        return res.status(409).json({ message: `That ${field} is already in use` });
    }

    if (err.type === 'entity.too.large') {
        return res.status(413).json({ message: 'Request body is too large' });
    }

    const status = err.status || err.statusCode || 500;

    console.error(`❌ ${req.method} ${req.originalUrl.split('?')[0]} →`, err.message);
    if (status >= 500) console.error(err.stack);

    res.status(status).json({
        message: status >= 500 ? 'Something went wrong on our side' : err.message,
        // A stack trace helps in development and leaks structure in production
        ...(process.env.NODE_ENV !== 'production' && status >= 500 ? { detail: err.message } : {}),
    });
};

module.exports = { errorHandler, notFound };
