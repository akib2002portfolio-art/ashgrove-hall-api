const router = require('express').Router();
const db = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errors');

router.use(authenticate);

// ── GET /dashboard  (admin stats roll-up) ────────────────────

router.get('/',
  requireRole('admin', 'warden'),
  asyncHandler(async (req, res) => {
    const [rooms, fees, complaints, visitors, recentComplaints] = await Promise.all([
      // Room occupancy
      db.query(`
        SELECT
          COUNT(*) AS total_rooms,
          COUNT(*) FILTER (WHERE status = 'available') AS available,
          COUNT(*) FILTER (WHERE status = 'full')      AS full,
          COUNT(*) FILTER (WHERE status = 'reserved')  AS reserved,
          COUNT(*) FILTER (WHERE status = 'maintenance') AS maintenance,
          SUM(capacity) AS total_beds,
          (SELECT COUNT(*) FROM students WHERE room_id IS NOT NULL) AS occupied_beds
        FROM rooms
      `),
      // Financial snapshot (current month)
      db.query(`
        SELECT
          COALESCE(SUM(amount_paid), 0)                                        AS collected,
          COALESCE(SUM(amount) FILTER (WHERE status IN ('pending','partial')), 0) AS pending,
          COALESCE(SUM(amount - amount_paid) FILTER (WHERE status = 'overdue'), 0) AS overdue,
          COUNT(*) FILTER (WHERE status = 'overdue') AS overdue_count
        FROM invoices
        WHERE DATE_TRUNC('month', created_at) = DATE_TRUNC('month', NOW())
      `),
      // Complaints overview
      db.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE status = 'pending')     AS pending,
          COUNT(*) FILTER (WHERE priority = 'emergency') AS emergency,
          COUNT(*) FILTER (WHERE status = 'resolved')    AS resolved
        FROM complaints
      `),
      // Visitors today
      db.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'in')                       AS in_now,
          COUNT(*) FILTER (WHERE checked_in_at::date = CURRENT_DATE)  AS today
        FROM visitors
      `),
      // 5 most recent complaints
      db.query(`
        SELECT c.id, c.subject, c.category, c.priority, c.status, c.created_at,
               u.full_name AS student_name, r.room_number
        FROM complaints c
        JOIN  users u ON u.id = c.student_id
        LEFT JOIN rooms r ON r.id = c.room_id
        ORDER BY c.created_at DESC
        LIMIT 5
      `),
    ]);

    res.json({
      rooms:             rooms.rows[0],
      fees:              fees.rows[0],
      complaints:        complaints.rows[0],
      visitors:          visitors.rows[0],
      recent_complaints: recentComplaints.rows,
    });
  })
);

module.exports = router;
