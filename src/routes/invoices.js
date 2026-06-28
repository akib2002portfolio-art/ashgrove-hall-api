const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const db = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errors');

router.use(authenticate);

// ── GET /invoices ────────────────────────────────────────────

router.get('/',
  asyncHandler(async (req, res) => {
    const { status, student_id, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;
    const params = [];
    const conditions = [];

    if (req.user.role === 'student') {
      conditions.push(`i.student_id = $${params.push(req.user.id)}`);
    } else if (student_id) {
      conditions.push(`i.student_id = $${params.push(student_id)}`);
    }

    if (status) conditions.push(`i.status = $${params.push(status)}::fee_status`);

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const { rows } = await db.query(`
      SELECT i.*,
             u.full_name AS student_name,
             r.room_number
      FROM invoices i
      JOIN  users u ON u.id = i.student_id
      LEFT JOIN rooms r ON r.id = i.room_id
      ${where}
      ORDER BY i.due_date ASC, i.created_at DESC
      LIMIT $${params.push(limit)} OFFSET $${params.push(offset)}
    `, params);

    res.json({ data: rows });
  })
);

// ── GET /invoices/summary  (dashboard stats) ──────────────────

router.get('/summary',
  requireRole('admin', 'warden'),
  asyncHandler(async (req, res) => {
    const { rows: [stats] } = await db.query(`
      SELECT
        SUM(amount_paid)                                                   AS collected,
        SUM(amount) FILTER (WHERE status IN ('pending','partial'))         AS pending_total,
        COUNT(*)    FILTER (WHERE status IN ('pending','partial'))         AS pending_count,
        SUM(amount - amount_paid) FILTER (WHERE status = 'overdue')       AS overdue_total,
        COUNT(*)    FILTER (WHERE status = 'overdue')                     AS overdue_count
      FROM invoices
      WHERE DATE_TRUNC('month', created_at) = DATE_TRUNC('month', NOW())
    `);
    res.json(stats);
  })
);

// ── GET /invoices/:id ────────────────────────────────────────

router.get('/:id',
  asyncHandler(async (req, res) => {
    const { rows: [inv] } = await db.query(`
      SELECT i.*, u.full_name AS student_name, r.room_number
      FROM invoices i
      JOIN  users u ON u.id = i.student_id
      LEFT JOIN rooms r ON r.id = i.room_id
      WHERE i.id = $1
    `, [req.params.id]);

    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    if (req.user.role === 'student' && inv.student_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { rows: payments } = await db.query(
      `SELECT p.*, u.full_name AS recorded_by_name
       FROM payments p JOIN users u ON u.id = p.recorded_by
       WHERE p.invoice_id = $1 ORDER BY p.paid_at DESC`,
      [req.params.id]
    );

    res.json({ ...inv, payments });
  })
);

// ── POST /invoices  (admin only) ─────────────────────────────

router.post('/',
  requireRole('admin', 'warden'),
  body('student_id').notEmpty(),
  body('fee_type').notEmpty(),
  body('amount').isFloat({ min: 0.01 }),
  body('due_date').isISO8601(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { student_id, room_id, fee_type, amount, due_date, notes } = req.body;

    // Auto-generate invoice number
    const { rows: [{ next }] } = await db.query(
      "SELECT LPAD((COUNT(*) + 1043)::TEXT, 4, '0') AS next FROM invoices"
    );

    const { rows: [inv] } = await db.query(`
      INSERT INTO invoices (invoice_no, student_id, room_id, fee_type, amount, due_date, notes, created_by)
      VALUES ($1, $2, $3, $4::fee_type, $5, $6, $7, $8)
      RETURNING *
    `, [`INV-${next}`, student_id, room_id || null, fee_type, amount, due_date, notes || null, req.user.id]);

    res.status(201).json(inv);
  })
);

// ── POST /invoices/:id/payments  (record a payment) ─────────

router.post('/:id/payments',
  requireRole('admin', 'warden'),
  body('amount').isFloat({ min: 0.01 }),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { amount, method = 'manual', reference } = req.body;
    const client = await db.getClient();

    try {
      await client.query('BEGIN');

      const { rows: [inv] } = await client.query(
        'SELECT * FROM invoices WHERE id = $1 FOR UPDATE',
        [req.params.id]
      );
      if (!inv) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Invoice not found' }); }

      const { rows: [payment] } = await client.query(`
        INSERT INTO payments (invoice_id, amount, method, reference, recorded_by)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `, [req.params.id, amount, method, reference || null, req.user.id]);

      const newPaid   = Number(inv.amount_paid) + Number(amount);
      const newStatus = newPaid >= Number(inv.amount)
        ? 'paid'
        : newPaid > 0 ? 'partial' : inv.status;

      await client.query(
        'UPDATE invoices SET amount_paid = $1, status = $2::fee_status WHERE id = $3',
        [newPaid, newStatus, req.params.id]
      );

      await client.query('COMMIT');
      res.status(201).json({ payment, new_status: newStatus, amount_paid: newPaid });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  })
);

// ── POST /invoices/overdue-sweep  (mark overdue, run via cron) ─

router.post('/overdue-sweep',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { rowCount } = await db.query(`
      UPDATE invoices
      SET status = 'overdue'::fee_status
      WHERE status IN ('pending', 'partial')
        AND due_date < CURRENT_DATE
    `);
    res.json({ marked_overdue: rowCount });
  })
);

module.exports = router;
