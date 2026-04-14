'use strict';

// ── Arena Club Scanner — Stub ─────────────────────────────────────────────────
//
// Arena Club (arenaclub.com) is a graded card marketplace.
// Phase 2 implementation plan:
//
// 1. Auth: Sign in via email/password, store session cookie.
// 2. Price drops: Poll /api/marketplace/cards?sort=price_drop&since=<timestamp>
//    to find recently price-dropped inventory.
// 3. Search: /api/marketplace/search?q=<player>&grade=PSA+10
// 4. Comp data: Arena Club shows recent sales — can be used to cross-validate eBay FMV.
//
// Arena Club API is not publicly documented; will require reverse-engineering
// their web app or requesting API access from their team.
//
// For now, this module exports stub functions that log intent.

async function scanPriceDrops() {
  console.log('[ArenaClub] STUB — price drop scan not yet implemented');
  return [];
}

async function searchListings(playerName, cardSet, grade) {
  console.log(`[ArenaClub] STUB — would search: "${playerName} ${cardSet} ${grade}"`);
  return [];
}

async function getRecentSales(playerName, cardSet, grade) {
  console.log(`[ArenaClub] STUB — would fetch comps: "${playerName} ${cardSet} ${grade}"`);
  return [];
}

module.exports = { scanPriceDrops, searchListings, getRecentSales };
