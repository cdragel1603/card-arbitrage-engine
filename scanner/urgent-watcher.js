'use strict';

// ── Urgent Deal Fast-Check System ─────────────────────────────────────────────
// When a deal is detected AND it ends within URGENT_DEAL_WINDOW_HOURS, it gets
// "pinned" here for accelerated re-checking.  A single 60-second loop runs
// continuously; each iteration skips listings that aren't due for a recheck
// based on their current time-remaining tier:
//
//   SLOW   (2 – 8 h left)  → recheck every URGENT_SLOW_INTERVAL_SEC   (default 10 min)
//   MEDIUM (30 min – 2 h)  → recheck every URGENT_MEDIUM_INTERVAL_SEC (default  5 min)
//   FAST   (< 30 min)      → recheck every URGENT_FAST_INTERVAL_SEC   (default 60 sec)
//
// Tier transitions trigger escalation logic:
//   medium → fast  : sends a "🚨 LAST CHANCE" SMS
//
// Reminder logic: if no YES/PASS reply after URGENT_REMINDER_MINUTES, resend.
// Quota cost: 1 Browse API call per pinned item per recheck — very cheap.

require('dotenv').config();
const { getDb }                                      = require('../db');
const { fetchItemById }                              = require('./ebay');
const { sendUrgentReminder, sendLastChanceAlert }    = require('../alerts/sms');
const {
  URGENT_DEAL_WINDOW_HOURS,
  URGENT_SLOW_INTERVAL_SEC,
  URGENT_MEDIUM_INTERVAL_SEC,
  URGENT_FAST_INTERVAL_SEC,
  URGENT_REMINDER_MINUTES,
} = require('../config');

const MOCK_MODE = process.env.MOCK_SCANNER !== 'false';

// ── Tier helpers ──────────────────────────────────────────────────────────────
// Returns 'slow' | 'medium' | 'fast' | null (> 8h, not worth pinning yet)
function getTier(hoursLeft) {
  if (hoursLeft <= 0)         return null;   // already ended
  if (hoursLeft < 0.5)        return 'fast';   // < 30 min
  if (hoursLeft < 2.0)        return 'medium'; // 30 min – 2 h
  if (hoursLeft <= URGENT_DEAL_WINDOW_HOURS) return 'slow'; // 2 – 8 h
  return null; // > 8 h — let normal rotation handle it
}

const TIER_INTERVAL_SEC = {
  slow:   URGENT_SLOW_INTERVAL_SEC,
  medium: URGENT_MEDIUM_INTERVAL_SEC,
  fast:   URGENT_FAST_INTERVAL_SEC,
};

// ── In-memory registry ────────────────────────────────────────────────────────
// Map<listingId, urgentDeal>
const urgentDeals = new Map();

let watchInterval = null;

// ── Pin a deal for urgent monitoring ─────────────────────────────────────────
// Called by deal-detector after a qualifying deal passes all guardrails.
// `initialSmsSent` should be true when sendDealAlert / sendSnipeAlert already
// fired, so the reminder clock starts from now instead of firing immediately.
function pinDeal({
  dealId,
  listingId,
  playerName,
  cardDescription,
  price,
  fmv,
  discountPct,
  endTime,        // Date object or ISO string; required for tier logic
  listingType,
  initialSmsSent = false,
}) {
  if (!listingId || !endTime) return;
  if (urgentDeals.has(String(listingId))) return; // already pinned

  const end       = new Date(endTime);
  const hoursLeft = (end - Date.now()) / 3_600_000;
  const tier      = getTier(hoursLeft);

  if (!tier) return; // > 8 h or already ended — no-op

  urgentDeals.set(String(listingId), {
    dealId,
    listingId:       String(listingId),
    playerName,
    cardDescription,
    price,
    fmv,
    discountPct,
    endTime:         end,
    listingType,
    pinnedAt:        new Date(),
    lastCheckedAt:   null,
    lastSmsSentAt:   initialSmsSent ? new Date() : null,
    lastTier:        tier,
    lastChanceSent:  false,
  });

  console.log(
    `[UrgentWatcher] Pinned #${dealId} (${tier}) — ${playerName} ${cardDescription} ` +
    `$${price} | ${hoursLeft.toFixed(1)}h left`
  );
}

// ── Remove a deal (called by sniper on YES / PASS) ────────────────────────────
function removeDeal(dealId) {
  for (const [key, entry] of urgentDeals.entries()) {
    if (entry.dealId === dealId) {
      urgentDeals.delete(key);
      console.log(`[UrgentWatcher] Removed #${dealId} from urgent list`);
      return;
    }
  }
}

// ── Core check cycle ──────────────────────────────────────────────────────────
async function checkUrgentDeals() {
  if (urgentDeals.size === 0) return;

  const db  = getDb();
  const now = Date.now();
  const reminderMs = URGENT_REMINDER_MINUTES * 60_000;

  console.log(`[UrgentWatcher] Tick — ${urgentDeals.size} pinned deal(s)`);

  for (const [listingId, entry] of urgentDeals.entries()) {
    // ── 1. Expired end time ───────────────────────────────────────────────
    if (entry.endTime && entry.endTime.getTime() < now) {
      console.log(`[UrgentWatcher] #${entry.dealId} end time passed — removing`);
      urgentDeals.delete(listingId);
      continue;
    }

    // ── 2. Check DB status (YES/PASS already handled by sniper) ──────────
    const dbDeal = db.prepare(
      'SELECT status, sms_sent_at FROM deals WHERE id=?'
    ).get(entry.dealId);

    if (!dbDeal || ['purchased', 'passed', 'expired'].includes(dbDeal.status)) {
      console.log(`[UrgentWatcher] #${entry.dealId} status=${dbDeal?.status ?? 'gone'} — removing`);
      urgentDeals.delete(listingId);
      continue;
    }

    // Sync lastSmsSentAt from DB on first check (deal alert fired before pinning)
    if (!entry.lastSmsSentAt && dbDeal.sms_sent_at) {
      entry.lastSmsSentAt = new Date(dbDeal.sms_sent_at);
    }
    // If still null (no prior SMS), fall back to pinnedAt so we don't
    // immediately re-fire before the first reminder window elapses.
    if (!entry.lastSmsSentAt) {
      entry.lastSmsSentAt = entry.pinnedAt;
    }

    // ── 3. Calculate current tier ─────────────────────────────────────────
    const hoursLeft = (entry.endTime.getTime() - now) / 3_600_000;
    const tier = getTier(hoursLeft);

    if (!tier) {
      console.log(`[UrgentWatcher] #${entry.dealId} tier resolved to null — removing`);
      urgentDeals.delete(listingId);
      continue;
    }

    // ── 4. Throttle: skip if not due for recheck yet ──────────────────────
    const intervalMs = TIER_INTERVAL_SEC[tier] * 1_000;
    const sinceLastCheck = entry.lastCheckedAt ? now - entry.lastCheckedAt.getTime() : Infinity;
    if (sinceLastCheck < intervalMs) {
      continue; // not time yet for this tier
    }

    entry.lastCheckedAt = new Date();

    // ── 5. Tier escalation: medium → fast sends LAST CHANCE SMS ──────────
    if (!entry.lastChanceSent && tier === 'fast' && entry.lastTier !== 'fast') {
      const minsLeft = Math.round(hoursLeft * 60);
      console.log(`[UrgentWatcher] #${entry.dealId} entered FAST tier — sending LAST CHANCE`);
      try {
        await sendLastChanceAlert({
          dealId:          entry.dealId,
          playerName:      entry.playerName,
          cardDescription: entry.cardDescription,
          price:           entry.price,
          fmv:             entry.fmv,
          discountPct:     entry.discountPct,
          minsLeft,
        });
        entry.lastChanceSent  = true;
        entry.lastSmsSentAt   = new Date();
        db.prepare("UPDATE deals SET sms_sent_at=CURRENT_TIMESTAMP, status='sms_pending' WHERE id=? AND status NOT IN ('purchased','passed')")
          .run(entry.dealId);
      } catch (err) {
        console.error(`[UrgentWatcher] LAST CHANCE SMS error #${entry.dealId}:`, err.message);
      }
    }

    entry.lastTier = tier;

    // ── 6. eBay live recheck (skip in mock mode) ──────────────────────────
    let currentItem = null;
    if (!MOCK_MODE && entry.listingId) {
      try {
        currentItem = await fetchItemById(entry.listingId);
      } catch (err) {
        console.warn(`[UrgentWatcher] fetchItemById ${entry.listingId}:`, err.message);
      }

      // null = 404 → item sold / ended
      if (currentItem === null) {
        console.log(`[UrgentWatcher] #${entry.dealId} listing gone (404) — removing`);
        urgentDeals.delete(listingId);
        db.prepare("UPDATE deals SET status='expired' WHERE id=? AND status='sms_pending'")
          .run(entry.dealId);
        continue;
      }

      // Update in-memory price if it changed (auctions bid up, BIN delisted)
      if (currentItem.price && currentItem.price !== entry.price) {
        console.log(
          `[UrgentWatcher] #${entry.dealId} price updated $${entry.price} → $${currentItem.price}`
        );
        entry.price = currentItem.price;
      }
    }

    // ── 7. Reminder: resend if no reply after URGENT_REMINDER_MINUTES ─────
    const msSinceLastSms = now - entry.lastSmsSentAt.getTime();
    if (msSinceLastSms >= reminderMs) {
      console.log(
        `[UrgentWatcher] #${entry.dealId} reminder (${Math.round(msSinceLastSms / 60_000)}min since last SMS)`
      );
      try {
        await sendUrgentReminder({
          dealId:          entry.dealId,
          playerName:      entry.playerName,
          cardDescription: entry.cardDescription,
          price:           currentItem?.price ?? entry.price,
          fmv:             entry.fmv,
          discountPct:     entry.discountPct,
          hoursLeft,
        });
        entry.lastSmsSentAt = new Date();
        db.prepare("UPDATE deals SET sms_sent_at=CURRENT_TIMESTAMP, status='sms_pending' WHERE id=? AND status NOT IN ('purchased','passed')")
          .run(entry.dealId);
      } catch (err) {
        console.error(`[UrgentWatcher] Reminder SMS error #${entry.dealId}:`, err.message);
      }
    }
  }
}

// ── Start / stop ──────────────────────────────────────────────────────────────
// Loop runs at the fast-tier cadence (default 60s) — the slowest tier's
// throttle is enforced per-listing inside checkUrgentDeals().
function startUrgentWatcher() {
  if (watchInterval) return;

  console.log(
    `[UrgentWatcher] Started — tiers: slow=${URGENT_SLOW_INTERVAL_SEC}s, ` +
    `medium=${URGENT_MEDIUM_INTERVAL_SEC}s, fast=${URGENT_FAST_INTERVAL_SEC}s, ` +
    `reminder=${URGENT_REMINDER_MINUTES}min`
  );
  watchInterval = setInterval(checkUrgentDeals, URGENT_FAST_INTERVAL_SEC * 1_000);
}

function stopUrgentWatcher() {
  if (watchInterval) {
    clearInterval(watchInterval);
    watchInterval = null;
    console.log('[UrgentWatcher] Stopped');
  }
}

function getUrgentDeals() {
  return Array.from(urgentDeals.values()).map(e => ({
    dealId:          e.dealId,
    listingId:       e.listingId,
    playerName:      e.playerName,
    cardDescription: e.cardDescription,
    price:           e.price,
    fmv:             e.fmv,
    discountPct:     e.discountPct,
    endTime:         e.endTime,
    tier:            getTier((e.endTime.getTime() - Date.now()) / 3_600_000),
    lastChanceSent:  e.lastChanceSent,
    pinnedAt:        e.pinnedAt,
  }));
}

module.exports = {
  pinDeal,
  removeDeal,
  startUrgentWatcher,
  stopUrgentWatcher,
  getUrgentDeals,
};
