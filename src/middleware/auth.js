const jwt  = require('jsonwebtoken');
const { query } = require('../db');

/**
 * Verify the Bearer token in Authorization header.
 * Attaches `req.user = { id, email, role }` on success.
 */
async function authenticate(req, res, next) {
  const header = req.headers['authorization'];
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    // Optionally confirm user still active in DB (lightweight check)
    const { rows } = await query(
      'SELECT id, email, role, is_active FROM users WHERE id = $1',
      [payload.sub]
    );
    if (!rows.length || !rows[0].is_active) {
      return res.status(401).json({ error: 'User not found or deactivated' });
    }
    req.user = rows[0];
    next();
  } catch (err) {
    const msg = err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token';
    return res.status(401).json({ error: msg });
  }
}

/**
 * Factory: require specific role(s).
 * Usage: requireRole('admin')  or  requireRole('admin', 'warden')
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: `Requires role: ${roles.join(' or ')}` });
    }
    next();
  };
}

/**
 * Students may only access their own resources.
 * Compares req.params.studentId or req.params.userId against req.user.id.
 */
function ownOrAdmin(req, res, next) {
  if (req.user.role === 'admin' || req.user.role === 'warden') return next();
  const target = req.params.studentId || req.params.userId || req.params.id;
  if (target && target !== req.user.id) {
    return res.status(403).json({ error: 'Access denied' });
  }
  next();
}

module.exports = { authenticate, requireRole, ownOrAdmin };
