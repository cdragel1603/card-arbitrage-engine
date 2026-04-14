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

  const res = await axios.get(`${BASE_URL}/buy/browse/v1/item_summary/search`, {
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
    const res = await axios.get(`${BASE_URL}/buy/marketplace_insights/v1_beta/item_sales/search`, {
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

  const res = await axios.get('https://svcs.ebay.com/services/search/FindingService/v1', {
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
  const price = parseFloat(item.price?.value || item.currentBidPrice?.value || 0);
  const endTime = item.itemEndDate || null;

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

// ── Scan for deals across the full watchlist ─────────────────────────────────
async function scanForDeals() {
  const db = getDb();
  const players = db.prepare('SELECT * FROM players WHERE active=1').all();
  const listings = [];

  for (const player of players) {
    const targets = db.prepare(
      'SELECT * FROM card_targets WHERE player_id=? AND active=1'
    ).all(player.id);

    for (const target of targets) {
      const grades = ['PSA 10', 'PSA 9'];
      for (const grade of grades) {
        const query = buildSearchQuery(player.name, target.card_set, grade);
        try {
          // Search BIN listings
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

          // Search auctions ending soon
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

          // Small delay to respect rate limits (~5000 calls/day = 1 call per ~17s)
          await delay(200);
        } catch (err) {
          console.error(`[eBay] Scan error for "${query}":`, err.message);
        }
      }
    }
  }

  return listings;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  getEbayToken,
  searchActiveListings,
  searchBinListings,
  searchEndingSoonAuctions,
  fetchSoldComps,
  refreshComps,
  scanForDeals,
  buildSearchQuery,
};
