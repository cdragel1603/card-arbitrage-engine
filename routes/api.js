'use strict';

const express = require('express');
const { getDb, getSetting, setSetting, getWeeklySpend } = require('../db');
const { getPriceHistory, calcRawBreakEven } = require('../engine/pricing');
const { gradeCard } = require('../engine/condition-grader');
const { runScanCycle, refreshAllComps } = require('../scanner/scheduler');
const { sendTestSms } = require('../alerts/sms');

const router = express.Router();

// ────────────────────────────────────────────────────────────────────────────
// Deals
// ────────────────────────────────────────────────────────────────────────────

// GET /api/deals — active deals feed
router.get('/deals', (req, res) => {
  const db = getDb();
  const { status = 'active', limit = 50, offset = 0 } = req.query;
  const deals = db.prepare(`
    SELECT * FROM deals
    WHERE status=?
    ORDER BY detected_at DESC
    LIMIT ? OFFSET ?
  `).all(status, parseInt(limit), parseInt(offset));
  res.json(deals);
});

// GET /api/deals/live — deals with extra real-time info
router.get('/deals/live', (req, res) => {
  const db = getDb();
  const deals = db.prepare(`
    SELECT d.*,
      ROUND((1.0 - d.listing_price / d.fmv) * 100, 1) as discount_pct_calc,
      CASE
        WHEN d.listing_type='auction' AND d.auction_end_time IS NOT NULL
        THEN ROUND((julianday(d.auction_end_time) - julianday('now')) * 1440, 0)
        ELSE NULL
      END as mins_left
    FROM deals d
    WHERE d.status IN ('active','sms_pending')
    ORDER BY d.discount_pct DESC, d.detected_at DESC
    LIMIT 100
  `).all();
  res.json(deals);
});

// PATCH /api/deals/:id/pass — mark as passed
router.patch('/deals/:id/pass', (req, res) => {
  const db = getDb();
  db.prepare("UPDATE deals SET status='passed' WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// ────────────────────────────────────────────────────────────────────────────
// Transactions (portfolio)
// ────────────────────────────────────────────────────────────────────────────

// GET /api/transactions
router.get('/transactions', (req, res) => {
  const db = getDb();
  const { status, limit = 100 } = req.query;
  const transactions = status
    ? db.prepare('SELECT * FROM transactions WHERE status=? ORDER BY purchase_date DESC LIMIT ?').all(status, parseInt(limit))
    : db.prepare('SELECT * FROM transactions ORDER BY purchase_date DESC LIMIT ?').all(parseInt(limit));
  res.json(transactions);
});

// POST /api/transactions/:id/update — update current value or mark sold
router.patch('/transactions/:id', (req, res) => {
  const db = getDb();
  const { current_value, sold_price, sold_date, status, notes } = req.body;
  const t = db.prepare('SELECT * FROM transactions WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });

  db.prepare(`
    UPDATE transactions SET
      current_value = COALESCE(?, current_value),
      sold_price    = COALESCE(?, sold_price),
      sold_date     = COALESCE(?, sold_date),
      status        = COALESCE(?, status),
      notes         = COALESCE(?, notes)
    WHERE id=?
  `).run(
    current_value ?? null,
    sold_price ?? null,
    sold_date ?? null,
    status ?? null,
    notes ?? null,
    req.params.id,
  );
  res.json({ ok: true });
});

// GET /api/portfolio/summary
router.get('/portfolio/summary', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM transactions').all();

  const totalInvested = rows.reduce((s, t) => s + t.purchase_price, 0);
  const currentValue  = rows
    .filter(t => t.status === 'inventory' || t.status === 'grading')
    .reduce((s, t) => s + (t.current_value || t.fmv_at_purchase), 0);
  const soldRevenue   = rows
    .filter(t => t.status === 'sold' && t.sold_price)
    .reduce((s, t) => s + t.sold_price, 0);
  const soldCost      = rows
    .filter(t => t.status === 'sold')
    .reduce((s, t) => s + t.purchase_price, 0);
  const realizedPnl   = soldRevenue - soldCost;
  const unrealizedPnl = currentValue - rows
    .filter(t => t.status === 'inventory' || t.status === 'grading')
    .reduce((s, t) => s + t.purchase_price, 0);

  res.json({
    totalCards: rows.length,
    totalInvested: Math.round(totalInvested * 100) / 100,
    currentValue: Math.round(currentValue * 100) / 100,
    unrealizedPnl: Math.round(unrealizedPnl * 100) / 100,
    realizedPnl: Math.round(realizedPnl * 100) / 100,
    totalPnl: Math.round((realizedPnl + unrealizedPnl) * 100) / 100,
    byStatus: {
      inventory: rows.filter(t => t.status === 'inventory').length,
      grading:   rows.filter(t => t.status === 'grading').length,
      sold:      rows.filter(t => t.status === 'sold').length,
    },
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Watchlist / Players
// ────────────────────────────────────────────────────────────────────────────

// GET /api/players
router.get('/players', (req, res) => {
  const db = getDb();
  const players = db.prepare(`
    SELECT p.*,
      COUNT(DISTINCT ct.id) as target_count,
      COUNT(DISTINCT fe.id) as fmv_count,
      COUNT(DISTINCT CASE WHEN ct.buy_threshold_usd IS NOT NULL THEN ct.id END) as override_count,
      MIN(ct.buy_threshold_usd) as min_threshold_override
    FROM players p
    LEFT JOIN card_targets ct ON ct.player_id=p.id AND ct.active=1
    LEFT JOIN fmv_estimates fe ON fe.player_id=p.id
    GROUP BY p.id
    ORDER BY
      CASE p.sport WHEN 'NFL' THEN 1 WHEN 'NBA' THEN 2 WHEN 'MLB' THEN 3
        WHEN 'Soccer' THEN 4 WHEN 'NHL' THEN 5 ELSE 6 END,
      p.tier DESC, p.name
  `).all();
  res.json(players);
});

// POST /api/players — add player
router.post('/players', (req, res) => {
  const db = getDb();
  const { name, sport, tier } = req.body;
  if (!name || !sport || !tier) return res.status(400).json({ error: 'name, sport, tier required' });

  try {
    const result = db.prepare(
      'INSERT INTO players(name, sport, tier) VALUES(?,?,?)'
    ).run(name, sport, tier);
    res.json({ id: result.lastInsertRowid, name, sport, tier });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Player already exists' });
    throw err;
  }
});

// PATCH /api/players/:id — toggle active or update tier
router.patch('/players/:id', (req, res) => {
  const db = getDb();
  const { active, tier } = req.body;
  db.prepare(`
    UPDATE players SET
      active = COALESCE(?, active),
      tier   = COALESCE(?, tier)
    WHERE id=?
  `).run(active ?? null, tier ?? null, req.params.id);
  res.json({ ok: true });
});

// DELETE /api/players/:id
router.delete('/players/:id', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM players WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// GET /api/players/:id/fmv — all FMV estimates for a player
router.get('/players/:id/fmv', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM fmv_estimates WHERE player_id=? ORDER BY fmv DESC
  `).all(req.params.id);
  res.json(rows);
});

// GET /api/fmv/:id/history — price history for chart
router.get('/fmv/:id/history', (req, res) => {
  const days = parseInt(req.query.days || '30', 10);
  const history = getPriceHistory(req.params.id, days);
  res.json(history);
});

// GET /api/fmv — all FMV estimates (for dashboard summary)
router.get('/fmv', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT fe.*, p.sport, p.tier
    FROM fmv_estimates fe
    JOIN players p ON p.id=fe.player_id
    WHERE fe.fmv IS NOT NULL
    ORDER BY fe.fmv DESC
    LIMIT 200
  `).all();
  res.json(rows);
});

// ────────────────────────────────────────────────────────────────────────────
// Settings
// ────────────────────────────────────────────────────────────────────────────

// GET /api/settings
router.get('/settings', (req, res) => {
  const db = getDb();
  const rows = db.prepare("SELECT key, value FROM settings WHERE key != 'dashboard_password_hash'").all();
  const settings = Object.fromEntries(rows.map(r => [r.key, r.value]));
  res.json(settings);
});

// PATCH /api/settings
router.patch('/settings', (req, res) => {
  const allowed = [
    'max_spend_per_card', 'weekly_spend_cap',
    'max_single_snipe_usd', 'max_blue_chip_snipe_usd', 'min_card_price', 'min_comp_samples',
    'ebay_fvf_pct', 'shipping_cost_usd',
    'blue_chip_threshold', 'standard_threshold',
    'sms_enabled', 'auto_snipe_enabled', 'auto_snipe_auctions', 'scan_active',
  ];
  for (const [key, value] of Object.entries(req.body)) {
    if (allowed.includes(key)) setSetting(key, value);
  }
  res.json({ ok: true });
});

// ────────────────────────────────────────────────────────────────────────────
// Scanner controls
// ────────────────────────────────────────────────────────────────────────────

// POST /api/scanner/scan-now
router.post('/scanner/scan-now', async (req, res) => {
  res.json({ ok: true, message: 'Manual scan triggered' });
  runScanCycle().catch(console.error);
});

// POST /api/scanner/refresh-comps
router.post('/scanner/refresh-comps', async (req, res) => {
  res.json({ ok: true, message: 'Comp refresh triggered' });
  refreshAllComps().catch(console.error);
});

// GET /api/scanner/status
router.get('/scanner/status', (req, res) => {
  const db = getDb();
  const lastDeal = db.prepare('SELECT detected_at FROM deals ORDER BY detected_at DESC LIMIT 1').get();
  const lastFmv  = db.prepare('SELECT last_updated FROM fmv_estimates ORDER BY last_updated DESC LIMIT 1').get();
  const mockMode = process.env.MOCK_SCANNER !== 'false';

  res.json({
    active: getSetting('scan_active') !== 'false',
    mockMode,
    lastScanAt: lastDeal?.detected_at || null,
    lastCompRefresh: lastFmv?.last_updated || null,
    scanIntervalSeconds: parseInt(process.env.SCAN_INTERVAL_SECONDS || '45', 10),
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AI Grader (Phase 2 stub)
// ────────────────────────────────────────────────────────────────────────────

// POST /api/grade-card
router.post('/grade-card', async (req, res) => {
  const { imageUrl, playerName, cardSet } = req.body;
  if (!imageUrl) return res.status(400).json({ error: 'imageUrl required' });

  const result = await gradeCard(imageUrl, { playerName, cardSet });
  if (result === null) {
    return res.status(503).json({
      error: 'Grading unavailable',
      reason: 'Check OPENAI_API_KEY is set and review server logs for details',
    });
  }
  res.json(result);
});

// ────────────────────────────────────────────────────────────────────────────
// Alerts
// ────────────────────────────────────────────────────────────────────────────

// POST /api/alerts/test-sms
router.post('/alerts/test-sms', async (req, res) => {
  const result = await sendTestSms();
  res.json(result);
});

// GET /api/stats — dashboard stats bar
router.get('/stats', (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);

  const dealsToday   = db.prepare(`SELECT COUNT(*) as n FROM deals WHERE DATE(detected_at)=?`).get(today);
  const activeDeals  = db.prepare(`SELECT COUNT(*) as n FROM deals WHERE status IN ('active','sms_pending')`).get();
  const totalCards   = db.prepare(`SELECT COUNT(*) as n FROM transactions`).get();
  const totalPlayers = db.prepare(`SELECT COUNT(*) as n FROM players WHERE active=1`).get();
  const totalFmv     = db.prepare(`SELECT COUNT(*) as n FROM fmv_estimates WHERE fmv IS NOT NULL`).get();

  const weeklyCap         = parseFloat(process.env.WEEKLY_SPEND_CAP_USD    || getSetting('weekly_spend_cap')         || '1000');
  const maxSingleSnipe    = parseFloat(process.env.MAX_SINGLE_SNIPE_USD    || getSetting('max_single_snipe_usd')    || '250');
  const maxBlueChipSnipe  = parseFloat(process.env.MAX_BLUE_CHIP_SNIPE_USD || getSetting('max_blue_chip_snipe_usd') || '500');
  const autoSnipeDbVal    = getSetting('auto_snipe_enabled');
  const autoSnipeEnabled = autoSnipeDbVal != null
    ? autoSnipeDbVal === 'true'
    : (process.env.AUTO_SNIPE_ENABLED || 'false') === 'true';

  res.json({
    dealsToday:      dealsToday.n,
    activeDeals:     activeDeals.n,
    totalCards:      totalCards.n,
    totalPlayers:    totalPlayers.n,
    totalFmvEntries: totalFmv.n,
    weeklySpend:     getWeeklySpend(),
    weeklyCap,
    maxSingleSnipe,
    maxBlueChipSnipe,
    autoSnipeEnabled,
  });
});

module.exports = router;
