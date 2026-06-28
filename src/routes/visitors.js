const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const db = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errors');

router.use(authenticate);

// ── GET /visitors ────────────────────────────────────────────

router.get('/',
  asyncHandler(async (req, res) => {
    const { status, student_id, page = 1, limit = 30 } = req.query;
    const offset = (page - 1) * limit;
    const params = [];
    const conditions = [];

    if (req.user.role === 'student') {
      conditions.push(`v.student_id = $${params.push(req.user.id)}`);
    } else if (student_id) {
      conditions.push(`v.student_id = $${params.push(student_id)}`);
    }

    if (status) conditions.push(`v.status = $${params.push(status)}::visitor_status`);

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    // Auto-flag overstayed (in for > VISITOR_MAX_HOURS hours)
    const maxHrs = parseInt(process.env.VISITOR_MAX_HOURS || '2', 10);
    const { rows } = await db.query(`
      SELECT v.*,
             u.full_name  AS student_name,
             r.room_number,
             CASE
               WHEN v.status = 'in'
                AND v.checked_in_at < NOW() - INTERVAL '${maxHrs} hours'
               THEN TRUE ELSE FALSE
             END AS is_overstayed
      FROM visitors v
      JOIN  users u ON u.id = v.student_id
      LEFT JOIN rooms r ON r.id = v.room_id
      ${where}
      ORDER BY v.checked_in_at DESC
      LIMIT $${params.push(limit)} OFFSET $${params.push(offset)}
    `, params);

    res.json({ data: rows });
  })
);

// ── POST /visitors  (issue pass) ─────────────────────────────

router.post('/',
  requireRole('admin', 'warden'),
  body('visitor_name').notEmpty(),
  body('student_id').notEmpty(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const {
      visitor_name, visitor_phone, visitor_id_ref,
      student_id, room_id, purpose, notes,
    } = req.body;

    // Auto-generate pass number
    const { rows: [{ next }] } = await db.query(
      "SELECT LPAD((COUNT(*) + 1)::TEXT, 4, '0') AS next FROM visitors"
    );

    const { rows: [visitor] } = await db.query(`
      INSERT INTO visitors
        (visitor_name, visitor_phone, visitor_id_ref, student_id, room_id, purpose, notes, issued_by, pass_no)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [
      visitor_name, visitor_phone || null, visitor_id_ref || null,
      student_id, room_id || null, purpose || null,
      notes || null, req.user.id, `VP-${next}`,
    ]);

    res.status(201).json(visitor);
  })
);

// ── PATCH /visitors/:id/checkout ─────────────────────────────

router.patch('/:id/checkout',
  requireRole('admin', 'warden'),
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(`
      UPDATE visitors
      SET status = 'out'::visitor_status, checked_out_at = NOW()
      WHERE id = $1 AND status = 'in'
      RETURNING *
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Visitor not found or already checked out' });
    res.json(rows[0]);
  })
);

// ── GET /visitors/stats ───────────────────────────────────────

router.get('/stats',
  requireRole('admin', 'warden'),
  asyncHandler(async (req, res) => {
    const maxHrs = parseInt(process.env.VISITOR_MAX_HOURS || '2', 10);
    const { rows: [stats] } = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'in')                            AS checked_in_now,
        COUNT(*) FILTER (WHERE checked_in_at::date = CURRENT_DATE)       AS today_total,
        COUNT(*) FILTER (
          WHERE status = 'in'
            AND checked_in_at < NOW() - INTERVAL '${maxHrs} hours'
        )                                                                 AS overstayed,
        ROUND(
          AVG(EXTRACT(EPOCH FROM (COALESCE(checked_out_at, NOW()) - checked_in_at)) / 60)
          FILTER (WHERE checked_in_at::date = CURRENT_DATE)
        )                                                                 AS avg_minutes_today
      FROM visitors
    `);
    res.json(stats);
  })
);

module.exports = router;
