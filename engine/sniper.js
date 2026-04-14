'use strict';

// ── Auto-Snipe System ─────────────────────────────────────────────────────────
// Phase 1: SMS alert + manual confirmation for BINs.
// Phase 2: Will use eBay Offer API (gated access required) for true auto-buy.
//
// eBay Offer API notes:
//   - POST /buy/offer/v1_beta/bidding/{itemId}/place_proxy_bid  (auction)
//   - POST /buy/order/v1/guest_purchase_order                    (BIN)
//   - Requires eBay approval: https://developer.ebay.com/my/keys
//   - Apply for "Buy APIs" access at developer.ebay.com

const axios = require('axios');
const { getDb, getSetting, checkDailySpend, recordSpend, checkWeeklySpend } = require('../db');
const { getEbayToken } = require('../scanner/ebay');

// ── Guardrail 5: Auto-snipe gate ─────────────────────────────────────────────
function isAutoSnipeEnabled() {
  // Prefer live DB setting so Connor can flip it in Settings without a redeploy.
  const dbVal = getSetting('auto_snipe_enabled');
  if (dbVal != null) return dbVal === 'true';
  return (process.env.AUTO_SNIPE_ENABLED || 'false') === 'true';
}

// ── Guardrail 1: Per-card cap check ─────────────────────────────────────────
function checkSingleSnipeCap(amount) {
  const cap = parseFloat(getSetting('max_single_snipe_usd') || process.env.MAX_SINGLE_SNIPE_USD || '250');
  return { cap, canSnipe: amount <= cap };
}

// ── Place proxy bid on eBay auction ─────────────────────────────────────────
// NOTE: Requires eBay Offer API access (apply separately from Browse API).
async function placeProxyBid(itemId, maxBid, { dryRun = false } = {}) {
  // Guardrail 5: auto-snipe must be explicitly enabled
  if (!isAutoSnipeEnabled()) {
    console.log('[Sniper] Auto-snipe disabled (AUTO_SNIPE_ENABLED=false). Skipping proxy bid.');
    return { success: false, reason: 'Auto-snipe disabled — set AUTO_SNIPE_ENABLED=true to enable.' };
  }

  if (dryRun) {
    console.log(`[Sniper] DRY RUN — would bid $${maxBid} on ${itemId}`);
    return { success: true, dryRun: true, itemId, maxBid };
  }

  // Guardrail 1: per-card cap
  const { canSnipe, cap: snipeCap } = checkSingleSnipeCap(maxBid);
  if (!canSnipe) {
    return { success: false, reason: `Per-card cap $${snipeCap} exceeded ($${maxBid})` };
  }

  const { canSpend } = checkDailySpend(maxBid);
  if (!canSpend) {
    return { success: false, reason: 'Daily spend limit reached' };
  }

  const { canSpend: weeklyOk, spent: weeklySpent, cap: weeklyCap } = checkWeeklySpend(maxBid);
  if (!weeklyOk) {
    console.warn(`[Sniper] Weekly spend cap hit ($${weeklySpent.toFixed(0)} / $${weeklyCap.toFixed(0)}), skipping snipe`);
    return { success: false, reason: `Weekly spend cap hit ($${weeklySpent.toFixed(0)} / $${weeklyCap.toFixed(0)})` };
  }

  // Phase 2 implementation — Offer API not yet approved
  // const token = await getEbayToken();
  // const res = await axios.post(
  //   `https://api.ebay.com/buy/offer/v1_beta/bidding/${itemId}/place_proxy_bid`,
  //   { maxAmount: { value: String(maxBid), currency: 'USD' } },
  //   { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  // );
  // recordSpend(maxBid);
  // return { success: true, data: res.data };

  return {
    success: false,
    reason: 'eBay Offer API access pending approval. Visit developer.ebay.com to apply.',
    phase: 2,
  };
}

// ── Execute BIN purchase ─────────────────────────────────────────────────────
// Called after Connor replies YES to SMS alert.
async function executeBinPurchase(dealId, { dryRun = false } = {}) {
  const db = getDb();
  const deal = db.prepare('SELECT * FROM deals WHERE id=?').get(dealId);
  if (!deal) return { success: false, reason: 'Deal not found' };
  if (deal.status !== 'sms_pending') return { success: false, reason: `Deal status: ${deal.status}` };

  if (dryRun) {
    console.log(`[Sniper] DRY RUN — would buy ${deal.card_description} for $${deal.listing_price}`);
    return { success: true, dryRun: true, deal };
  }

  // Guardrail 1: per-card cap (re-checked at execution time)
  const { canSnipe, cap: snipeCap } = checkSingleSnipeCap(deal.listing_price);
  if (!canSnipe) {
    db.prepare("UPDATE deals SET status='passed' WHERE id=?").run(dealId);
    return { success: false, reason: `Per-card cap $${snipeCap} exceeded ($${deal.listing_price})` };
  }

  const { canSpend } = checkDailySpend(deal.listing_price);
  if (!canSpend) {
    db.prepare("UPDATE deals SET status='passed' WHERE id=?").run(dealId);
    return { success: false, reason: 'Daily spend limit reached' };
  }

  const { canSpend: weeklyOk, spent: weeklySpent, cap: weeklyCap } = checkWeeklySpend(deal.listing_price);
  if (!weeklyOk) {
    console.warn(`[Sniper] Weekly spend cap hit ($${weeklySpent.toFixed(0)} / $${weeklyCap.toFixed(0)}), skipping snipe for deal ${dealId}`);
    db.prepare("UPDATE deals SET status='passed' WHERE id=?").run(dealId);
    return { success: false, reason: `Weekly spend cap hit ($${weeklySpent.toFixed(0)} / $${weeklyCap.toFixed(0)})` };
  }

  // Phase 2: eBay Order API call goes here
  // For now, log the intent and record as purchased (manual follow-through)
  console.log(`[Sniper] ACTION REQUIRED: Open eBay and BIN ${deal.card_description} at $${deal.listing_price}`);
  console.log(`[Sniper] URL: ${deal.listing_url}`);

  db.prepare("UPDATE deals SET status='purchased' WHERE id=?").run(dealId);
  db.prepare(`
    INSERT INTO transactions(
      deal_id, player_name, card_description, purchase_price,
      fmv_at_purchase, discount_pct, source, grade, image_url, current_value
    ) VALUES(?,?,?,?,?,?,?,?,?,?)
  `).run(
    deal.id,
    deal.player_name,
    deal.card_description,
    deal.listing_price,
    deal.fmv,
    deal.discount_pct,
    deal.source,
    deal.grade,
    deal.image_url,
    deal.fmv, // current value starts at FMV
  );

  recordSpend(deal.listing_price);

  return { success: true, deal };
}

// ── Handle SMS reply ─────────────────────────────────────────────────────────
async function handleSmsReply(body, fromNumber) {
  const db = getDb();
  const reply = body.trim().toUpperCase();

  // Find the most recent pending deal (SMS sent in last 30 min)
  const pendingDeal = db.prepare(`
    SELECT * FROM deals
    WHERE status='sms_pending'
      AND sms_sent_at >= datetime('now','-30 minutes')
    ORDER BY sms_sent_at DESC LIMIT 1
  `).get();

  if (!pendingDeal) {
    return { handled: false, message: 'No pending deal found within 30-minute window' };
  }

  if (reply === 'YES') {
    const result = await executeBinPurchase(pendingDeal.id);
    return { handled: true, action: 'purchase', result };
  }

  if (reply === 'STOP' || reply === 'NO') {
    db.prepare("UPDATE deals SET status='passed' WHERE id=?").run(pendingDeal.id);
    return { handled: true, action: 'pass', dealId: pendingDeal.id };
  }

  return { handled: false, message: `Unrecognized reply: ${reply}` };
}

module.exports = { placeProxyBid, executeBinPurchase, handleSmsReply };
