'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcrypt');
const { PLAYERS, CARD_TARGETS, THRESHOLDS } = require('./config');

const DB_PATH = path.join(__dirname, 'cards.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('cache_size = -32000'); // 32MB cache
  }
  return db;
}

function initDb() {
  const db = getDb();

  db.exec(`
    -- ── Players we watch ──────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS players (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      name      TEXT NOT NULL UNIQUE,
      sport     TEXT NOT NULL,
      tier      TEXT NOT NULL CHECK(tier IN ('blue_chip','standard')),
      active    INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ── Card types we watch ───────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS card_targets (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      card_set   TEXT NOT NULL,
      sport      TEXT NOT NULL,
      active     INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ── FMV estimates (one row per player+set+grade combo) ────────────────
    CREATE TABLE IF NOT EXISTS fmv_estimates (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id    INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      player_name  TEXT NOT NULL,
      card_set     TEXT NOT NULL,
      grade        TEXT NOT NULL,
      fmv          REAL,
      sample_count INTEGER DEFAULT 0,
      last_updated DATETIME,
      trend        TEXT CHECK(trend IN ('up','down','stable')) DEFAULT 'stable',
      UNIQUE(player_id, card_set, grade)
    );

    -- ── Raw price comps (sold listings used to calc FMV) ─────────────────
    CREATE TABLE IF NOT EXISTS price_comps (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      fmv_id     INTEGER NOT NULL REFERENCES fmv_estimates(id) ON DELETE CASCADE,
      price      REAL NOT NULL,
      sale_date  DATETIME NOT NULL,
      source     TEXT NOT NULL DEFAULT 'ebay',
      listing_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_price_comps_fmv ON price_comps(fmv_id, sale_date DESC);

    -- ── Detected deals ────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS deals (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      player_name     TEXT NOT NULL,
      card_description TEXT NOT NULL,
      listing_url     TEXT,
      listing_id      TEXT UNIQUE,
      listing_price   REAL NOT NULL,
      fmv             REAL NOT NULL,
      discount_pct    REAL NOT NULL,
      source          TEXT NOT NULL DEFAULT 'ebay',
      listing_type    TEXT NOT NULL CHECK(listing_type IN ('BIN','auction')),
      auction_end_time DATETIME,
      grade           TEXT,
      image_url       TEXT,
      status          TEXT NOT NULL DEFAULT 'active'
                      CHECK(status IN ('active','purchased','expired','passed','sms_pending')),
      sms_sent_at     DATETIME,
      detected_at     DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_deals_status ON deals(status, detected_at DESC);

    -- ── Transactions (bought cards) ───────────────────────────────────────

    CREATE TABLE IF NOT EXISTS transactions (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      deal_id          INTEGER REFERENCES deals(id),
      player_name      TEXT NOT NULL,
      card_description TEXT NOT NULL,
      purchase_price   REAL NOT NULL,
      fmv_at_purchase  REAL NOT NULL,
      discount_pct     REAL NOT NULL,
      source           TEXT NOT NULL,
      grade            TEXT,
      image_url        TEXT,
      purchase_date    DATETIME DEFAULT CURRENT_TIMESTAMP,
      current_value    REAL,
      sold_price       REAL,
      sold_date        DATETIME,
      grading_cost     REAL,
      shipping_cost    REAL,
      status           TEXT NOT NULL DEFAULT 'inventory'
                       CHECK(status IN ('inventory','grading','sold')),
      notes            TEXT
    );

    -- ── App settings ──────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // ── Migrations: add AI grading columns to deals if not present ─────────────
  // ALTER TABLE ADD COLUMN throws if the column already exists, so wrap each.
  const aiCols = [
    'ai_grade TEXT',
    'ai_confidence REAL',
    'ai_recommendation TEXT',
    'ai_details TEXT',
  ];
  for (const colDef of aiCols) {
    try { db.exec(`ALTER TABLE deals ADD COLUMN ${colDef}`); } catch { /* already exists */ }
  }

  // ── Migrations: per-card threshold overrides on card_targets ───────────────
  const targetCols = [
    'buy_threshold_usd REAL',  // explicit buy price override (null = use global net-of-fees rule)
    'search_terms TEXT',        // custom eBay search query (null = auto-build from name+set)
  ];
  for (const colDef of targetCols) {
    try { db.exec(`ALTER TABLE card_targets ADD COLUMN ${colDef}`); } catch { /* already exists */ }
  }

  seedDefaultSettings(db);
  seedWatchlist(db);
  seedCustomTargets(db);

  console.log('[DB] Initialized successfully');
  return db;
}

function seedDefaultSettings(db) {
  const defaults = {
    dashboard_password_hash: bcrypt.hashSync(process.env.DASHBOARD_PASSWORD || 'crazycardz2024', 10),
    max_spend_per_card: String(THRESHOLDS.max_price_standard),
    max_spend_per_day: '5000',
    weekly_spend_cap: String(process.env.WEEKLY_SPEND_CAP_USD || '1000'),
    max_single_snipe_usd: String(process.env.MAX_SINGLE_SNIPE_USD || '250'),
    min_card_price: String(THRESHOLDS.min_price),
    min_comp_samples: String(process.env.MIN_COMP_SAMPLES || '5'),
    ebay_fvf_pct: String(process.env.EBAY_FVF_PCT || '0.13'),
    shipping_cost_usd: String(process.env.SHIPPING_COST_USD || '5'),
    blue_chip_threshold: String(THRESHOLDS.blue_chip),
    standard_threshold: String(THRESHOLDS.standard),
    sms_enabled: 'true',
    auto_snipe_enabled: String(process.env.AUTO_SNIPE_ENABLED || 'false'),
    auto_snipe_auctions: 'true',
    scan_active: 'true',
    daily_spend_today: '0',
    daily_spend_date: new Date().toISOString().slice(0, 10),
  };

  const upsert = db.prepare(`
    INSERT INTO settings(key, value) VALUES(?,?)
    ON CONFLICT(key) DO NOTHING
  `);
  for (const [key, value] of Object.entries(defaults)) {
    upsert.run(key, value);
  }
}

function seedWatchlist(db) {
  const insertPlayer = db.prepare(`
    INSERT INTO players(name, sport, tier) VALUES(?,?,?)
    ON CONFLICT(name) DO NOTHING
  `);
  const insertTarget = db.prepare(`
    INSERT INTO card_targets(player_id, card_set, sport) VALUES(?,?,?)
  `);
  const countTargets = db.prepare(`
    SELECT COUNT(*) as n FROM card_targets WHERE player_id=?
  `);

  for (const player of PLAYERS) {
    insertPlayer.run(player.name, player.sport, player.tier);
    const row = db.prepare('SELECT id FROM players WHERE name=?').get(player.name);
    if (row && countTargets.get(row.id).n === 0) {
      const targets = CARD_TARGETS[player.sport] || [];
      for (const cardSet of targets) {
        insertTarget.run(row.id, cardSet, player.sport);
      }
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getSetting(key) {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  const db = getDb();
  db.prepare(`
    INSERT INTO settings(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
  `).run(key, String(value));
}

function checkDailySpend(amount) {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const storedDate = getSetting('daily_spend_date');

  // Reset if new day
  if (storedDate !== today) {
    setSetting('daily_spend_date', today);
    setSetting('daily_spend_today', '0');
  }

  const spent = parseFloat(getSetting('daily_spend_today') || '0');
  const limit = parseFloat(getSetting('max_spend_per_day') || '5000');
  return { spent, limit, canSpend: spent + amount <= limit };
}

function recordSpend(amount) {
  const { spent } = checkDailySpend(0);
  setSetting('daily_spend_today', String(spent + amount));
}

// ── Custom card target entries with per-card threshold overrides ──────────────
function seedCustomTargets(db) {
  // Matthew Schaefer — SP Game Used Blue Auto
  // FMV ~$500 (manual, hype-driven); buy at ≤$450 (90% FMV, tighter than global rule)
  const schaefer = db.prepare('SELECT id FROM players WHERE name=?').get('Matthew Schaefer');
  if (!schaefer) return;

  const existing = db.prepare(
    'SELECT id FROM card_targets WHERE player_id=? AND card_set=?'
  ).get(schaefer.id, 'SP Game Used Blue Auto');

  if (!existing) {
    db.prepare(
      'INSERT INTO card_targets(player_id, card_set, sport, buy_threshold_usd, search_terms) VALUES(?,?,?,?,?)'
    ).run(
      schaefer.id,
      'SP Game Used Blue Auto',
      'NHL',
      450,
      '"Matthew Schaefer" "SP Game Used" auto blue'
    );
    console.log('[DB] Seeded: Matthew Schaefer — SP Game Used Blue Auto (buy ≤ $450, FMV $500)');
  }

  // Seed manual FMV estimate so deal-detector has something to compare against
  db.prepare(`
    INSERT INTO fmv_estimates(player_id, player_name, card_set, grade, fmv, sample_count, last_updated, trend)
    VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP,'stable')
    ON CONFLICT(player_id, card_set, grade) DO NOTHING
  `).run(schaefer.id, 'Matthew Schaefer', 'SP Game Used Blue Auto', 'RAW', 500, 3);
}

// ── Weekly rolling spend (queries transactions — no counter to reset) ─────────

function getWeeklySpend() {
  const db = getDb();
  const row = db.prepare(`
    SELECT COALESCE(SUM(purchase_price), 0) as total
    FROM transactions
    WHERE purchase_date >= datetime('now', '-7 days')
  `).get();
  return row ? parseFloat(row.total) : 0;
}

function checkWeeklySpend(amount) {
  const cap = parseFloat(process.env.WEEKLY_SPEND_CAP_USD || getSetting('weekly_spend_cap') || '1000');
  const spent = getWeeklySpend();
  return { spent, cap, canSpend: spent + amount <= cap };
}

module.exports = { initDb, getDb, getSetting, setSetting, checkDailySpend, recordSpend, getWeeklySpend, checkWeeklySpend };
