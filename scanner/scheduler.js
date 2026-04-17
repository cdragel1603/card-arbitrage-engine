'use strict';

require('dotenv').config();
const cron = require('node-cron');
const { getDb, getSetting } = require('../db');
const { scanForDeals, refreshComps, validateEbayCredentials } = require('./ebay');
const { scanPriceDrops: arenaClubScan } = require('./arena-club');
const { scanActiveAuctions: altScan } = require('./alt');
const { runMockScan, seedMockFmv } = require('./mock');
const { processListings, expireStaleDeals } = require('../engine/deal-detector');
const { sendDailySummary } = require('../alerts/sms');

const MOCK_MODE = process.env.MOCK_SCANNER !== 'false';
// 300s default: gives the rate limiter (4 req/min, 3s floor) time to space out
// 15 searches × 2 calls each = 30 calls before the next cycle begins.
const SCAN_INTERVAL = parseInt(process.env.SCAN_INTERVAL_SECONDS || '300', 10);
const COMP_REFRESH_HOURS = parseInt(process.env.COMP_REFRESH_HOURS || '8', 10);
// Number of search queries per scan cycle. Each query costs 2 API calls (BIN +
// auctions). At 4 req/min with a 3s floor, 15 queries ≈ 90s of actual work —
// comfortably within the 300s cycle window and ≈ 2,160 calls/day (43% of quota).
const SCAN_BATCH_SIZE = parseInt(process.env.SCAN_BATCH_SIZE || '15', 10);

let scanTimeout = null;
let scanCursor  = 0; // rotates through all (player × target × grade) triples

// ── Main scan loop ────────────────────────────────────────────────────────────
async function runScanCycle() {
  const active = getSetting('scan_active');
  if (active === 'false') {
    console.log('[Scheduler] Scan paused');
    return;
  }

  try {
    if (MOCK_MODE) {
      await runMockScan();
    } else {
      // Real eBay scan — advance cursor so each cycle covers a fresh slice of targets
      const { listings, nextCursor } = await scanForDeals({
        maxSearches: SCAN_BATCH_SIZE,
        cursor: scanCursor,
      });
      scanCursor = nextCursor;
      if (listings.length > 0) {
        await processListings(listings);
      }
      // Arena Club + ALT (stubs for now)
      await arenaClubScan();
      await altScan();
    }

    expireStaleDeals();
  } catch (err) {
    console.error('[Scheduler] Scan cycle error:', err.message);
  }

  // Schedule next scan
  scanTimeout = setTimeout(runScanCycle, SCAN_INTERVAL * 1000);
}

// ── Comp refresh (3x daily) ───────────────────────────────────────────────────
async function refreshAllComps() {
  if (MOCK_MODE) {
    console.log('[Scheduler] Mock mode — skipping live comp refresh');
    return;
  }

  console.log('[Scheduler] Refreshing FMV comps...');
  const db = getDb();
  const players = db.prepare('SELECT * FROM players WHERE active=1').all();

  for (const player of players) {
    const targets = db.prepare(
      'SELECT * FROM card_targets WHERE player_id=? AND active=1'
    ).all(player.id);

    for (const target of targets) {
      for (const grade of ['PSA 10', 'PSA 9']) {
        await refreshComps(player.id, player.name, target.card_set, grade);
        // acquireRateLimit() inside retryGet already enforces 3s+ between calls;
        // no extra sleep needed here.
      }
    }
  }
  console.log('[Scheduler] Comp refresh complete');
}

// ── Daily summary SMS ─────────────────────────────────────────────────────────
async function sendDailySummaryJob() {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);

  const dealsToday = db.prepare(`
    SELECT COUNT(*) as n FROM deals
    WHERE detected_at >= ?
  `).get(`${today}T00:00:00.000Z`);

  const purchased = db.prepare(`
    SELECT * FROM transactions
    WHERE DATE(purchase_date) = ?
  `).all(today);

  await sendDailySummary({
    dealsCount: dealsToday.n,
    purchased,
  });
}

// ── Start all scheduled jobs ──────────────────────────────────────────────────
async function startScheduler() {
  if (MOCK_MODE) {
    console.log('[Scheduler] MOCK MODE — using generated deals (set MOCK_SCANNER=false for live scanning)');
    seedMockFmv();
  } else {
    console.log('[Scheduler] LIVE MODE — validating eBay credentials...');
    await validateEbayCredentials(); // logs result; does not throw on failure
  }

  // Kick off rolling scan loop immediately
  runScanCycle();
  console.log(`[Scheduler] Deal scan running every ${SCAN_INTERVAL}s`);

  // Comp refresh: 3x daily at 6am, 2pm, 10pm
  cron.schedule('0 6,14,22 * * *', refreshAllComps);
  console.log(`[Scheduler] Comp refresh scheduled 3x daily (6am, 2pm, 10pm)`);

  // Daily summary SMS at 9pm
  cron.schedule('0 21 * * *', sendDailySummaryJob);
  console.log('[Scheduler] Daily summary SMS scheduled at 9pm');

  // Expire stale deals every 5 minutes
  cron.schedule('*/5 * * * *', expireStaleDeals);
}

function stopScheduler() {
  if (scanTimeout) {
    clearTimeout(scanTimeout);
    scanTimeout = null;
    console.log('[Scheduler] Stopped');
  }
}

module.exports = { startScheduler, stopScheduler, runScanCycle, refreshAllComps };
