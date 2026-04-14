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
  { name: 'Connor McDavid',   sport: 'NHL',     tier: 'blue_chip' },

  // NFL standard
  { name: 'Caleb Williams',   sport: 'NFL',     tier: 'standard' },
  { name: 'Jaxson Dart',      sport: 'NFL',     tier: 'standard' },
  { name: 'Josh Allen',       sport: 'NFL',     tier: 'standard' },
  { name: 'Lamar Jackson',    sport: 'NFL',     tier: 'standard' },
  { name: 'Jayden Daniels',   sport: 'NFL',     tier: 'standard' },
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

  // NHL standard
  { name: 'Macklin Celebrini', sport: 'NHL',    tier: 'blue_chip' },
  { name: 'Matthew Schaefer',  sport: 'NHL',    tier: 'standard' },
  { name: 'Connor Bedard',     sport: 'NHL',    tier: 'blue_chip' },
  { name: 'Cale Makar',        sport: 'NHL',    tier: 'standard' },
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
  ],
  NFL: [
    'Kaboom',
    'Downtown',
    'Prizm Silver',
    'Prizm Gold',
    'Prizm Black',
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

module.exports = { THRESHOLDS, PLAYERS, CARD_TARGETS, SPORT_ORDER, GRADES };
