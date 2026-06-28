const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const db = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errors');

router.use(authenticate);

// ── GET /notices ─────────────────────────────────────────────

router.get('/',
  asyncHandler(async (req, res) => {
    const { category, pinned, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    const params = [];
    const conditions = ['(n.expires_at IS NULL OR n.expires_at > NOW())'];

    if (category) conditions.push(`n.category = $${params.push(category)}::notice_cat`);
    if (pinned === 'true') conditions.push('n.is_pinned = TRUE');

    const where = 'WHERE ' + conditions.join(' AND ');

    const { rows } = await db.query(`
      SELECT n.*, u.full_name AS author_name
      FROM notices n
      JOIN users u ON u.id = n.author_id
      ${where}
      ORDER BY n.is_pinned DESC, n.published_at DESC
      LIMIT $${params.push(limit)} OFFSET $${params.push(offset)}
    `, params);

    res.json({ data: rows });
  })
);

// ── POST /notices  (admin/warden only) ───────────────────────

router.post('/',
  requireRole('admin', 'warden'),
  body('title').notEmpty().trim(),
  body('body').notEmpty().trim(),
  body('category').isIn(['General','Emergency','Maintenance','Holiday','Dining','Exam']),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { title, body: bodyText, category, is_pinned = false, expires_at } = req.body;
    const { rows: [notice] } = await db.query(`
      INSERT INTO notices (title, body, category, is_pinned, author_id, expires_at)
      VALUES ($1, $2, $3::notice_cat, $4, $5, $6)
      RETURNING *
    `, [title, bodyText, category, is_pinned, req.user.id, expires_at || null]);

    res.status(201).json(notice);
  })
);

// ── PATCH /notices/:id ───────────────────────────────────────

router.patch('/:id',
  requireRole('admin', 'warden'),
  asyncHandler(async (req, res) => {
    const allowed = ['title', 'body', 'category', 'is_pinned', 'expires_at'];
    const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k));
    if (!updates.length) return res.status(400).json({ error: 'No valid fields' });

    const sets   = updates.map(([k], i) => `${k} = $${i + 2}`).join(', ');
    const { rows } = await db.query(
      `UPDATE notices SET ${sets} WHERE id = $1 RETURNING *`,
      [req.params.id, ...updates.map(([,v]) => v)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Notice not found' });
    res.json(rows[0]);
  })
);

// ── DELETE /notices/:id ──────────────────────────────────────

router.delete('/:id',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { rowCount } = await db.query(
      'DELETE FROM notices WHERE id = $1', [req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Notice not found' });
    res.status(204).end();
  })
);

module.exports = router;
