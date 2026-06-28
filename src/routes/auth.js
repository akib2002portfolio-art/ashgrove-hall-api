const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const { body, validationResult } = require('express-validator');
const { query } = require('../db');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errors');

// ── Helpers ──────────────────────────────────────────────────

function signAccess(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

function signRefresh(user) {
  return jwt.sign(
    { sub: user.id },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d' }
  );
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ── POST /auth/login ─────────────────────────────────────────

router.post('/login',
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { email, password } = req.body;
    const { rows } = await query(
      'SELECT id, email, password_hash, full_name, role, is_active FROM users WHERE email = $1',
      [email]
    );

    const user = rows[0];
    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const accessToken  = signAccess(user);
    const refreshToken = signRefresh(user);
    const hash         = hashToken(refreshToken);
    const expiresAt    = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    await query(
      'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [user.id, hash, expiresAt]
    );

    res.json({
      access_token:  accessToken,
      refresh_token: refreshToken,
      user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role },
    });
  })
);

// ── POST /auth/refresh ───────────────────────────────────────

router.post('/refresh',
  body('refresh_token').notEmpty(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { refresh_token } = req.body;
    let payload;
    try {
      payload = jwt.verify(refresh_token, process.env.JWT_REFRESH_SECRET);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    const hash = hashToken(refresh_token);
    const { rows } = await query(
      `SELECT rt.id, u.id AS user_id, u.email, u.role, u.full_name, u.is_active
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = $1 AND rt.revoked_at IS NULL AND rt.expires_at > NOW()`,
      [hash]
    );

    if (!rows.length || !rows[0].is_active) {
      return res.status(401).json({ error: 'Refresh token not found or revoked' });
    }

    const row = rows[0];
    // Rotate: revoke old, issue new
    await query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1', [row.id]);

    const user         = { id: row.user_id, email: row.email, role: row.role, full_name: row.full_name };
    const accessToken  = signAccess(user);
    const newRefresh   = signRefresh(user);
    const newHash      = hashToken(newRefresh);
    const expiresAt    = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await query(
      'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [user.id, newHash, expiresAt]
    );

    res.json({ access_token: accessToken, refresh_token: newRefresh });
  })
);

// ── POST /auth/logout ────────────────────────────────────────

router.post('/logout',
  authenticate,
  asyncHandler(async (req, res) => {
    const { refresh_token } = req.body;
    if (refresh_token) {
      const hash = hashToken(refresh_token);
      await query(
        'UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1',
        [hash]
      );
    }
    res.json({ message: 'Logged out' });
  })
);

// ── GET /auth/me ─────────────────────────────────────────────

router.get('/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT u.id, u.email, u.full_name, u.role, u.phone, u.photo_url,
              s.student_id, s.room_id, s.department, s.year_of_study,
              r.room_number, r.floor, r.block
       FROM users u
       LEFT JOIN students s ON s.id = u.id
       LEFT JOIN rooms    r ON r.id = s.room_id
       WHERE u.id = $1`,
      [req.user.id]
    );
    res.json(rows[0]);
  })
);

module.exports = router;
