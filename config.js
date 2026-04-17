'use strict';

// ── Buy thresholds ──────────────────────────────────────────────────────────
const THRESHOLDS = {
  blue_chip: 0.95,        // buy at ≤95% of FMV
  standard: 0.80,         // buy at ≤80% of FMV
  raw_psa10_ratio: 3.0,   // raw card: PSA 10 value must be 3x+ purchase price
  min_price: 100,
  max_price_standard: 2500,
  max_price_blue_chip: Infinity,
  grading_cost: 40,       // average grading cost PSA
  shipping_cost: 7.50,    // average shipping
  ebay_fee_pct: 0.13,     // eBay resale fees
};

// ── Player universe ──────────────────────────────────────────────────────────
const PLAYERS = [
  // Blue chip — buy at ≤95% FMV, no spend ceiling
  { name: 'Shohei Ohtani',    sport: 'MLB',     tier: 'blue_chip' },
  { name: 'LeBron James',     sport: 'NBA',     tier: 'blue_chip' },
  { name: 'Michael Jordan',   sport: 'NBA',     tier: 'blue_chip' },
  { name: 'Stephen Curry',    sport: 'NBA',     tier: 'blue_chip' },
  { name: 'Victor Wembanyama',sport: 'NBA',     tier: 'blue_chip' },
  { name: 'Cooper Flagg',     sport: 'NBA',     tier: 'blue_chip' },
  { name: 'Patrick Mahomes',  sport: 'NFL',     tier: 'blue_chip' },
  { name: 'Tom Brady',        sport: 'NFL',     tier: 'blue_chip' },
  { name: 'Connor McDavid',   sport: 'NHL',     tier: 'blue_chip' },

  // NFL blue chip
  { name: 'Caleb Williams',   sport: 'NFL',     tier: 'blue_chip' },
  { name: 'Bo Nix',           sport: 'NFL',     tier: 'blue_chip' },
  { name: 'Jayden Daniels',   sport: 'NFL',     tier: 'blue_chip' },

  // NFL standard
  { name: 'Jaxson Dart',      sport: 'NFL',     tier: 'standard' },
  { name: 'Josh Allen',       sport: 'NFL',     tier: 'standard' },
  { name: 'Lamar Jackson',    sport: 'NFL',     tier: 'standard' },
  { name: 'Drake Maye',       sport: 'NFL',     tier: 'standard' },

  // NBA standard
  { name: 'Anthony Edwards',  sport: 'NBA',     tier: 'standard' },
  { name: 'Luka Doncic',      sport: 'NBA',     tier: 'standard' },
  { name: 'Ja Morant',        sport: 'NBA',     tier: 'standard' },

  // MLB standard
  { name: 'Aaron Judge',      sport: 'MLB',     tier: 'standard' },
  { name: 'Gunnar Henderson', sport: 'MLB',     tier: 'standard' },
  { name: 'Paul Skenes',      sport: 'MLB',     tier: 'standard' },
  { name: 'Elly De La Cruz',  sport: 'MLB',     tier: 'standard' },
  { name: 'Jackson Merrill',  sport: 'MLB',     tier: 'standard' },

  // Soccer standard
  { name: 'Lionel Messi',     sport: 'Soccer',  tier: 'standard' },
  { name: 'Cristiano Ronaldo',sport: 'Soccer',  tier: 'standard' },
  { name: 'Jude Bellingham',  sport: 'Soccer',  tier: 'standard' },
  { name: 'Kylian Mbappe',    sport: 'Soccer',  tier: 'standard' },
  { name: 'Lamine Yamal',     sport: 'Soccer',  tier: 'standard' },

  // NHL blue chip
  { name: 'Macklin Celebrini', sport: 'NHL',    tier: 'blue_chip' },
  { name: 'Connor Bedard',     sport: 'NHL',    tier: 'blue_chip' },
  { name: 'Matthew Schaefer',  sport: 'NHL',    tier: 'blue_chip' },
  { name: 'Cale Makar',        sport: 'NHL',    tier: 'blue_chip' },
  { name: 'Nathan MacKinnon',  sport: 'NHL',    tier: 'blue_chip' },

  // NHL standard
  { name: 'Auston Matthews',   sport: 'NHL',    tier: 'standard' },
  { name: 'Leon Draisaitl',    sport: 'NHL',    tier: 'standard' },
  { name: 'Kirill Kaprizov',   sport: 'NHL',    tier: 'standard' },
  { name: 'Sidney Crosby',     sport: 'NHL',    tier: 'standard' },
  { name: 'Matthew Tkachuk',   sport: 'NHL',    tier: 'standard' },
  { name: 'Quinn Hughes',      sport: 'NHL',    tier: 'standard' },
  { name: 'Jack Hughes',       sport: 'NHL',    tier: 'standard' },
  { name: 'Adam Fantilli',     sport: 'NHL',    tier: 'standard' },
  { name: 'Patrick Kane',      sport: 'NHL',    tier: 'standard' },
];

// ── Card targets by sport ────────────────────────────────────────────────────
// Each entry drives eBay search term construction.
const CARD_TARGETS = {
  NHL: [
    'Young Guns',
    'The Cup RPA',
    'Future Watch Auto',
    'Upper Deck Premier Rookie Patch Auto',
    'SPx Rookie Jersey Auto',
    'Upper Deck Premier Auto',
    'Draft Day Marks',
  ],
  NFL: [
    'Kaboom',
    'Downtown',
    'Prizm base',
    'Prizm Silver',
    'Prizm Gold',
    'Prizm Black',
    'Optic base',
    'Optic Holo',
    'Donruss Rated Rookie',
    'National Treasures RPA',
    'Flawless RPA',
    'Immaculate',
    'Spectra',
  ],
  NBA: [
    'Kaboom',
    'Downtown',
    'Prizm Silver',
    'Prizm Gold',
    'National Treasures RPA',
    'Flawless',
    'Court Kings',
    'Select Tie-Dye',
  ],
  MLB: [
    'Topps Chrome Gold Refractor',
    'Topps Chrome Superfractor',
    'Bowman Chrome 1st',
    'Sterling RPA',
    'Museum Collection',
    'Topps Luminaries',
  ],
  Soccer: [
    'Prizm World Cup',
    'Topps Chrome UCL',
    'National Treasures',
    'Immaculate',
    'Select',
  ],
  Pokemon: [
    'PSA 10',
    'Alt Art',
    'Gold Star',
    'WOTC Holo',
  ],
};

// ── Sport priority order ─────────────────────────────────────────────────────
const SPORT_ORDER = ['NFL', 'NBA', 'MLB', 'Soccer', 'NHL', 'Pokemon'];

// ── Grades we track ──────────────────────────────────────────────────────────
const GRADES = ['PSA 10', 'PSA 9', 'PSA 8', 'BGS 9.5', 'BGS 9', 'SGC 10', 'SGC 9', 'RAW'];

// ── Scan priority tiers ───────────────────────────────────────────────────────
// Tier 1: scanned 3x per rotation cycle
// Tier 2: scanned 2x per rotation cycle
// Tier 3 (everyone else): scanned 1x (normal)
const SCAN_PRIORITY = {
  tier1: [
    'Patrick Mahomes', 'Victor Wembanyama', 'LeBron James', 'Shohei Ohtani',
    'Michael Jordan', 'Tom Brady', 'Connor McDavid', 'Macklin Celebrini',
    'Nathan MacKinnon', 'Caleb Williams', 'Cooper Flagg', 'Bo Nix', 'Jayden Daniels',
  ],
  tier2: [
    'Josh Allen', 'Lamar Jackson', 'Stephen Curry',
    'Luka Doncic', 'Anthony Edwards', 'Aaron Judge',
    'Connor Bedard', 'Cale Makar', 'Matthew Schaefer',
  ],
};

// ── Urgent deal watcher ───────────────────────────────────────────────────────
// Tiered recheck intervals based on time remaining:
//   SLOW  (2–8h left)  : URGENT_SLOW_INTERVAL_SEC   default 600  (10 min)
//   MEDIUM (30min–2h)  : URGENT_MEDIUM_INTERVAL_SEC default 300  (5 min)
//   FAST   (<30 min)   : URGENT_FAST_INTERVAL_SEC   default 60   (60 sec — near real-time)
//   > 8 hours left     : not pinned, normal rotation handles it
//
// URGENT_DEAL_WINDOW_HOURS  — pin anything ending within N hours (default 8)
// URGENT_REMINDER_MINUTES   — resend SMS if no YES/PASS reply after N minutes (default 60)
const URGENT_DEAL_WINDOW_HOURS  = parseFloat(process.env.URGENT_DEAL_WINDOW_HOURS      || '8');
const URGENT_SLOW_INTERVAL_SEC  = parseInt(process.env.URGENT_SLOW_INTERVAL_SEC   || '600', 10);
const URGENT_MEDIUM_INTERVAL_SEC = parseInt(process.env.URGENT_MEDIUM_INTERVAL_SEC || '300', 10);
const URGENT_FAST_INTERVAL_SEC  = parseInt(process.env.URGENT_FAST_INTERVAL_SEC   || '60',  10);
const URGENT_REMINDER_MINUTES   = parseInt(process.env.URGENT_REMINDER_MINUTES    || '60',  10);

module.exports = {
  THRESHOLDS, PLAYERS, CARD_TARGETS, SPORT_ORDER, GRADES, SCAN_PRIORITY,
  URGENT_DEAL_WINDOW_HOURS,
  URGENT_SLOW_INTERVAL_SEC, URGENT_MEDIUM_INTERVAL_SEC, URGENT_FAST_INTERVAL_SEC,
  URGENT_REMINDER_MINUTES,
};
