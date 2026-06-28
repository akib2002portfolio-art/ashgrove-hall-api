#!/usr/bin/env node
/**
 * Seed the database with realistic sample data matching the UI mockup.
 * Usage: npm run db:seed
 *
 * WARNING: drops and re-inserts all seed rows — development only.
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { query, pool } = require('./index');

async function seed() {
  console.log('[seed] Hashing passwords …');
  const adminHash   = await bcrypt.hash('admin123',   12);
  const studentHash = await bcrypt.hash('student123', 12);

  // ── Users ────────────────────────────────────────────────
  console.log('[seed] Inserting users …');
  const { rows: users } = await query(`
    INSERT INTO users (email, password_hash, full_name, role, phone) VALUES
      ('admin@ashgrove.edu',   $1, 'Hall Admin',    'admin',   '+1-555-0100'),
      ('mehrin@ashgrove.edu',  $2, 'Mehrin Haque',  'student', '+1-555-0201'),
      ('rafiul@ashgrove.edu',  $2, 'Rafiul Mahin',  'student', '+1-555-0202'),
      ('sara@ashgrove.edu',    $2, 'Sara Ahmed',    'student', '+1-555-0203'),
      ('tanvir@ashgrove.edu',  $2, 'Tanvir Khan',   'student', '+1-555-0204'),
      ('nadia@ashgrove.edu',   $2, 'Nadia Jahan',   'student', '+1-555-0205'),
      ('omar@ashgrove.edu',    $2, 'Omar Hossain',  'student', '+1-555-0206')
    ON CONFLICT (email) DO NOTHING
    RETURNING id, email, role
  `, [adminHash, studentHash]);
  console.log(`  inserted ${users.length} user(s)`);

  // ── Rooms ────────────────────────────────────────────────
  console.log('[seed] Inserting rooms …');
  const rooms = [
    ['A-101', 'Ground Floor', 'A', 2, 'available'],
    ['A-102', 'Ground Floor', 'A', 3, 'available'],
    ['A-115', 'Ground Floor', 'A', 2, 'full'],
    ['A-204', '2nd Floor',    'A', 2, 'full'],
    ['A-310', '3rd Floor',    'A', 2, 'full'],
    ['B-101', 'Ground Floor', 'B', 2, 'available'],
    ['B-112', 'Ground Floor', 'B', 3, 'full'],
    ['B-208', '2nd Floor',    'B', 2, 'full'],
    ['C-301', '3rd Floor',    'C', 4, 'maintenance'],
    ['C-302', '3rd Floor',    'C', 2, 'reserved'],
  ];
  const { rows: insertedRooms } = await query(`
    INSERT INTO rooms (room_number, floor, block, capacity, status)
    SELECT r.room_number, r.floor, r.block, r.capacity, r.status::room_status
    FROM jsonb_to_recordset($1::jsonb)
      AS r(room_number text, floor text, block text, capacity int, status text)
    ON CONFLICT (room_number) DO NOTHING
    RETURNING id, room_number
  `, [JSON.stringify(rooms.map(([room_number, floor, block, capacity, status]) =>
      ({ room_number, floor, block, capacity, status })))]);
  console.log(`  inserted ${insertedRooms.length} room(s)`);

  // Helper to look up IDs by value
  const byEmail  = (e) => users.find(u => u.email === e)?.id;
  const byRoom   = (n) => insertedRooms.find(r => r.room_number === n)?.id;

  // ── Beds ─────────────────────────────────────────────────
  // Only seed beds for rooms we inserted in this run
  if (insertedRooms.length) {
    console.log('[seed] Inserting beds …');
    const bedRows = insertedRooms.flatMap(r => {
      const cap = rooms.find(x => x[0] === r.room_number)?.[3] ?? 2;
      return Array.from({ length: cap }, (_, i) => ({
        room_id:   r.id,
        bed_label: String.fromCharCode(65 + i), // A, B, C, D
        status:    'vacant',
      }));
    });
    const { rowCount } = await query(`
      INSERT INTO beds (room_id, bed_label, status)
      SELECT b.room_id, b.bed_label, b.status::bed_status
      FROM jsonb_to_recordset($1::jsonb)
        AS b(room_id uuid, bed_label text, status text)
      ON CONFLICT (room_id, bed_label) DO NOTHING
    `, [JSON.stringify(bedRows)]);
    console.log(`  inserted ${rowCount} bed(s)`);
  }

  // ── Students ─────────────────────────────────────────────
  console.log('[seed] Inserting student profiles …');
  const studentProfiles = [
    { email: 'mehrin@ashgrove.edu',  student_id: 'STU-2201', room: 'A-204', dept: 'Computer Science',  year: 3 },
    { email: 'rafiul@ashgrove.edu',  student_id: 'STU-2202', room: 'A-204', dept: 'Electrical Eng.',   year: 2 },
    { email: 'sara@ashgrove.edu',    student_id: 'STU-2203', room: 'B-112', dept: 'Business Admin',    year: 4 },
    { email: 'tanvir@ashgrove.edu',  student_id: 'STU-2204', room: 'A-310', dept: 'Civil Engineering', year: 1 },
    { email: 'nadia@ashgrove.edu',   student_id: 'STU-2205', room: 'B-208', dept: 'Medicine',          year: 3 },
    { email: 'omar@ashgrove.edu',    student_id: 'STU-2206', room: 'A-115', dept: 'Physics',           year: 2 },
  ];
  for (const p of studentProfiles) {
    const uid = byEmail(p.email);
    const rid = byRoom(p.room);
    if (!uid) continue;
    await query(`
      INSERT INTO students (id, student_id, room_id, check_in_date, department, year_of_study)
      VALUES ($1, $2, $3, CURRENT_DATE - INTERVAL '120 days', $4, $5)
      ON CONFLICT (id) DO NOTHING
    `, [uid, p.student_id, rid, p.dept, p.year]);
  }
  console.log(`  inserted up to ${studentProfiles.length} profile(s)`);

  // ── Notices ───────────────────────────────────────────────
  console.log('[seed] Inserting notices …');
  const adminId = byEmail('admin@ashgrove.edu');
  if (adminId) {
    await query(`
      INSERT INTO notices (title, body, category, is_pinned, author_id) VALUES
        ('Water Outage — Block A', 'There will be a water supply interruption in Block A on June 28 from 9 AM – 2 PM for pipe maintenance.', 'Maintenance', true,  $1),
        ('Exam Curfew in Effect',  'All students must return to the hall by 10 PM during the upcoming exam period (June 25 – July 8).', 'Exam', true, $1),
        ('Dining Hall Hours Change', 'Effective July 1, breakfast will be served from 7:30 AM instead of 7:00 AM.', 'Dining', false, $1),
        ('Public Holiday — No Classes', 'The hall office will be closed on July 4. Gate passes will still be issued.', 'Holiday', false, $1),
        ('Generator Test', 'Planned power outage for generator testing on June 30 from 2–3 PM.', 'General', false, $1)
      ON CONFLICT DO NOTHING
    `, [adminId]);
  }

  // ── Invoices ──────────────────────────────────────────────
  console.log('[seed] Inserting invoices …');
  const invoices = [
    { inv: 'INV-1042', email: 'mehrin@ashgrove.edu', room: 'A-204', type: 'Seat Rent',      amount: 140.00, paid: 140.00, status: 'paid',    due: '2026-06-05' },
    { inv: 'INV-1043', email: 'rafiul@ashgrove.edu', room: 'A-204', type: 'Electric Bill',  amount: 18.40,  paid: 18.40,  status: 'paid',    due: '2026-06-05' },
    { inv: 'INV-1044', email: 'sara@ashgrove.edu',   room: 'B-112', type: 'Seat Rent',      amount: 140.00, paid: 0,      status: 'pending', due: '2026-06-28' },
    { inv: 'INV-1045', email: 'tanvir@ashgrove.edu', room: 'A-310', type: 'Dining Bill',    amount: 96.00,  paid: 48.00,  status: 'partial', due: '2026-06-22' },
    { inv: 'INV-1046', email: 'nadia@ashgrove.edu',  room: 'B-208', type: 'Seat Rent',      amount: 140.00, paid: 0,      status: 'overdue', due: '2026-06-10' },
    { inv: 'INV-1047', email: 'omar@ashgrove.edu',   room: 'A-115', type: 'Internet Bill',  amount: 12.00,  paid: 12.00,  status: 'paid',    due: '2026-06-05' },
    { inv: 'INV-1048', email: 'nadia@ashgrove.edu',  room: 'B-208', type: 'Late Fee',       amount: 15.00,  paid: 0,      status: 'overdue', due: '2026-06-10' },
  ];
  if (adminId) {
    for (const inv of invoices) {
      const sid = byEmail(inv.email);
      const rid = byRoom(inv.room);
      if (!sid) continue;
      await query(`
        INSERT INTO invoices (invoice_no, student_id, room_id, fee_type, amount, amount_paid, status, due_date, created_by)
        VALUES ($1, $2, $3, $4::fee_type, $5, $6, $7::fee_status, $8, $9)
        ON CONFLICT (invoice_no) DO NOTHING
      `, [inv.inv, sid, rid, inv.type, inv.amount, inv.paid, inv.status, inv.due, adminId]);
    }
  }

  // ── Complaints ────────────────────────────────────────────
  console.log('[seed] Inserting complaints …');
  const complaints = [
    { email: 'mehrin@ashgrove.edu', room: 'A-204', cat: 'Plumbing',    subj: 'Leaking tap',       prio: 'medium',    stat: 'in_progress' },
    { email: 'sara@ashgrove.edu',   room: 'B-112', cat: 'Electrical',  subj: 'Socket not working', prio: 'low',       stat: 'pending' },
    { email: 'tanvir@ashgrove.edu', room: 'A-310', cat: 'Furniture',   subj: 'Broken chair',       prio: 'low',       stat: 'assigned' },
    { email: 'nadia@ashgrove.edu',  room: 'B-208', cat: 'Plumbing',    subj: 'No hot water',       prio: 'emergency', stat: 'pending' },
    { email: 'omar@ashgrove.edu',   room: 'A-115', cat: 'Electrical',  subj: 'Flickering light',   prio: 'low',       stat: 'pending' },
  ];
  for (const c of complaints) {
    const sid = byEmail(c.email);
    const rid = byRoom(c.room);
    if (!sid) continue;
    await query(`
      INSERT INTO complaints (student_id, room_id, category, subject, priority, status)
      VALUES ($1, $2, $3, $4, $5::complaint_prio, $6::complaint_stat)
    `, [sid, rid, c.cat, c.subj, c.prio, c.stat]);
  }

  // ── Visitors ──────────────────────────────────────────────
  console.log('[seed] Inserting visitors …');
  const mehrinId = byEmail('mehrin@ashgrove.edu');
  const saraId   = byEmail('sara@ashgrove.edu');
  if (mehrinId && saraId && adminId) {
    await query(`
      INSERT INTO visitors (visitor_name, visitor_phone, student_id, room_id, purpose, status, pass_no, issued_by)
      VALUES
        ('Kamrul Islam',  '+1-555-9001', $1, $3, 'Family visit',   'in',  'VP-0041', $5),
        ('Priya Sharma',  '+1-555-9002', $2, $4, 'Drop textbooks', 'out', 'VP-0042', $5)
      ON CONFLICT (pass_no) DO NOTHING
    `, [mehrinId, saraId, byRoom('A-204'), byRoom('B-112'), adminId]);
  }

  console.log('[seed] ✓ All done!');
  await pool.end();
}

seed().catch(err => {
  console.error('[seed] ✗', err.message);
  process.exit(1);
});
