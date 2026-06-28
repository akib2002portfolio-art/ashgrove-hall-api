-- =============================================================
--  Ashgrove Hall Management — Full Schema
--  Run via: psql $DATABASE_URL -f sql/schema.sql
-- =============================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "citext";     -- case-insensitive email

-- ─────────────────────────────────────────────────────────────
--  ENUM TYPES
-- ─────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('admin', 'student', 'warden');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE room_status AS ENUM ('available', 'full', 'reserved', 'maintenance');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE bed_status AS ENUM ('vacant', 'occupied', 'reserved');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE notice_cat AS ENUM ('General', 'Emergency', 'Maintenance', 'Holiday', 'Dining', 'Exam');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE complaint_prio AS ENUM ('low', 'medium', 'high', 'emergency');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE complaint_stat AS ENUM ('pending', 'assigned', 'in_progress', 'resolved', 'closed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE fee_type AS ENUM ('Seat Rent', 'Electric Bill', 'Internet Bill', 'Dining Bill', 'Laundry Bill', 'Maintenance Fee', 'Late Fee', 'Other');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE fee_status AS ENUM ('pending', 'partial', 'paid', 'overdue', 'cancelled');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE visitor_status AS ENUM ('in', 'out', 'overstayed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────
--  USERS  (admins + students share one table; role disambiguates)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  email         CITEXT        NOT NULL UNIQUE,
  password_hash TEXT          NOT NULL,
  full_name     TEXT          NOT NULL,
  role          user_role     NOT NULL DEFAULT 'student',
  phone         TEXT,
  photo_url     TEXT,
  is_active     BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Refresh tokens (one-per-session; invalidated on logout/rotation)
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT        NOT NULL UNIQUE,   -- store hash, not raw token
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────
--  ROOMS & BEDS
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rooms (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  room_number  TEXT        NOT NULL UNIQUE,   -- e.g. "A-204"
  floor        TEXT,                           -- e.g. "2nd Floor"
  block        TEXT,                           -- e.g. "A"
  capacity     INT         NOT NULL DEFAULT 2, -- total beds
  status       room_status NOT NULL DEFAULT 'available',
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS beds (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id      UUID        NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  bed_label    TEXT        NOT NULL,           -- "A", "B", "C" etc.
  status       bed_status  NOT NULL DEFAULT 'vacant',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (room_id, bed_label)
);

-- ─────────────────────────────────────────────────────────────
--  STUDENTS (profile layer on top of users)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS students (
  id              UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  student_id      TEXT        NOT NULL UNIQUE,  -- institutional ID
  room_id         UUID        REFERENCES rooms(id),
  bed_id          UUID        REFERENCES beds(id),
  check_in_date   DATE,
  check_out_date  DATE,
  emergency_name  TEXT,
  emergency_phone TEXT,
  department      TEXT,
  year_of_study   INT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────
--  NOTICES
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notices (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT        NOT NULL,
  body        TEXT        NOT NULL,
  category    notice_cat  NOT NULL DEFAULT 'General',
  is_pinned   BOOLEAN     NOT NULL DEFAULT FALSE,
  author_id   UUID        NOT NULL REFERENCES users(id),
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────
--  COMPLAINTS / MAINTENANCE REQUESTS
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS complaints (
  id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id      UUID            NOT NULL REFERENCES users(id),
  room_id         UUID            REFERENCES rooms(id),
  category        TEXT            NOT NULL,   -- "Plumbing", "Electrical", etc.
  subject         TEXT            NOT NULL,
  description     TEXT,
  priority        complaint_prio  NOT NULL DEFAULT 'low',
  status          complaint_stat  NOT NULL DEFAULT 'pending',
  assigned_to_id  UUID            REFERENCES users(id),
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- Comment thread on complaints
CREATE TABLE IF NOT EXISTS complaint_comments (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  complaint_id UUID        NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
  author_id    UUID        NOT NULL REFERENCES users(id),
  body         TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────
--  FEES / INVOICES
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS invoices (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_no    TEXT        NOT NULL UNIQUE,  -- "INV-1042"
  student_id    UUID        NOT NULL REFERENCES users(id),
  room_id       UUID        REFERENCES rooms(id),
  fee_type      fee_type    NOT NULL,
  amount        NUMERIC(10,2) NOT NULL,
  amount_paid   NUMERIC(10,2) NOT NULL DEFAULT 0,
  status        fee_status  NOT NULL DEFAULT 'pending',
  due_date      DATE        NOT NULL,
  notes         TEXT,
  created_by    UUID        NOT NULL REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Immutable payment ledger
CREATE TABLE IF NOT EXISTS payments (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id    UUID          NOT NULL REFERENCES invoices(id),
  amount        NUMERIC(10,2) NOT NULL,
  method        TEXT          NOT NULL DEFAULT 'manual',  -- 'card', 'cash', 'transfer'
  reference     TEXT,
  recorded_by   UUID          NOT NULL REFERENCES users(id),
  paid_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────
--  VISITORS
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS visitors (
  id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_name    TEXT            NOT NULL,
  visitor_phone   TEXT,
  visitor_id_ref  TEXT,                        -- NID / passport
  student_id      UUID            NOT NULL REFERENCES users(id),
  room_id         UUID            REFERENCES rooms(id),
  purpose         TEXT,
  status          visitor_status  NOT NULL DEFAULT 'in',
  checked_in_at   TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  checked_out_at  TIMESTAMPTZ,
  issued_by       UUID            REFERENCES users(id),
  pass_no         TEXT            UNIQUE,
  notes           TEXT
);

-- ─────────────────────────────────────────────────────────────
--  INDEXES
-- ─────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_students_room      ON students(room_id);
CREATE INDEX IF NOT EXISTS idx_complaints_student ON complaints(student_id);
CREATE INDEX IF NOT EXISTS idx_complaints_status  ON complaints(status);
CREATE INDEX IF NOT EXISTS idx_invoices_student   ON invoices(student_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status    ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_due_date  ON invoices(due_date);
CREATE INDEX IF NOT EXISTS idx_visitors_student   ON visitors(student_id);
CREATE INDEX IF NOT EXISTS idx_visitors_status    ON visitors(status);
CREATE INDEX IF NOT EXISTS idx_notices_cat        ON notices(category);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);

-- ─────────────────────────────────────────────────────────────
--  AUTO-UPDATE updated_at
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DO $$ DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','rooms','students','notices','complaints','invoices'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_updated ON %s', t, t);
    EXECUTE format(
      'CREATE TRIGGER trg_%s_updated BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION touch_updated_at()',
      t, t
    );
  END LOOP;
END $$;
