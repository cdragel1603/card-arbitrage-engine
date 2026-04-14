'use strict';

const { getDb, getSetting } = require('../db');
const { sendDealAlert, sendSnipeAlert } = require('../alerts/sms');

// ── Apply buy rules to a listing ─────────────────────────────────────────────
// Returns { isDeal, reason, maxBid } or null if no deal.
function evaluateListing({ listing, fmvRow, tier }) {
  if (!fmvRow || !fmvRow.fmv) return null;

  const fmv = fmvRow.fmv;
  const price = listing.price;
  const threshold = tier === 'blue_chip'
    ? parseFloat(getSetting('blue_chip_threshold') || '0.95')
    : parseFloat(getSetting('standard_threshold') || '0.80');

  const minPrice = parseFloat(getSetting('min_card_price') || '100');
  const maxPrice = tier === 'blue_chip'
    ? Infinity
    : parseFloat(getSetting('max_spend_per_card') || '2500');

  if (price < minPrice) return null;
  if (price > maxPrice) return null;

  const targetPrice = fmv * threshold;
  const discountPct = Math.round((1 - price / fmv) * 100);

  if (price > targetPrice) return null;

  return {
    isDeal: true,
    fmv,
    discountPct,
    threshold,
    maxBid: Math.floor(targetPrice * 100) / 100,
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

// ── Process a batch of listings from the scanner ─────────────────────────────
async function processListings(listings) {
  const db = getDb();
  const deals = [];

  for (const listing of listings) {
    // Look up player
    const player = db.prepare('SELECT * FROM players WHERE name=? AND active=1').get(listing.player_name);
    if (!player) continue;

    // Look up FMV
    const fmvRow = db.prepare(`
      SELECT * FROM fmv_estimates
      WHERE player_id=? AND card_set=? AND grade=?
    `).get(player.id, listing.card_set, listing.grade || 'PSA 9');

    const evaluation = evaluateListing({ listing, fmvRow, tier: player.tier });
    if (!evaluation) continue;

    const dealId = saveDeal({
      listing,
      fmv: evaluation.fmv,
      discountPct: evaluation.discountPct,
      playerName: player.name,
    });

    deals.push({ dealId, listing, player, evaluation });

    // Trigger SMS alert based on listing type
    try {
      if (listing.type === 'BIN') {
        await sendDealAlert({
          dealId,
          playerName: player.name,
          cardDescription: listing.description,
          price: listing.price,
          fmv: evaluation.fmv,
          discountPct: evaluation.discountPct,
          source: listing.source || 'eBay',
        });
        db.prepare('UPDATE deals SET sms_sent_at=CURRENT_TIMESTAMP, status=? WHERE id=?')
          .run('sms_pending', dealId);
      } else if (listing.type === 'auction' && listing.auction_end_time) {
        const minsLeft = (new Date(listing.auction_end_time) - Date.now()) / 60000;
        if (minsLeft <= 15) {
          await sendSnipeAlert({
            dealId,
            playerName: player.name,
            cardDescription: listing.description,
            currentBid: listing.price,
            fmv: evaluation.fmv,
            maxBid: evaluation.maxBid,
            minsLeft: Math.round(minsLeft),
          });
          db.prepare('UPDATE deals SET sms_sent_at=CURRENT_TIMESTAMP, status=? WHERE id=?')
            .run('sms_pending', dealId);
        }
      }
    } catch (err) {
      console.error('[DealDetector] SMS error:', err.message);
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

module.exports = { evaluateListing, processListings, expireStaleDeals, saveDeal };
