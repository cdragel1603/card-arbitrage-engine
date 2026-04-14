'use strict';

// ── Mock Scanner ─────────────────────────────────────────────────────────────
// Generates realistic-looking fake deals for testing the dashboard UI
// and SMS flow before eBay API credentials are connected.
// Enabled when MOCK_SCANNER=true in .env

const { getDb } = require('../db');
const { processListings } = require('../engine/deal-detector');
const { upsertFmv } = require('../engine/pricing');

// Seed FMV estimates so the deal detector has something to compare against
function seedMockFmv() {
  const db = getDb();
  const players = db.prepare('SELECT * FROM players WHERE active=1').all();

  const mockFmvData = [
    // Blue chips
    { name: 'Shohei Ohtani',     cardSet: 'Topps Chrome Gold Refractor', grade: 'PSA 10', fmv: 2200 },
    { name: 'Shohei Ohtani',     cardSet: 'Topps Chrome Gold Refractor', grade: 'PSA 9',  fmv: 850  },
    { name: 'LeBron James',      cardSet: 'National Treasures RPA',      grade: 'PSA 10', fmv: 8500 },
    { name: 'Michael Jordan',    cardSet: 'Flawless',                    grade: 'PSA 10', fmv: 5200 },
    { name: 'Stephen Curry',     cardSet: 'Prizm Silver',                grade: 'PSA 10', fmv: 1800 },
    { name: 'Victor Wembanyama', cardSet: 'Prizm Silver',                grade: 'PSA 10', fmv: 3200 },
    { name: 'Cooper Flagg',      cardSet: 'Prizm Silver',                grade: 'PSA 10', fmv: 1200 },
    { name: 'Patrick Mahomes',   cardSet: 'National Treasures RPA',      grade: 'PSA 10', fmv: 4500 },
    { name: 'Connor McDavid',    cardSet: 'The Cup RPA',                 grade: 'PSA 10', fmv: 3800 },
    // Standard
    { name: 'Caleb Williams',    cardSet: 'Prizm Silver',                grade: 'PSA 9',  fmv: 420  },
    { name: 'Caleb Williams',    cardSet: 'Kaboom',                      grade: 'PSA 9',  fmv: 680  },
    { name: 'Caleb Williams',    cardSet: 'Kaboom',                      grade: 'PSA 10', fmv: 1100 },
    { name: 'Jaxson Dart',       cardSet: 'Prizm Silver',                grade: 'PSA 9',  fmv: 180  },
    { name: 'Josh Allen',        cardSet: 'National Treasures RPA',      grade: 'PSA 10', fmv: 2800 },
    { name: 'Lamar Jackson',     cardSet: 'Kaboom',                      grade: 'PSA 10', fmv: 920  },
    { name: 'Jayden Daniels',    cardSet: 'Prizm Silver',                grade: 'PSA 9',  fmv: 320  },
    { name: 'Drake Maye',        cardSet: 'Prizm Silver',                grade: 'PSA 9',  fmv: 290  },
    { name: 'Anthony Edwards',   cardSet: 'Prizm Silver',                grade: 'PSA 10', fmv: 980  },
    { name: 'Luka Doncic',       cardSet: 'National Treasures RPA',      grade: 'PSA 10', fmv: 3600 },
    { name: 'Ja Morant',         cardSet: 'Select Tie-Dye',              grade: 'PSA 10', fmv: 750  },
    { name: 'Aaron Judge',       cardSet: 'Topps Chrome Gold Refractor', grade: 'PSA 10', fmv: 1400 },
    { name: 'Gunnar Henderson',  cardSet: 'Bowman Chrome 1st',           grade: 'PSA 10', fmv: 380  },
    { name: 'Paul Skenes',       cardSet: 'Bowman Chrome 1st',           grade: 'PSA 10', fmv: 520  },
    { name: 'Elly De La Cruz',   cardSet: 'Topps Chrome Superfractor',   grade: 'PSA 10', fmv: 890  },
    { name: 'Lionel Messi',      cardSet: 'Prizm World Cup',             grade: 'PSA 10', fmv: 2100 },
    { name: 'Lamine Yamal',      cardSet: 'Topps Chrome UCL',            grade: 'PSA 10', fmv: 680  },
    { name: 'Connor Bedard',     cardSet: 'Young Guns',                  grade: 'PSA 10', fmv: 1600 },
    { name: 'Macklin Celebrini', cardSet: 'Young Guns',                  grade: 'PSA 9',  fmv: 420  },
    { name: 'Cale Makar',        cardSet: 'The Cup RPA',                 grade: 'PSA 10', fmv: 2200 },
  ];

  for (const item of mockFmvData) {
    const player = players.find(p => p.name === item.name);
    if (!player) continue;

    // Generate realistic comp history
    const comps = generateMockComps(item.fmv, 10);
    upsertFmv({
      playerId: player.id,
      playerName: player.name,
      cardSet: item.cardSet,
      grade: item.grade,
      comps,
      source: 'mock',
    });
  }

  console.log('[Mock] Seeded FMV estimates');
}

function generateMockComps(fmv, count = 10) {
  const comps = [];
  const now = Date.now();
  const dayMs = 86400000;

  for (let i = 0; i < count; i++) {
    // Random variance ±15%
    const variance = 1 + (Math.random() * 0.30 - 0.15);
    const price = Math.round(fmv * variance * 100) / 100;
    const daysAgo = Math.floor(Math.random() * 30) + 1;
    comps.push({
      price,
      sale_date: new Date(now - daysAgo * dayMs).toISOString(),
      listing_id: `mock_${Date.now()}_${i}`,
    });
  }
  return comps;
}

// ── Generate a mock deal listing ─────────────────────────────────────────────
function generateMockDeal() {
  const db = getDb();
  const fmvRows = db.prepare(`
    SELECT fe.*, p.tier, p.name as player_name
    FROM fmv_estimates fe
    JOIN players p ON p.id = fe.player_id
    WHERE fe.fmv IS NOT NULL AND p.active=1
    ORDER BY RANDOM() LIMIT 1
  `).get();

  if (!fmvRows) return null;

  const tier = fmvRows.tier;
  const threshold = tier === 'blue_chip' ? 0.92 : 0.76;
  // Price somewhere between 60% and threshold*100% of FMV
  const priceFactor = 0.60 + Math.random() * (threshold - 0.60);
  const price = Math.round(fmvRows.fmv * priceFactor * 100) / 100;

  const isAuction = Math.random() > 0.6;
  const minsLeft  = isAuction ? Math.floor(Math.random() * 14) + 1 : null;
  const endTime   = isAuction
    ? new Date(Date.now() + minsLeft * 60000).toISOString()
    : null;

  return {
    listing_id: `mock_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    player_name: fmvRows.player_name,
    card_set: fmvRows.card_set,
    grade: fmvRows.grade,
    description: `${fmvRows.player_name} ${fmvRows.card_set} ${fmvRows.grade}`,
    price,
    url: `https://www.ebay.com/itm/mock_${Date.now()}`,
    image_url: null,
    type: isAuction ? 'auction' : 'BIN',
    auction_end_time: endTime,
    source: 'mock_ebay',
  };
}

// ── Run one mock scan cycle ──────────────────────────────────────────────────
async function runMockScan() {
  const count = Math.floor(Math.random() * 3) + 1; // 1-3 deals per scan
  const listings = [];

  for (let i = 0; i < count; i++) {
    const deal = generateMockDeal();
    if (deal) listings.push(deal);
  }

  if (listings.length > 0) {
    const deals = await processListings(listings);
    if (deals.length > 0) {
      console.log(`[Mock] Generated ${deals.length} deal(s)`);
    }
  }
}

module.exports = { seedMockFmv, runMockScan, generateMockDeal };
