const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const db = require('../db');
const { authenticate, requireRole, ownOrAdmin } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errors');

router.use(authenticate);

// ── GET /students ────────────────────────────────────────────
// Admin/warden: list all. Student: redirect to /students/me.

router.get('/',
  requireRole('admin', 'warden'),
  asyncHandler(async (req, res) => {
    const { search, room, page = 1, limit = 30 } = req.query;
    const offset = (page - 1) * limit;
    const params = [];
    const conditions = [];

    if (search) {
      conditions.push(`(u.full_name ILIKE $${params.push('%' + search + '%')} OR s.student_id ILIKE $${params.push('%' + search + '%')})`);
    }
    if (room) {
      conditions.push(`r.room_number = $${params.push(room)}`);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const { rows } = await db.query(`
      SELECT u.id, u.email, u.full_name, u.phone, u.is_active,
             s.student_id, s.department, s.year_of_study, s.check_in_date,
             r.room_number, r.block, r.floor,
             b.bed_label
      FROM users u
      JOIN students s ON s.id = u.id
      LEFT JOIN rooms r ON r.id = s.room_id
      LEFT JOIN beds  b ON b.id = s.bed_id
      ${where}
      ORDER BY u.full_name
      LIMIT $${params.push(limit)} OFFSET $${params.push(offset)}
    `, params);

    const { rows: [{ total }] } = await db.query(
      `SELECT COUNT(*) AS total FROM users u JOIN students s ON s.id = u.id LEFT JOIN rooms r ON r.id = s.room_id ${where}`,
      params.slice(0, conditions.length)
    );

    res.json({ data: rows, total: Number(total), page: Number(page), limit: Number(limit) });
  })
);

// ── GET /students/:id ────────────────────────────────────────

router.get('/:id',
  ownOrAdmin,
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(`
      SELECT u.id, u.email, u.full_name, u.phone, u.photo_url,
             s.student_id, s.department, s.year_of_study, s.check_in_date, s.check_out_date,
             s.emergency_name, s.emergency_phone,
             r.id AS room_id, r.room_number, r.block, r.floor,
             b.id AS bed_id, b.bed_label
      FROM users u
      JOIN students s ON s.id = u.id
      LEFT JOIN rooms r ON r.id = s.room_id
      LEFT JOIN beds  b ON b.id = s.bed_id
      WHERE u.id = $1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Student not found' });
    res.json(rows[0]);
  })
);

// ── POST /students  (admin: create new student account) ──────

router.post('/',
  requireRole('admin', 'warden'),
  body('email').isEmail().normalizeEmail(),
  body('full_name').notEmpty(),
  body('student_id').notEmpty(),
  body('password').isLength({ min: 8 }),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const {
      email, full_name, student_id, password, phone,
      department, year_of_study, emergency_name, emergency_phone,
    } = req.body;

    const hash = await bcrypt.hash(password, 12);
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      const { rows: [user] } = await client.query(`
        INSERT INTO users (email, password_hash, full_name, role, phone)
        VALUES ($1, $2, $3, 'student', $4)
        RETURNING id, email, full_name, role
      `, [email, hash, full_name, phone]);

      await client.query(`
        INSERT INTO students (id, student_id, department, year_of_study, emergency_name, emergency_phone)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [user.id, student_id, department, year_of_study, emergency_name, emergency_phone]);

      await client.query('COMMIT');
      res.status(201).json({ ...user, student_id });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  })
);

// ── PATCH /students/:id/assign-room  (admin: assign/move room) ──

router.patch('/:id/assign-room',
  requireRole('admin', 'warden'),
  body('room_id').notEmpty(),
  body('bed_id').notEmpty(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { room_id, bed_id, check_in_date } = req.body;
    const student_id = req.params.id;

    // Verify bed belongs to room and is vacant
    const { rows: [bed] } = await db.query(
      'SELECT id, status FROM beds WHERE id = $1 AND room_id = $2',
      [bed_id, room_id]
    );
    if (!bed) return res.status(400).json({ error: 'Bed does not belong to that room' });
    if (bed.status !== 'vacant') return res.status(409).json({ error: 'Bed is not vacant' });

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      // Free previous bed if any
      const { rows: [prev] } = await client.query(
        'SELECT bed_id FROM students WHERE id = $1', [student_id]
      );
      if (prev?.bed_id) {
        await client.query(
          "UPDATE beds SET status = 'vacant' WHERE id = $1",
          [prev.bed_id]
        );
      }

      // Assign new bed
      await client.query(
        "UPDATE beds SET status = 'occupied' WHERE id = $1",
        [bed_id]
      );

      const { rows: [student] } = await client.query(`
        UPDATE students SET room_id = $1, bed_id = $2, check_in_date = COALESCE($3, check_in_date)
        WHERE id = $4
        RETURNING *
      `, [room_id, bed_id, check_in_date, student_id]);

      // Update room status if now full
      await client.query(`
        UPDATE rooms
        SET status = CASE
          WHEN (SELECT COUNT(*) FROM beds WHERE room_id = $1 AND status = 'vacant') = 0
          THEN 'full'::room_status ELSE 'available'::room_status END
        WHERE id = $1
      `, [room_id]);

      await client.query('COMMIT');
      res.json(student);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  })
);

// ── PATCH /students/:id  (update profile) ───────────────────

router.patch('/:id',
  ownOrAdmin,
  asyncHandler(async (req, res) => {
    const userFields    = ['full_name', 'phone', 'photo_url'];
    const studentFields = ['department', 'year_of_study', 'emergency_name', 'emergency_phone'];

    const uUpdates = Object.entries(req.body).filter(([k]) => userFields.includes(k));
    const sUpdates = Object.entries(req.body).filter(([k]) => studentFields.includes(k));

    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      if (uUpdates.length) {
        const sets   = uUpdates.map(([k], i) => `${k} = $${i + 2}`).join(', ');
        await client.query(
          `UPDATE users SET ${sets} WHERE id = $1`,
          [req.params.id, ...uUpdates.map(([,v]) => v)]
        );
      }
      if (sUpdates.length) {
        const sets   = sUpdates.map(([k], i) => `${k} = $${i + 2}`).join(', ');
        await client.query(
          `UPDATE students SET ${sets} WHERE id = $1`,
          [req.params.id, ...sUpdates.map(([,v]) => v)]
        );
      }
      await client.query('COMMIT');
      res.json({ message: 'Updated' });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  })
);

module.exports = router;
