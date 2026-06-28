require('dotenv').config();
const express     = require('express');
const helmet      = require('helmet');
const cors        = require('cors');
const rateLimit   = require('express-rate-limit');
const { errorHandler } = require('./middleware/errors');

const app = express();

// ── Security & parsing ───────────────────────────────────────

app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));

// ── Rate limiting ────────────────────────────────────────────

app.use('/api/auth/login', rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 min
  max: 20,
  message: { error: 'Too many login attempts. Try again later.' },
}));

app.use('/api/', rateLimit({
  windowMs: 60 * 1000,  // 1 min
  max: 300,
}));

// ── Routes ───────────────────────────────────────────────────

app.use('/api/auth',       require('./routes/auth'));
app.use('/api/dashboard',  require('./routes/dashboard'));
app.use('/api/rooms',      require('./routes/rooms'));
app.use('/api/students',   require('./routes/students'));
app.use('/api/notices',    require('./routes/notices'));
app.use('/api/complaints', require('./routes/complaints'));
app.use('/api/invoices',   require('./routes/invoices'));
app.use('/api/visitors',   require('./routes/visitors'));

// ── Health check ─────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// ── 404 ──────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// ── Central error handler ────────────────────────────────────

app.use(errorHandler);

// ── Start ────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[server] Ashgrove Hall API running on :${PORT}  (${process.env.NODE_ENV})`);
});

module.exports = app;
