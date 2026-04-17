'use strict';

require('dotenv').config();
const axios = require('axios');
const { getDb } = require('../db');
const { upsertFmv } = require('../engine/pricing');
const { PLAYERS, CARD_TARGETS } = require('../config');

const IS_SANDBOX = process.env.EBAY_ENVIRONMENT === 'sandbox';
const BASE_URL = IS_SANDBOX
  ? 'https://api.sandbox.ebay.com'
  : 'https://api.ebay.com';

let tokenCache = { token: null, expiresAt: 0 };

// ── Global rate limiter ───────────────────────────────────────────────────────
// eBay individual developer accounts cap out at ~5,000 Finding API calls/day.
// We budget 4,000 (80%) to leave room for auth + comp-refresh traffic.
//
// Two levers:
//   EBAY_RATE_LIMIT_PER_MIN  – rolling per-minute cap   (default: 4 → 5,760/day)
//   EBAY_MIN_DELAY_MS        – hard floor between calls  (default: 3,000 ms)
//
// Every eBay HTTP call goes through acquireRateLimit() inside retryGet, so
// the budget is shared across scan cycles, comp refreshes, and auth calls.
const RATE_LIMIT_PER_MIN = parseInt(process.env.EBAY_RATE_LIMIT_PER_MIN || '4', 10);
const MIN_CALL_DELAY_MS  = parseInt(process.env.EBAY_MIN_DELAY_MS || '3000', 10);
const _callTimestamps = []; // sliding window of recent request epoch-ms

async function acquireRateLimit() {
  // 1. Enforce minimum spacing between consecutive calls
  if (_callTimestamps.length > 0) {
    const sinceLastCall = Date.now() - _callTimestamps[_callTimestamps.length - 1];
    if (sinceLastCall < MIN_CALL_DELAY_MS) {
      await delay(MIN_CALL_DELAY_MS - sinceLastCall);
    }
  }

  // 2. Enforce rolling per-minute cap (spin until a slot opens)
  for (;;) {
    const windowStart = Date.now() - 60_000;
    while (_callTimestamps.length && _callTimestamps[0] < windowStart) _callTimestamps.shift();

    if (_callTimestamps.length < RATE_LIMIT_PER_MIN) break;

    // Oldest slot in the window — wait for it to roll off + 200ms buffer
    const waitMs = (_callTimestamps[0] + 60_000) - Date.now() + 200;
    console.log(`[eBay] Rate cap ${_callTimestamps.length}/${RATE_LIMIT_PER_MIN} req/min — waiting ${Math.round(waitMs / 1000)}s`);
    await delay(Math.max(200, waitMs));
  }

  _callTimestamps.push(Date.now());
}

// ── HTTP helper with 429 retry/backoff ────────────────────────────────────────
// Every attempt calls acquireRateLimit() first so the global token bucket is
// always respected. On 429 we back off exponentially starting at 30s — the old
// 2s base was far too short and amplified the rate-limit storm in production.
async function retryGet(url, options, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await acquireRateLimit(); // always honour rate limit before any HTTP call
    try {
      return await axios.get(url, options);
    } catch (err) {
      const status = err.response?.status;
      if (status === 429 && attempt < maxRetries) {
        const retryAfter = err.response?.headers?.['retry-after'];
        let waitMs;
        if (retryAfter) {
          // Retry-After can be a delta-seconds integer OR an HTTP-date.
          const asInt = parseInt(retryAfter, 10);
          if (!Number.isNaN(asInt) && String(asInt) === String(retryAfter).trim()) {
            waitMs = asInt * 1000;
          } else {
            const ts = Date.parse(retryAfter);
            waitMs = Number.isNaN(ts) ? 30_000 : Math.max(0, ts - Date.now());
          }
        } else {
          // Exponential backoff: 30s, 60s + ±1.5s jitter.
          // Starting at 30s (not 2s) gives eBay's quota window time to recover.
          waitMs = Math.pow(2, attempt) * 30_000 + Math.floor(Math.random() * 3000 - 1500);
        }
        waitMs = Math.max(30_000, waitMs); // hard floor: never retry faster than 30s
        console.warn(`[eBay] Rate limited (429). Backing off ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${maxRetries})`);
        await delay(waitMs);
        continue;
      }
      throw err;
    }
  }
}

// ── OAuth 2.0 client credentials ─────────────────────────────────────────────
async function getEbayToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60000) {
    return tokenCache.token;
  }

  const clientId     = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;

  if (!clientId || clientId.startsWith('your_')) {
    throw new Error('eBay credentials not configured. Set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET in .env');
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await axios.post(
    `${BASE_URL}/identity/v1/oauth2/token`,
    'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
    {
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );

  tokenCache = {
    token: res.data.access_token,
    expiresAt: Date.now() + res.data.expires_in * 1000,
  };

  return tokenCache.token;
}

// ── Browse API: search active listings ───────────────────────────────────────
async function searchActiveListings(query, opts = {}) {
  const token = await getEbayToken();
  const params = {
    q: query,
    limit: opts.limit || 20,
    sort: opts.sort || 'newlyListed',
    filter: [
      'categoryIds:{212}',      // Sports Trading Cards category
      ...(opts.filters || []),
    ].join(','),
  };

  if (opts.priceTo) params['filter'] += `,price:[..${opts.priceTo}]`;
  if (opts.priceFrom) params['filter'] += `,price:[${opts.priceFrom}..]`;

  const res = await retryGet(`${BASE_URL}/buy/browse/v1/item_summary/search`, {
    headers: { Authorization: `Bearer ${token}` },
    params,
  });

  return (res.data.itemSummaries || []).map(normalizeItem);
}

// ── Browse API: search BIN listings ─────────────────────────────────────────
async function searchBinListings(query, opts = {}) {
  return searchActiveListings(query, {
    ...opts,
    filters: ['buyingOptions:{FIXED_PRICE}', ...(opts.filters || [])],
  });
}

// ── Browse API: search auctions ending soon ──────────────────────────────────
async function searchEndingSoonAuctions(query, opts = {}) {
  return searchActiveListings(query, {
    ...opts,
    sort: 'endingSoonest',
    filters: ['buyingOptions:{AUCTION}', ...(opts.filters || [])],
  });
}

// ── Marketplace Insights API: fetch sold comps ───────────────────────────────
// Requires separate "Marketplace Insights" API access from eBay developer portal.
async function fetchSoldComps(query, opts = {}) {
  const token = await getEbayToken();

  try {
    const res = await retryGet(`${BASE_URL}/buy/marketplace_insights/v1_beta/item_sales/search`, {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        q: query,
        limit: opts.limit || 20,
        filter: 'categoryIds:{212}',
      },
    });

    return (res.data.itemSales || []).map(sale => ({
      price: parseFloat(sale.lastSoldPrice?.value || 0),
      sale_date: sale.lastSoldDate || new Date().toISOString(),
      listing_id: sale.itemId,
      title: sale.title,
    })).filter(c => c.price > 0);
  } catch (err) {
    if (err.response?.status === 403) {
      console.warn('[eBay] Marketplace Insights API not yet approved — using Finding API fallback');
      return fetchSoldCompsFinding(query, opts);
    }
    throw err;
  }
}

// ── Finding API (legacy): fetch completed/sold items ────────────────────────
// Uses App ID (same as Client ID). More widely available than Insights API.
async function fetchSoldCompsFinding(query, opts = {}) {
  const appId = process.env.EBAY_APP_ID || process.env.EBAY_CLIENT_ID;
  if (!appId || appId.startsWith('your_')) {
    return [];
  }

  const res = await retryGet('https://svcs.ebay.com/services/search/FindingService/v1', {
    params: {
      'OPERATION-NAME': 'findCompletedItems',
      'SERVICE-VERSION': '1.13.0',
      'SECURITY-APPNAME': appId,
      'RESPONSE-DATA-FORMAT': 'JSON',
      'keywords': query,
      'categoryId': '212',
      'itemFilter(0).name': 'SoldItemsOnly',
      'itemFilter(0).value': 'true',
      'itemFilter(1).name': 'ListingType',
      'itemFilter(1).value': 'FixedPrice',
      'paginationInput.entriesPerPage': opts.limit || 20,
      'sortOrder': 'EndTimeSoonest',
    },
  });

  const searchResult = res.data?.findCompletedItemsResponse?.[0]?.searchResult?.[0];
  const items = searchResult?.item || [];

  return items.map(item => ({
    price: parseFloat(item.sellingStatus?.[0]?.currentPrice?.[0]?.['__value__'] || 0),
    sale_date: item.listingInfo?.[0]?.endTime?.[0] || new Date().toISOString(),
    listing_id: item.itemId?.[0],
    title: item.title?.[0],
  })).filter(c => c.price > 0);
}

// ── Normalize Browse API item ────────────────────────────────────────────────
function normalizeItem(item) {
  const price   = parseFloat(item.price?.value || item.currentBidPrice?.value || 0);
  const endTime = item.itemEndDate || null;
  const seller  = item.seller || {};

  return {
    listing_id: item.itemId,
    title: item.title,
    price,
    url: item.itemWebUrl || `https://www.ebay.com/itm/${item.itemId}`,
    image_url: item.image?.imageUrl || null,
    type: item.buyingOptions?.includes('FIXED_PRICE') ? 'BIN' : 'auction',
    auction_end_time: endTime,
    source: 'ebay',
    condition: item.condition || null,
    // Guardrail 2: seller quality fields from Browse API
    seller: {
      username:           seller.username           ?? null,
      feedbackPercentage: seller.feedbackPercentage != null ? parseFloat(seller.feedbackPercentage) : null,
      feedbackScore:      seller.feedbackScore      != null ? parseInt(seller.feedbackScore, 10)    : null,
    },
  };
}

// ── Build search query for a player + card type ──────────────────────────────
function buildSearchQuery(playerName, cardSet, grade) {
  const parts = [playerName, cardSet];
  if (grade && grade !== 'RAW') parts.push(grade);
  return parts.join(' ');
}

// ── Refresh FMV comps for a player+card combo ────────────────────────────────
async function refreshComps(playerId, playerName, cardSet, grade) {
  const query = buildSearchQuery(playerName, cardSet, grade);
  console.log(`[eBay] Refreshing comps: "${query}"`);

  try {
    const comps = await fetchSoldComps(query, { limit: 15 });
    if (comps.length === 0) {
      console.log(`[eBay] No comps found for: ${query}`);
      return null;
    }
    const fmv = upsertFmv({ playerId, playerName, cardSet, grade, comps, source: 'ebay' });
    console.log(`[eBay] FMV for "${query}": $${fmv} (${comps.length} comps)`);
    return fmv;
  } catch (err) {
    console.error(`[eBay] Comp refresh failed for "${query}":`, err.message);
    return null;
  }
}

// ── Scan for deals across a rotating batch of the watchlist ──────────────────
// The root cause of the eBay 429 storm: scanning all 213 targets × 2 grades ×
// 2 API calls = 852 calls per cycle against a 5,000/day quota.  At 180s cycle
// intervals that's 409,000 attempted calls per day — every request gets 429'd.
//
// Fix: advance a cursor through the job list each cycle, processing only
// `maxSearches` queries at a time.  acquireRateLimit() inside retryGet handles
// all inter-call pacing — no extra sleep needed in this loop.
//
// Returns { listings, nextCursor } so the scheduler can persist the cursor.
async function scanForDeals({ maxSearches = 15, cursor = 0 } = {}) {
  const db = getDb();
  const players = db.prepare('SELECT * FROM players WHERE active=1').all();

  // Build deterministic job list so the cursor is stable across cycles
  const searchJobs = [];
  for (const player of players) {
    const targets = db.prepare(
      'SELECT * FROM card_targets WHERE player_id=? AND active=1'
    ).all(player.id);
    for (const target of targets) {
      for (const grade of ['PSA 10', 'PSA 9']) {
        searchJobs.push({ player, target, grade });
      }
    }
  }

  const totalJobs = searchJobs.length;
  if (totalJobs === 0) return { listings: [], nextCursor: 0 };

  const startIdx   = cursor % totalJobs;
  const count      = Math.min(maxSearches, totalJobs);
  const nextCursor = (startIdx + count) % totalJobs;

  console.log(`[eBay] Scanning ${count} queries (slot ${startIdx + 1}–${startIdx + count} of ${totalJobs} total)`);

  const listings = [];
  for (let i = 0; i < count; i++) {
    const { player, target, grade } = searchJobs[(startIdx + i) % totalJobs];
    // Honour per-target search_terms override; otherwise build from name + set + grade
    const query = target.search_terms
      ? target.search_terms
      : buildSearchQuery(player.name, target.card_set, grade);
    try {
      // BIN listings (acquireRateLimit is called inside retryGet)
      const bins = await searchBinListings(query, { limit: 10 });
      for (const item of bins) {
        listings.push({
          ...item,
          player_name: player.name,
          card_set: target.card_set,
          grade,
          description: `${player.name} ${target.card_set} ${grade}`,
        });
      }

      // Auctions ending soon (second call — acquireRateLimit enforces spacing)
      const auctions = await searchEndingSoonAuctions(query, { limit: 5 });
      for (const item of auctions) {
        if (!item.auction_end_time) continue;
        const minsLeft = (new Date(item.auction_end_time) - Date.now()) / 60000;
        if (minsLeft <= 15) {
          listings.push({
            ...item,
            player_name: player.name,
            card_set: target.card_set,
            grade,
            description: `${player.name} ${target.card_set} ${grade}`,
          });
        }
      }
    } catch (err) {
      console.error(`[eBay] Scan error for "${query}":`, err.message);
    }
  }

  return { listings, nextCursor };
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Startup credential check ──────────────────────────────────────────────────
async function validateEbayCredentials() {
  const clientId     = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;

  if (!clientId || clientId.startsWith('your_') || !clientSecret || clientSecret.startsWith('your_')) {
    console.error('[eBay] EBAY_CLIENT_ID / EBAY_CLIENT_SECRET are not set. Live scanning will fail.');
    return false;
  }

  try {
    await getEbayToken();
    console.log(`[eBay] Credentials validated OK (${IS_SANDBOX ? 'sandbox' : 'production'})`);
    return true;
  } catch (err) {
    console.error(`[eBay] Credential validation failed: ${err.response?.data?.error_description || err.message}`);
    return false;
  }
}

module.exports = {
  getEbayToken,
  validateEbayCredentials,
  searchActiveListings,
  searchBinListings,
  searchEndingSoonAuctions,
  fetchSoldComps,
  refreshComps,
  scanForDeals,
  buildSearchQuery,
};
