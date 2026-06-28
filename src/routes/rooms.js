const router = require('express').Router();
const { body, param, query: vQuery, validationResult } = require('express-validator');
const db = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errors');

// All room routes require a valid session
router.use(authenticate);

// ── GET /rooms ───────────────────────────────────────────────
// Query params: status, block, floor, page, limit

router.get('/',
  asyncHandler(async (req, res) => {
    const { status, block, floor, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;
    const conditions = [];
    const params = [];

    if (status) { conditions.push(`r.status = $${params.push(status)}::room_status`); }
    if (block)  { conditions.push(`r.block  = $${params.push(block)}`); }
    if (floor)  { conditions.push(`r.floor  = $${params.push(floor)}`); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const { rows } = await db.query(`
      SELECT r.*,
             COUNT(b.id)                                              AS total_beds,
             COUNT(b.id) FILTER (WHERE b.status = 'vacant')          AS vacant_beds,
             COUNT(s.id)                                              AS occupant_count
      FROM rooms r
      LEFT JOIN beds     b ON b.room_id = r.id
      LEFT JOIN students s ON s.room_id = r.id
      ${where}
      GROUP BY r.id
      ORDER BY r.block, r.room_number
      LIMIT $${params.push(limit)} OFFSET $${params.push(offset)}
    `, params);

    const { rows: [{ total }] } = await db.query(
      `SELECT COUNT(*) AS total FROM rooms r ${where}`,
      params.slice(0, conditions.length)
    );

    res.json({ data: rows, total: Number(total), page: Number(page), limit: Number(limit) });
  })
);

// ── GET /rooms/:id ───────────────────────────────────────────

router.get('/:id',
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(`
      SELECT r.*,
             json_agg(json_build_object(
               'id',    b.id,
               'label', b.bed_label,
               'status',b.status,
               'student', (
                 SELECT json_build_object('id', u.id, 'full_name', u.full_name, 'student_id', s2.student_id)
                 FROM students s2 JOIN users u ON u.id = s2.id
                 WHERE s2.bed_id = b.id
               )
             ) ORDER BY b.bed_label) AS beds
      FROM rooms r
      LEFT JOIN beds b ON b.room_id = r.id
      WHERE r.id = $1
      GROUP BY r.id
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Room not found' });
    res.json(rows[0]);
  })
);

// ── POST /rooms  (admin only) ────────────────────────────────

router.post('/',
  requireRole('admin', 'warden'),
  body('room_number').notEmpty(),
  body('capacity').isInt({ min: 1, max: 8 }),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { room_number, floor, block, capacity, status = 'available', notes } = req.body;
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      const { rows: [room] } = await client.query(`
        INSERT INTO rooms (room_number, floor, block, capacity, status, notes)
        VALUES ($1, $2, $3, $4, $5::room_status, $6)
        RETURNING *
      `, [room_number, floor, block, capacity, status, notes]);

      // Auto-create beds A, B, C …
      const labels = Array.from({ length: capacity }, (_, i) => String.fromCharCode(65 + i));
      for (const label of labels) {
        await client.query(
          'INSERT INTO beds (room_id, bed_label) VALUES ($1, $2)',
          [room.id, label]
        );
      }
      await client.query('COMMIT');
      res.status(201).json(room);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  })
);

// ── PATCH /rooms/:id  (admin only) ──────────────────────────

router.patch('/:id',
  requireRole('admin', 'warden'),
  asyncHandler(async (req, res) => {
    const allowed = ['floor', 'block', 'status', 'notes'];
    const updates = Object.entries(req.body)
      .filter(([k]) => allowed.includes(k));

    if (!updates.length) return res.status(400).json({ error: 'No valid fields to update' });

    const sets   = updates.map(([k], i) => `${k} = $${i + 2}`).join(', ');
    const values = updates.map(([, v]) => v);

    const { rows } = await db.query(
      `UPDATE rooms SET ${sets} WHERE id = $1 RETURNING *`,
      [req.params.id, ...values]
    );
    if (!rows.length) return res.status(404).json({ error: 'Room not found' });
    res.json(rows[0]);
  })
);

// ── DELETE /rooms/:id  (admin only) ─────────────────────────

router.delete('/:id',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { rowCount } = await db.query(
      'DELETE FROM rooms WHERE id = $1',
      [req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Room not found' });
    res.status(204).end();
  })
);

module.exports = router;
