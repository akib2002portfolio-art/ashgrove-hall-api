/**
 * Wraps async route handlers so unhandled promise rejections
 * are forwarded to Express's error handler automatically.
 */
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Central error handler — mount LAST in Express chain.
 */
function errorHandler(err, req, res, _next) {
  // Postgres unique-violation
  if (err.code === '23505') {
    return res.status(409).json({ error: 'Duplicate value', detail: err.detail });
  }
  // Postgres FK violation
  if (err.code === '23503') {
    return res.status(400).json({ error: 'Referenced record does not exist', detail: err.detail });
  }
  // Validation errors from express-validator are handled in routes;
  // this catches anything that slips through.
  const status = err.status || err.statusCode || 500;
  const message = status < 500 ? err.message : 'Internal server error';
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({ error: message });
}

module.exports = { asyncHandler, errorHandler };
