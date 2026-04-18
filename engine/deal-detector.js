'use strict';

const { getDb, getSetting, checkWeeklySpend } = require('../db');
const { sendDealAlert, sendSnipeAlert } = require('../alerts/sms');
const { gradeCard } = require('./condition-grader');
const urgentWatcher = require('../scanner/urgent-watcher');
const { THRESHOLDS, URGENT_DEAL_WINDOW_HOURS } = require('../config');

// ── Rarity classifier ─────────────────────────────────────────────────────────
// Detects serial-numbered and 1/1 cards from listing title/description.
// Rare cards get relaxed comp-sample requirements.
function classifyRarity(text) {
  const s = String(text || '');

  // 1-of-1 patterns
  if (/\b1\/1\b/.test(s) || /\b1\s+of\s+1\b/i.test(s) || /\bone[\s-]of[\s-]one\b/i.test(s)) {
    return { isRare: true, rarityType: '1/1' };
  }

  // Serial numbered: /35, /50, /99, /100, /150, /199, #/35, etc.
  const serialMatch = s.match(/#?\/(\d{1,4})\b/);
  if (serialMatch) {
    const n = parseInt(serialMatch[1], 10);
    if (n <= 199) {
      return { isRare: true, rarityType: `/${n}`, serialN: n };
    }
  }

  // "numbered" or "serial" keyword
  if (/\bnumbered\b/i.test(s) || /\bserial\s*#/i.test(s)) {
    return { isRare: true, rarityType: 'numbered' };
  }

  return { isRare: false, rarityType: null };
}

// ── Apply buy rules to a listing ─────────────────────────────────────────────
// Returns evaluation object or null if listing doesn't qualify.
// targetRow (optional) — card_targets row; may carry buy_threshold_usd override.
function evaluateListing({ listing, fmvRow, tier, targetRow }) {
  if (!fmvRow || !fmvRow.fmv) return null;

  const fmv   = fmvRow.fmv;
  const price = listing.price;

  // ── Per-card threshold override — explicit entry wins over global formula ──
  if (targetRow?.buy_threshold_usd != null) {
    const override = targetRow.buy_threshold_usd;
    if (price > override) {
      console.log(`[DealDetector] Skip (override threshold $${override}): $${price} — ${listing.description}`);
      return null;
    }
    const discountPct = Math.round((1 - price / fmv) * 100);
    console.log(`[DealDetector] Override threshold matched ($${price} ≤ $${override}): ${listing.description}`);
    return {
      isDeal: true,
      fmv,
      netFmv: null,
      discountPct,
      netDiscountPct: null,
      targetPrice: override,
      maxBid: override,
      rarity: classifyRarity(listing.title || listing.description),
      lowConfidenceFmv: false,
      thresholdOverride: override,
    };
  }

  // ── Guardrail 1: Tier-based snipe cap ────────────────────────────────────
  // Blue chip → MAX_BLUE_CHIP_SNIPE_USD (default $500)
  // Standard  → MAX_SINGLE_SNIPE_USD    (default $250)
  // Per-card override (above) already returned early, so we never reach here with one set.
  const snipeCap = tier === 'blue_chip'
    ? parseFloat(getSetting('max_blue_chip_snipe_usd') || process.env.MAX_BLUE_CHIP_SNIPE_USD || '500')
    : parseFloat(getSetting('max_single_snipe_usd')    || process.env.MAX_SINGLE_SNIPE_USD    || '250');
  if (price > snipeCap) {
    console.log(`[DealDetector] Skip (${tier} cap $${snipeCap}): $${price} — ${listing.description}`);
    return null;
  }

  // ── Min / max price bounds ─────────────────────────────────────────────────
  const minPrice = parseFloat(getSetting('min_card_price') || '100');
  const maxPrice = tier === 'blue_chip'
    ? Infinity
    : parseFloat(getSetting('max_spend_per_card') || '2500');

  if (price < minPrice) return null;
  if (price > maxPrice) return null;

  // ── Guardrail 4: Grade-aware deal math ───────────────────────────────────
  // PSA 10 slabs: relaxed thresholds because high-grade slabs carry a premium
  //   and are easier to flip — blue chip ≤95% FMV, standard ≤90% FMV.
  // Everything else: must be ≤80% of net FMV (after eBay fees + shipping).
  const ebayFvfPct      = parseFloat(getSetting('ebay_fvf_pct')      || process.env.EBAY_FVF_PCT      || '0.13');
  const shippingCostUsd = parseFloat(getSetting('shipping_cost_usd') || process.env.SHIPPING_COST_USD || '5');
  const netFmv          = fmv * (1 - ebayFvfPct) - shippingCostUsd;

  const isPsa10 = /^PSA\s*10$/i.test(String(listing.grade || '').trim());
  let targetPrice;
  if (isPsa10) {
    const psa10Ratio = tier === 'blue_chip'
      ? (THRESHOLDS.psa10_blue_chip || 0.95)
      : (THRESHOLDS.psa10_standard  || 0.90);
    targetPrice = fmv * psa10Ratio;
  } else {
    targetPrice = netFmv * 0.80;
  }

  if (price > targetPrice) return null;

  const discountPct    = Math.round((1 - price / fmv)    * 100);
  const netDiscountPct = Math.round((1 - price / netFmv) * 100);

  // ── Guardrail 3: Comp sample size with rarity exception ──────────────────
  const minCompSamples = parseInt(getSetting('min_comp_samples') || process.env.MIN_COMP_SAMPLES || '5', 10);
  const rarity = classifyRarity(listing.title || listing.description);
  let lowConfidenceFmv = false;

  if ((fmvRow.sample_count || 0) < minCompSamples) {
    if (!rarity.isRare) {
      console.log(
        `[DealDetector] Skip (${fmvRow.sample_count || 0} comps < ${minCompSamples} min, not serial): ` +
        listing.description
      );
      return null;
    }
    // Serial/rare card — relax comp requirement, flag as low confidence
    lowConfidenceFmv = true;
    console.log(
      `[DealDetector] Rare (${rarity.rarityType}) — ${fmvRow.sample_count || 0} comp(s) used as low-confidence FMV: ` +
      listing.description
    );
  }

  return {
    isDeal: true,
    fmv,
    netFmv: Math.round(netFmv * 100) / 100,
    discountPct,
    netDiscountPct,
    targetPrice: Math.floor(targetPrice * 100) / 100,
    maxBid: Math.floor(targetPrice * 100) / 100,
    rarity,
    lowConfidenceFmv,
  };
}

// ── Save a confirmed deal to DB ───────────────────────────────────────────────
function saveDeal({ listing, fmv, discountPct, playerName }) {
  const db = getDb();

  // Deduplicate by listing_id
  if (listing.listing_id) {
    const existing = db.prepare('SELECT id FROM deals WHERE listing_id=?').get(listing.listing_id);
    if (existing) return existing.id;
  }

  const result = db.prepare(`
    INSERT INTO deals(
      player_name, card_description, listing_url, listing_id,
      listing_price, fmv, discount_pct, source, listing_type,
      auction_end_time, grade, image_url, status
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'active')
  `).run(
    playerName,
    listing.description,
    listing.url,
    listing.listing_id || null,
    listing.price,
    fmv,
    discountPct,
    listing.source || 'ebay',
    listing.type,
    listing.auction_end_time || null,
    listing.grade || null,
    listing.image_url || null,
  );

  return result.lastInsertRowid;
}

// ── Guardrail 6: Run AI vision grading — raw cards only ──────────────────────
// Skips slabbed cards (PSA/BGS/SGC/CGC/HGA/GRADED/SLAB keywords in title).
// Returns null gracefully if grading fails or is skipped.
async function runGraderIfRaw(db, listing, player, dealId) {
  // Skip if grade field explicitly indicates a known slab
  const gradeStr = String(listing.grade || '').trim();
  const isGraded = gradeStr && !/^raw$/i.test(gradeStr);
  if (isGraded) return null;

  // Guardrail 6: Skip if listing title contains slab-house keywords
  const slabPattern = /\b(PSA|BGS|SGC|CGC|HGA|GRADED|SLAB)\b/i;
  const titleText = String(listing.title || listing.description || '');
  if (slabPattern.test(titleText)) {
    console.log(`[Grader] Skipping slab (title keyword): ${listing.description}`);
    return null;
  }

  if (!listing.image_url) return null;

  const aiGrade = await gradeCard(listing.image_url, {
    playerName: player.name,
    cardSet: listing.card_set,
  });

  if (!aiGrade) return null;

  // Persist AI grade on the deal row
  db.prepare(`
    UPDATE deals
    SET ai_grade=?, ai_confidence=?, ai_recommendation=?, ai_details=?
    WHERE id=?
  `).run(
    aiGrade.estimatedGrade,
    aiGrade.confidence,
    aiGrade.recommendation,
    JSON.stringify(aiGrade.details),
    dealId,
  );

  return aiGrade;
}

// ── Guardrail 2: Seller quality filter ───────────────────────────────────────
// Returns null if seller passes, or a string reason if they fail.
const MIN_SELLER_FEEDBACK_PCT   = 99.0;
const MIN_SELLER_FEEDBACK_COUNT = 50;

function checkSellerQuality(listing) {
  const seller = listing.seller;
  if (!seller) return null; // No seller data (mock mode) — pass through

  const { feedbackPercentage, feedbackScore } = seller;

  if (feedbackPercentage != null && feedbackPercentage < MIN_SELLER_FEEDBACK_PCT) {
    return `seller feedback ${feedbackPercentage}% < ${MIN_SELLER_FEEDBACK_PCT}% required`;
  }
  if (feedbackScore != null && feedbackScore < MIN_SELLER_FEEDBACK_COUNT) {
    return `seller feedback count ${feedbackScore} < ${MIN_SELLER_FEEDBACK_COUNT} required`;
  }
  return null; // passes
}

// ── Process a batch of listings from the scanner ─────────────────────────────
async function processListings(listings) {
  const db = getDb();
  const deals = [];

  for (const listing of listings) {
    // Look up player
    const player = db.prepare('SELECT * FROM players WHERE name=? AND active=1').get(listing.player_name);
    if (!player) continue;

    // ── Guardrail 2: Seller quality ───────────────────────────────────────
    const sellerFailReason = checkSellerQuality(listing);
    if (sellerFailReason) {
      console.log(`[DealDetector] Skip (${sellerFailReason}): ${player.name} — ${listing.description}`);
      continue;
    }

    // Look up card target row (may carry per-card buy_threshold_usd override)
    const targetRow = db.prepare(
      'SELECT * FROM card_targets WHERE player_id=? AND card_set=? AND active=1'
    ).get(player.id, listing.card_set);

    // Look up FMV
    const fmvRow = db.prepare(`
      SELECT * FROM fmv_estimates
      WHERE player_id=? AND card_set=? AND grade=?
    `).get(player.id, listing.card_set, listing.grade || 'PSA 9');

    const evaluation = evaluateListing({ listing, fmvRow, tier: player.tier, targetRow });
    if (!evaluation) continue;

    const dealId = saveDeal({
      listing,
      fmv: evaluation.fmv,
      discountPct: evaluation.discountPct,
      playerName: player.name,
    });

    // ── AI condition grading (raw cards only, slab guard inside) ──────────
    const aiGrade = await runGraderIfRaw(db, listing, player, dealId);

    deals.push({ dealId, listing, player, evaluation, aiGrade });

    // ── Weekly spend cap guard ─────────────────────────────────────────────
    const { canSpend: weeklyOk, spent: weeklySpent, cap: weeklyCap } = checkWeeklySpend(listing.price);
    if (!weeklyOk) {
      console.warn(
        `[DealDetector] Weekly spend cap hit ($${weeklySpent.toFixed(0)} / $${weeklyCap.toFixed(0)}), ` +
        `skipping snipe: ${player.name} — ${listing.description} ($${listing.price})`
      );
      continue;
    }

    // ── Trigger SMS alert based on listing type ────────────────────────────
    let smsSent = false;
    try {
      if (listing.type === 'BIN') {
        await sendDealAlert({
          dealId,
          playerName: player.name,
          cardDescription: listing.description,
          price: listing.price,
          fmv: evaluation.fmv,
          netFmv: evaluation.netFmv,
          discountPct: evaluation.discountPct,
          netDiscountPct: evaluation.netDiscountPct,
          lowConfidenceFmv: evaluation.lowConfidenceFmv,
          rarity: evaluation.rarity,
          source: listing.source || 'eBay',
          hasBestOffer: listing.hasBestOffer || false,
          aiGrade,
        });
        db.prepare('UPDATE deals SET sms_sent_at=CURRENT_TIMESTAMP, status=? WHERE id=?')
          .run('sms_pending', dealId);
        smsSent = true;
      } else if (listing.type === 'auction' && listing.auction_end_time) {
        const minsLeft = (new Date(listing.auction_end_time) - Date.now()) / 60000;
        if (minsLeft <= 15) {
          await sendSnipeAlert({
            dealId,
            playerName: player.name,
            cardDescription: listing.description,
            currentBid: listing.price,
            fmv: evaluation.fmv,
            netFmv: evaluation.netFmv,
            maxBid: evaluation.maxBid,
            minsLeft: Math.round(minsLeft),
            lowConfidenceFmv: evaluation.lowConfidenceFmv,
            rarity: evaluation.rarity,
          });
          db.prepare('UPDATE deals SET sms_sent_at=CURRENT_TIMESTAMP, status=? WHERE id=?')
            .run('sms_pending', dealId);
          smsSent = true;
        }
      }
    } catch (err) {
      console.error('[DealDetector] SMS error:', err.message);
    }

    // ── Urgent deal pinning ────────────────────────────────────────────────
    // Pin any deal with an end time within URGENT_DEAL_WINDOW_HOURS for
    // accelerated tiered rechecking (60s / 5 min / 10 min based on time left).
    if (listing.auction_end_time && listing.listing_id) {
      const endTime  = new Date(listing.auction_end_time);
      const hoursLeft = (endTime - Date.now()) / 3_600_000;
      if (hoursLeft > 0 && hoursLeft <= URGENT_DEAL_WINDOW_HOURS) {
        urgentWatcher.pinDeal({
          dealId,
          listingId:       listing.listing_id,
          playerName:      player.name,
          cardDescription: listing.description,
          price:           listing.price,
          fmv:             evaluation.fmv,
          discountPct:     evaluation.discountPct,
          endTime,
          listingType:     listing.type,
          initialSmsSent:  smsSent,
        });
      }
    }
  }

  return deals;
}

// ── Expire old active deals ──────────────────────────────────────────────────
function expireStaleDeals() {
  const db = getDb();
  // Expire BIN deals older than 2 hours, auctions past end time
  db.prepare(`
    UPDATE deals SET status='expired'
    WHERE status IN ('active','sms_pending')
    AND (
      (listing_type='BIN' AND detected_at < datetime('now','-2 hours'))
      OR (listing_type='auction' AND auction_end_time < CURRENT_TIMESTAMP)
    )
  `).run();
}

module.exports = { evaluateListing, processListings, expireStaleDeals, saveDeal, classifyRarity };
