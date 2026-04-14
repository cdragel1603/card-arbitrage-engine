'use strict';

// ── ALT Scanner — Stub ────────────────────────────────────────────────────────
//
// ALT (alt.com) is a trading card auction/marketplace platform.
// Phase 2 implementation plan:
//
// 1. ALT has a public API: https://api.alt.com/v1/
//    - GET /auctions?status=active&ending_soon=true
//    - GET /auctions?player=<name>&grade=<grade>
//    - GET /sales?player=<name>  (for comps)
// 2. Auth: Bearer token via API key (request at alt.com/developers)
// 3. Auctions ending soon: poll /auctions?ending_within_minutes=15
// 4. Price feed: ALT shows live auction prices — good real-time signal
//
// ALT's auction format is different from eBay:
//   - 24h auctions with auto-extend if bid in last 5min
//   - No proxy bids — must place bids manually or via API
//
// TODO: Request ALT API access at alt.com/developers

async function scanActiveAuctions() {
  console.log('[ALT] STUB — auction scan not yet implemented');
  return [];
}

async function searchListings(playerName, cardSet, grade) {
  console.log(`[ALT] STUB — would search: "${playerName} ${cardSet} ${grade}"`);
  return [];
}

async function getRecentSales(playerName, cardSet, grade) {
  console.log(`[ALT] STUB — would fetch comps: "${playerName} ${cardSet} ${grade}"`);
  return [];
}

module.exports = { scanActiveAuctions, searchListings, getRecentSales };
