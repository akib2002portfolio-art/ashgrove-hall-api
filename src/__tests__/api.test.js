/**
 * Integration tests — run against a real Postgres test DB.
 * The CI workflow spins up a Postgres service container automatically.
 * Locally: have Postgres running and set DATABASE_URL in .env
 *
 * Usage: npm test
 */
const request = require('supertest');
const app     = require('../index');
const db      = require('../db');

// ── Shared state across tests ────────────────────────────────
let adminToken, studentToken;
let createdRoomId, createdStudentId, createdNoticeId, createdComplaintId, createdInvoiceId;

afterAll(async () => {
  await db.pool.end();
});

// ════════════════════════════════════════════════════════════
//  AUTH
// ════════════════════════════════════════════════════════════

describe('POST /api/auth/login', () => {
  it('rejects bad credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: 'wrong' });
    expect(res.status).toBe(401);
  });

  it('returns tokens for admin', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@ashgrove.edu', password: 'admin123' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('access_token');
    expect(res.body.user.role).toBe('admin');
    adminToken = res.body.access_token;
  });

  it('returns tokens for student', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'mehrin@ashgrove.edu', password: 'student123' });
    expect(res.status).toBe(200);
    studentToken = res.body.access_token;
  });
});

describe('GET /api/auth/me', () => {
  it('returns profile for authenticated user', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('admin');
  });

  it('rejects unauthenticated requests', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });
});

// ════════════════════════════════════════════════════════════
//  ROOMS
// ════════════════════════════════════════════════════════════

describe('Rooms', () => {
  it('GET /api/rooms — admin can list rooms', async () => {
    const res = await request(app)
      .get('/api/rooms')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('POST /api/rooms — admin can create a room', async () => {
    const res = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ room_number: 'TEST-001', floor: '1st', block: 'T', capacity: 2 });
    expect(res.status).toBe(201);
    expect(res.body.room_number).toBe('TEST-001');
    createdRoomId = res.body.id;
  });

  it('GET /api/rooms/:id — returns room with beds', async () => {
    const res = await request(app)
      .get(`/api/rooms/${createdRoomId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.beds).toHaveLength(2);
  });

  it('PATCH /api/rooms/:id — can update status', async () => {
    const res = await request(app)
      .patch(`/api/rooms/${createdRoomId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'maintenance' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('maintenance');
  });

  it('POST /api/rooms — student is forbidden', async () => {
    const res = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ room_number: 'X-999', capacity: 1 });
    expect(res.status).toBe(403);
  });

  it('DELETE /api/rooms/:id — admin can delete', async () => {
    const res = await request(app)
      .delete(`/api/rooms/${createdRoomId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(204);
  });
});

// ════════════════════════════════════════════════════════════
//  NOTICES
// ════════════════════════════════════════════════════════════

describe('Notices', () => {
  it('GET /api/notices — accessible to all authenticated users', async () => {
    const res = await request(app)
      .get('/api/notices')
      .set('Authorization', `Bearer ${studentToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('POST /api/notices — admin can create', async () => {
    const res = await request(app)
      .post('/api/notices')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: 'Test Notice', body: 'Test body.', category: 'General' });
    expect(res.status).toBe(201);
    createdNoticeId = res.body.id;
  });

  it('POST /api/notices — student is forbidden', async () => {
    const res = await request(app)
      .post('/api/notices')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ title: 'Nope', body: 'Nope.', category: 'General' });
    expect(res.status).toBe(403);
  });

  it('DELETE /api/notices/:id — admin can delete', async () => {
    const res = await request(app)
      .delete(`/api/notices/${createdNoticeId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(204);
  });
});

// ════════════════════════════════════════════════════════════
//  COMPLAINTS
// ════════════════════════════════════════════════════════════

describe('Complaints', () => {
  it('POST /api/complaints — student can file a complaint', async () => {
    const res = await request(app)
      .post('/api/complaints')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ category: 'Electrical', subject: 'Broken socket', priority: 'low' });
    expect(res.status).toBe(201);
    createdComplaintId = res.body.id;
  });

  it('GET /api/complaints — student only sees own', async () => {
    const res = await request(app)
      .get('/api/complaints')
      .set('Authorization', `Bearer ${studentToken}`);
    expect(res.status).toBe(200);
    const hasOthers = res.body.data.some(c => c.student_id !== res.body.data[0]?.student_id);
    expect(hasOthers).toBe(false);
  });

  it('PATCH /api/complaints/:id — admin can change status', async () => {
    const res = await request(app)
      .patch(`/api/complaints/${createdComplaintId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'assigned' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('assigned');
  });
});

// ════════════════════════════════════════════════════════════
//  INVOICES
// ════════════════════════════════════════════════════════════

describe('Invoices', () => {
  let studentId;

  beforeAll(async () => {
    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${studentToken}`);
    studentId = me.body.id;
  });

  it('POST /api/invoices — admin can create invoice', async () => {
    const res = await request(app)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        student_id: studentId,
        fee_type:   'Seat Rent',
        amount:     140,
        due_date:   '2026-07-31',
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
    createdInvoiceId = res.body.id;
  });

  it('POST /api/invoices/:id/payments — records a partial payment', async () => {
    const res = await request(app)
      .post(`/api/invoices/${createdInvoiceId}/payments`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ amount: 70, method: 'cash' });
    expect(res.status).toBe(201);
    expect(res.body.new_status).toBe('partial');
  });

  it('POST /api/invoices/:id/payments — second payment marks as paid', async () => {
    const res = await request(app)
      .post(`/api/invoices/${createdInvoiceId}/payments`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ amount: 70, method: 'cash' });
    expect(res.status).toBe(201);
    expect(res.body.new_status).toBe('paid');
  });
});

// ════════════════════════════════════════════════════════════
//  DASHBOARD
// ════════════════════════════════════════════════════════════

describe('GET /api/dashboard', () => {
  it('returns stats for admin', async () => {
    const res = await request(app)
      .get('/api/dashboard')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('rooms');
    expect(res.body).toHaveProperty('fees');
    expect(res.body).toHaveProperty('complaints');
    expect(res.body).toHaveProperty('visitors');
  });

  it('rejects students', async () => {
    const res = await request(app)
      .get('/api/dashboard')
      .set('Authorization', `Bearer ${studentToken}`);
    expect(res.status).toBe(403);
  });
});
