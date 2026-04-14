'use strict';

const express = require('express');
const bcrypt = require('bcrypt');
const { getSetting, setSetting } = require('../db');

const router = express.Router();

// ── Login page ────────────────────────────────────────────────────────────────
router.get('/login', (req, res) => {
  if (req.session.authenticated) return res.redirect('/');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CrazyCardzCo — Login</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0d1117;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    .card {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 12px;
      padding: 2.5rem;
      width: 100%;
      max-width: 380px;
    }
    .logo { text-align: center; margin-bottom: 2rem; }
    .logo h1 { color: #c5a55a; font-size: 1.5rem; font-weight: 700; letter-spacing: 1px; }
    .logo p { color: #8b949e; font-size: 0.85rem; margin-top: 0.3rem; }
    label { display: block; color: #f5f0e1; font-size: 0.875rem; margin-bottom: 0.4rem; }
    input {
      width: 100%;
      padding: 0.65rem 1rem;
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 6px;
      color: #f5f0e1;
      font-size: 1rem;
      margin-bottom: 1.25rem;
    }
    input:focus { outline: none; border-color: #4a9e3f; }
    button {
      width: 100%;
      padding: 0.75rem;
      background: #4a9e3f;
      border: none;
      border-radius: 6px;
      color: #fff;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
    }
    button:hover { background: #3d8534; }
    .error { color: #f85149; font-size: 0.85rem; margin-bottom: 1rem; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <h1>🃏 CrazyCardzCo</h1>
      <p>Card Arbitrage Engine</p>
    </div>
    ${req.query.error ? '<p class="error">Incorrect password. Try again.</p>' : ''}
    <form method="POST" action="/auth/login">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" autofocus autocomplete="current-password" />
      <button type="submit">Sign In</button>
    </form>
  </div>
</body>
</html>`);
});

// ── Login POST ────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { password } = req.body;
  const hash = getSetting('dashboard_password_hash');

  if (!password || !hash) return res.redirect('/auth/login?error=1');

  const match = await bcrypt.compare(password, hash);
  if (!match) return res.redirect('/auth/login?error=1');

  req.session.authenticated = true;
  res.redirect('/');
});

// ── Logout ────────────────────────────────────────────────────────────────────
router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/auth/login');
});

// ── Change password ───────────────────────────────────────────────────────────
router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const hash = getSetting('dashboard_password_hash');
  const match = await bcrypt.compare(currentPassword, hash);
  if (!match) return res.status(401).json({ error: 'Current password incorrect' });

  const newHash = await bcrypt.hash(newPassword, 10);
  setSetting('dashboard_password_hash', newHash);
  res.json({ ok: true });
});

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  if (req.path.startsWith('/api')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/auth/login');
}

module.exports = { router, requireAuth };
