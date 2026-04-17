'use strict';

require('dotenv').config();

const express        = require('express');
const session        = require('express-session');
const cors           = require('cors');
const path           = require('path');
const { initDb }     = require('./db');
const { router: authRouter, requireAuth } = require('./routes/auth');
const apiRouter      = require('./routes/api');
const webhookRouter  = require('./routes/webhooks');
const { startScheduler } = require('./scanner/scheduler');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.set('trust proxy', 1); // Railway (and most PaaS) terminate TLS at a proxy
app.use(cors({ origin: false }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
}));

// ── Public routes (no auth) ───────────────────────────────────────────────────
app.use('/auth', authRouter);
app.use('/webhooks', webhookRouter); // Twilio webhook — no session auth, but Twilio signs requests

// ── Static files + dashboard (auth gated) ────────────────────────────────────
app.use('/style.css', express.static(path.join(__dirname, 'public', 'style.css')));
app.use('/app.js',    express.static(path.join(__dirname, 'public', 'app.js')));

app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── API routes (auth gated) ───────────────────────────────────────────────────
app.use('/api', requireAuth, apiRouter);

// ── Health check (public) ─────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  res.redirect('/');
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[Server] Unhandled error:', err);
  if (req.path.startsWith('/api')) {
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
  res.status(500).send('Internal server error');
});

// ── Boot ──────────────────────────────────────────────────────────────────────
async function start() {
  // Refuse to start in production with default/insecure credentials
  if (process.env.NODE_ENV === 'production') {
    if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'dev-secret-change-in-prod') {
      console.error('[Fatal] SESSION_SECRET must be set to a secure random value in production.');
      process.exit(1);
    }
    if (!process.env.DASHBOARD_PASSWORD || process.env.DASHBOARD_PASSWORD === 'crazycardz2024') {
      console.error('[Fatal] DASHBOARD_PASSWORD must be changed from the default value in production.');
      process.exit(1);
    }
  }

  // Init database (creates tables + seeds watchlist)
  initDb();

  // Start server
  app.listen(PORT, () => {
    console.log('');
    console.log('  🃏 CrazyCardzCo Arbitrage Engine');
    console.log(`  ─────────────────────────────────`);
    console.log(`  Dashboard : http://localhost:${PORT}`);
    console.log(`  Password  : ${process.env.DASHBOARD_PASSWORD || 'crazycardz2024'}`);
    console.log(`  Mock mode : ${process.env.MOCK_SCANNER !== 'false' ? 'ON (set MOCK_SCANNER=false for live)' : 'OFF'}`);
    console.log(`  SMS to    : ${process.env.TWILIO_TO_NUMBER || '(not configured)'}`);
    console.log('');
  });

  // Start deal scanner + cron jobs
  startScheduler();
}

start().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
