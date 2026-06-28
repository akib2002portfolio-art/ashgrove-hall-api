const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const db = require('../db');
const { authenticate, requireRole, ownOrAdmin } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errors');

router.use(authenticate);

// ── GET /complaints ──────────────────────────────────────────

router.get('/',
  asyncHandler(async (req, res) => {
    const { status, priority, page = 1, limit = 30 } = req.query;
    const offset = (page - 1) * limit;
    const params = [];
    const conditions = [];

    // Students only see their own
    if (req.user.role === 'student') {
      conditions.push(`c.student_id = $${params.push(req.user.id)}`);
    }
    if (status)   conditions.push(`c.status   = $${params.push(status)}::complaint_stat`);
    if (priority) conditions.push(`c.priority = $${params.push(priority)}::complaint_prio`);

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const { rows } = await db.query(`
      SELECT c.*,
             u.full_name  AS student_name,
             r.room_number,
             a.full_name  AS assigned_to_name
      FROM complaints c
      JOIN  users u ON u.id = c.student_id
      LEFT JOIN rooms r ON r.id = c.room_id
      LEFT JOIN users a ON a.id = c.assigned_to_id
      ${where}
      ORDER BY
        CASE c.priority
          WHEN 'emergency' THEN 1
          WHEN 'high'      THEN 2
          WHEN 'medium'    THEN 3
          ELSE 4
        END,
        c.created_at DESC
      LIMIT $${params.push(limit)} OFFSET $${params.push(offset)}
    `, params);

    res.json({ data: rows });
  })
);

// ── GET /complaints/:id ──────────────────────────────────────

router.get('/:id',
  asyncHandler(async (req, res) => {
    const { rows: [complaint] } = await db.query(`
      SELECT c.*,
             u.full_name AS student_name, r.room_number,
             a.full_name AS assigned_to_name
      FROM complaints c
      JOIN  users u ON u.id = c.student_id
      LEFT JOIN rooms r ON r.id = c.room_id
      LEFT JOIN users a ON a.id = c.assigned_to_id
      WHERE c.id = $1
    `, [req.params.id]);

    if (!complaint) return res.status(404).json({ error: 'Complaint not found' });

    // Students can't view others' complaints
    if (req.user.role === 'student' && complaint.student_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Attach comments
    const { rows: comments } = await db.query(`
      SELECT cc.*, u.full_name AS author_name, u.role AS author_role
      FROM complaint_comments cc
      JOIN users u ON u.id = cc.author_id
      WHERE cc.complaint_id = $1
      ORDER BY cc.created_at
    `, [req.params.id]);

    res.json({ ...complaint, comments });
  })
);

// ── POST /complaints ─────────────────────────────────────────

router.post('/',
  body('category').notEmpty(),
  body('subject').notEmpty(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { category, subject, description, priority = 'low', room_id } = req.body;

    // Students file for themselves; admins can file on behalf
    const student_id = req.user.role === 'student'
      ? req.user.id
      : (req.body.student_id || req.user.id);

    const { rows: [complaint] } = await db.query(`
      INSERT INTO complaints (student_id, room_id, category, subject, description, priority)
      VALUES ($1, $2, $3, $4, $5, $6::complaint_prio)
      RETURNING *
    `, [student_id, room_id || null, category, subject, description || null, priority]);

    res.status(201).json(complaint);
  })
);

// ── PATCH /complaints/:id  (status / assignment) ─────────────

router.patch('/:id',
  asyncHandler(async (req, res) => {
    const isAdmin = ['admin', 'warden'].includes(req.user.role);
    const allowed = isAdmin
      ? ['status', 'priority', 'assigned_to_id', 'description']
      : ['description'];

    const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k));
    if (!updates.length) return res.status(400).json({ error: 'No valid fields' });

    const extra = [];
    if (req.body.status === 'resolved') {
      extra.push(`resolved_at = NOW()`);
    }

    const sets   = [...updates.map(([k], i) => `${k} = $${i + 2}`), ...extra].join(', ');
    const { rows } = await db.query(
      `UPDATE complaints SET ${sets} WHERE id = $1 RETURNING *`,
      [req.params.id, ...updates.map(([,v]) => v)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Complaint not found' });
    res.json(rows[0]);
  })
);

// ── POST /complaints/:id/comments ────────────────────────────

router.post('/:id/comments',
  body('body').notEmpty(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { rows: [comment] } = await db.query(`
      INSERT INTO complaint_comments (complaint_id, author_id, body)
      VALUES ($1, $2, $3)
      RETURNING *
    `, [req.params.id, req.user.id, req.body.body]);

    res.status(201).json(comment);
  })
);

module.exports = router;
