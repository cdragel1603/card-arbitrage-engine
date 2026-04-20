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
const { startUrgentWatcher } = require('./urgent-watcher');
const { scanPsa10Candidates, expireOldCandidates } = require('./psa10-hunter');
const { SCAN_PRIORITY } = require('../config');

const MOCK_MODE = process.env.MOCK_SCANNER !== 'false';
// 300s default: gives the rate limiter (4 req/min, 3s floor) time to space out
// 15 searches × 2 calls each = 30 calls before the next cycle begins.
const SCAN_INTERVAL = parseInt(process.env.SCAN_INTERVAL_SECONDS || '300', 10);
const COMP_REFRESH_HOURS = parseInt(process.env.COMP_REFRESH_HOURS || '8', 10);
// Number of search queries per scan cycle. Each query costs 2 API calls (BIN +
// auctions). At 4 req/min with a 3s floor, 15 queries ≈ 90s of actual work —
// comfortably within the 300s cycle window and ≈ 2,160 calls/day (43% of quota).
const SCAN_BATCH_SIZE = parseInt(process.env.SCAN_BATCH_SIZE || '15', 10);
// Tier 1 comp refresh: default 60 min, tunable via TIER1_COMP_REFRESH_INTERVAL_MINUTES
const TIER1_REFRESH_INTERVAL_MS =
  parseInt(process.env.TIER1_COMP_REFRESH_INTERVAL_MINUTES || '60', 10) * 60 * 1000;
// PSA 10 Hunter runs on its own interval — default 15 min, tunable via env.
const PSA10_HUNTER_INTERVAL_MS =
  parseInt(process.env.PSA10_HUNTER_INTERVAL_MINUTES || '15', 10) * 60 * 1000;

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

// ── Comp refresh (3x daily — all tiers) ──────────────────────────────────────
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

// ── Tier 1 comp refresh (hourly) ─────────────────────────────────────────────
async function refreshTier1Comps() {
  if (MOCK_MODE) {
    console.log('[Scheduler] Mock mode — skipping Tier 1 comp refresh');
    return;
  }

  const tier1Names = new Set(SCAN_PRIORITY.tier1);
  console.log(`[Scheduler] Hourly Tier 1 comp refresh — ${tier1Names.size} players`);

  const db = getDb();
  const players = db.prepare('SELECT * FROM players WHERE active=1')
    .all()
    .filter(p => tier1Names.has(p.name));

  for (const player of players) {
    const targets = db.prepare(
      'SELECT * FROM card_targets WHERE player_id=? AND active=1'
    ).all(player.id);

    for (const target of targets) {
      for (const grade of ['PSA 10', 'PSA 9']) {
        await refreshComps(player.id, player.name, target.card_set, grade);
        // acquireRateLimit() inside retryGet already enforces 3s+ between calls
      }
    }
  }
  console.log('[Scheduler] Tier 1 comp refresh complete');
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

  // Urgent deal watcher — tiered fast-recheck for listings ending soon
  startUrgentWatcher();

  // Comp refresh: 3x daily at 6am, 2pm, 10pm (all tiers)
  cron.schedule('0 6,14,22 * * *', refreshAllComps);
  console.log(`[Scheduler] Comp refresh scheduled 3x daily (6am, 2pm, 10pm)`);

  // Tier 1 comp refresh: hourly (tunable via TIER1_COMP_REFRESH_INTERVAL_MINUTES)
  setInterval(refreshTier1Comps, TIER1_REFRESH_INTERVAL_MS);
  const tier1Mins = TIER1_REFRESH_INTERVAL_MS / 60000;
  console.log(`[Scheduler] Tier 1 comp refresh every ${tier1Mins}m (${SCAN_PRIORITY.tier1.length} players: ${SCAN_PRIORITY.tier1.join(', ')})`);

  // Daily summary SMS at 9pm
  cron.schedule('0 21 * * *', sendDailySummaryJob);
  console.log('[Scheduler] Daily summary SMS scheduled at 9pm');

  // Expire stale deals every 5 minutes
  cron.schedule('*/5 * * * *', expireStaleDeals);

  // PSA 10 Hunter — separate job on its own interval (default 15 min)
  if (!MOCK_MODE) {
    setTimeout(async () => {
      await scanPsa10Candidates().catch(err => console.error('[Scheduler] PSA10 Hunter error:', err.message));
      setInterval(async () => {
        await scanPsa10Candidates().catch(err => console.error('[Scheduler] PSA10 Hunter error:', err.message));
      }, PSA10_HUNTER_INTERVAL_MS);
    }, 30_000); // stagger 30s after startup so eBay token is warmed up
    const psa10Mins = PSA10_HUNTER_INTERVAL_MS / 60000;
    console.log(`[Scheduler] PSA 10 Hunter running every ${psa10Mins}m (first run in 30s)`);

    // Expire candidates older than 24h — runs every hour
    cron.schedule('0 * * * *', expireOldCandidates);
  } else {
    console.log('[Scheduler] Mock mode — PSA 10 Hunter skipped');
  }
}

function stopScheduler() {
  if (scanTimeout) {
    clearTimeout(scanTimeout);
    scanTimeout = null;
    console.log('[Scheduler] Stopped');
  }
}

module.exports = { startScheduler, stopScheduler, runScanCycle, refreshAllComps };
