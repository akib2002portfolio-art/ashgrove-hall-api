# Ashgrove Hall — Backend API

Node/Express + PostgreSQL REST API backing the hall management UI.

---

## Stack

| Layer       | Choice                         |
|-------------|--------------------------------|
| Runtime     | Node.js ≥ 18                   |
| Framework   | Express 4                      |
| Database    | PostgreSQL 15+                 |
| Auth        | JWT (access + refresh tokens)  |
| Passwords   | bcryptjs (cost 12)             |
| Validation  | express-validator              |
| Security    | helmet, cors, express-rate-limit |

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env — set DATABASE_URL and JWT_SECRET at minimum

# 3. Create Postgres database
createdb hall_management
psql hall_management -c "CREATE USER hall_user WITH PASSWORD 'secret';"
psql hall_management -c "GRANT ALL PRIVILEGES ON DATABASE hall_management TO hall_user;"

# 4. Run migrations (creates all tables, indexes, triggers)
npm run db:migrate

# 5. Seed with sample data matching the UI mockup
npm run db:seed

# 6. Start
npm run dev      # dev (nodemon)
npm start        # production
```

---

## Project Structure

```
hall-backend/
├── sql/
│   └── schema.sql          — Full Postgres schema (tables, enums, triggers)
├── src/
│   ├── index.js            — Express app + middleware chain
│   ├── db/
│   │   ├── index.js        — pg Pool (query + getClient helpers)
│   │   ├── migrate.js      — Runs schema.sql
│   │   └── seed.js         — Sample data
│   ├── middleware/
│   │   ├── auth.js         — JWT verification, requireRole, ownOrAdmin
│   │   └── errors.js       — asyncHandler + central error handler
│   └── routes/
│       ├── auth.js         — /api/auth/*
│       ├── dashboard.js    — /api/dashboard
│       ├── rooms.js        — /api/rooms/*
│       ├── students.js     — /api/students/*
│       ├── notices.js      — /api/notices/*
│       ├── complaints.js   — /api/complaints/*
│       ├── invoices.js     — /api/invoices/*
│       └── visitors.js     — /api/visitors/*
└── .env.example
```

---

## Auth Flow

```
POST /api/auth/login
  → { access_token, refresh_token, user }

Authorization: Bearer <access_token>   ← on every protected request

POST /api/auth/refresh   { refresh_token }
  → { access_token, refresh_token }    ← token rotation

POST /api/auth/logout    { refresh_token }
  → 200 (revokes the refresh token)

GET  /api/auth/me        → full user + student profile
```

Seed credentials (development):
- Admin:   `admin@ashgrove.edu`  / `admin123`
- Student: `mehrin@ashgrove.edu` / `student123`

---

## API Reference

### Rooms
```
GET    /api/rooms                ?status=available&block=A&page=1&limit=50
GET    /api/rooms/:id            includes beds + current occupant stubs
POST   /api/rooms                admin — creates room + beds automatically
PATCH  /api/rooms/:id            admin — update status/notes
DELETE /api/rooms/:id            admin only
```

### Students
```
GET    /api/students             admin — ?search=&room=&page=&limit=
GET    /api/students/:id         own or admin
POST   /api/students             admin — creates user + student profile
PATCH  /api/students/:id         own (name/phone) or admin (anything)
PATCH  /api/students/:id/assign-room   admin — moves student, updates bed/room status
```

### Notices
```
GET    /api/notices              ?category=&pinned=true&page=&limit=
POST   /api/notices              admin/warden
PATCH  /api/notices/:id          admin/warden
DELETE /api/notices/:id          admin only
```

### Complaints
```
GET    /api/complaints           admin: all; student: own only
                                 ?status=pending&priority=emergency
GET    /api/complaints/:id       includes comment thread
POST   /api/complaints           any authenticated user
PATCH  /api/complaints/:id       admin: all fields; student: description only
POST   /api/complaints/:id/comments
```

### Invoices / Fees
```
GET    /api/invoices             ?status=overdue&student_id=…
GET    /api/invoices/summary     admin — current-month roll-up
GET    /api/invoices/:id         includes payment history
POST   /api/invoices             admin/warden — auto-generates INV-xxxx
POST   /api/invoices/:id/payments   admin — records payment, auto-updates status
POST   /api/invoices/overdue-sweep  admin — marks past-due invoices overdue (run via cron)
```

### Visitors
```
GET    /api/visitors             ?status=in&student_id=…; auto-flags overstayed
GET    /api/visitors/stats       admin — checked_in_now, today_total, overstayed, avg_time
POST   /api/visitors             admin — issues pass, auto-generates VP-xxxx
PATCH  /api/visitors/:id/checkout   admin — check out visitor
```

### Dashboard
```
GET    /api/dashboard            admin — rooms, fees, complaints, visitors + recent complaints
```

---

## Role Matrix

| Resource                    | student       | warden        | admin         |
|-----------------------------|:---:|:---:|:---:|
| Rooms (read)                | ✓   | ✓   | ✓   |
| Rooms (write)               |     | ✓   | ✓   |
| Students (own profile)      | ✓   | ✓   | ✓   |
| Students (all)              |     | ✓   | ✓   |
| Assign room                 |     | ✓   | ✓   |
| Notices (read)              | ✓   | ✓   | ✓   |
| Notices (write)             |     | ✓   | ✓   |
| Complaints (own)            | ✓   | ✓   | ✓   |
| Complaints (all)            |     | ✓   | ✓   |
| Invoices (own)              | ✓   | ✓   | ✓   |
| Invoices (create/pay)       |     | ✓   | ✓   |
| Visitors                    |     | ✓   | ✓   |
| Dashboard                   |     | ✓   | ✓   |
| Delete rooms/notices        |     |     | ✓   |

---

## Connecting the Frontend

Replace the mock arrays in `hall-management.html` with fetch calls:

```js
// lib/api.js
const BASE = 'http://localhost:3000/api';

let tokens = JSON.parse(localStorage.getItem('tokens') || '{}');

async function apiFetch(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokens.access_token}`,
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    // Attempt token refresh then retry once
    const r = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: tokens.refresh_token }),
    });
    if (r.ok) {
      tokens = await r.json();
      localStorage.setItem('tokens', JSON.stringify(tokens));
      return apiFetch(path, opts);  // retry
    }
    localStorage.removeItem('tokens');
    window.location.href = '/login';
  }
  if (!res.ok) throw await res.json();
  return res.status === 204 ? null : res.json();
}

// Examples
export const getNotices  = ()        => apiFetch('/notices');
export const postNotice  = (data)    => apiFetch('/notices', { method: 'POST', body: data });
export const getInvoices = (status)  => apiFetch(`/invoices?status=${status}`);
export const markPaid    = (id, amt) => apiFetch(`/invoices/${id}/payments`, { method: 'POST', body: { amount: amt } });
```

---

## Production Checklist

- [ ] Set `NODE_ENV=production`
- [ ] Use a proper secret for `JWT_SECRET` (64+ random chars)
- [ ] Enable SSL on Postgres (`sslmode=require` in `DATABASE_URL`)
- [ ] Put API behind nginx/Caddy for TLS termination
- [ ] Run `overdue-sweep` via a daily cron: `0 1 * * * curl -X POST http://localhost:3000/api/invoices/overdue-sweep -H "Authorization: Bearer $ADMIN_TOKEN"`
- [ ] Set up Postgres backups (pg_dump or managed DB backups)
- [ ] Consider adding an `audit_log` table for compliance

---

## Deploying from GitHub (Railway)

### One-time setup

**1. Push to GitHub**
```bash
git init
git add .
git commit -m "feat: initial backend scaffold"
gh repo create ashgrove-hall-api --private --push --source .
```

**2. Create a Railway project**
- Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub repo
- Select your repo
- Railway auto-detects the `Dockerfile`

**3. Add a Postgres database**
In Railway dashboard → New → Database → PostgreSQL
Railway automatically injects `DATABASE_URL` into your service's environment.

**4. Set environment variables** in Railway dashboard → your service → Variables:
```
JWT_SECRET=<generate: openssl rand -hex 32>
JWT_REFRESH_SECRET=<generate: openssl rand -hex 32>
FRONTEND_URL=https://your-frontend.vercel.app
NODE_ENV=production
```

**5. Add `RAILWAY_TOKEN` to GitHub secrets**
Railway dashboard → Account Settings → Tokens → Create
GitHub repo → Settings → Secrets → Actions → New secret: `RAILWAY_TOKEN`

After that, every push to `main`:
1. CI runs tests against a Postgres service container
2. Docker image built and pushed to GitHub Container Registry (`ghcr.io`)
3. Railway pulls the new image and redeploys (zero-downtime)

### Local dev with Docker
```bash
docker compose up          # starts Postgres + API (with seed data)
docker compose --profile tools up   # also starts pgAdmin at :5050
```

### Manual deploy (no CI)
```bash
railway up
```
