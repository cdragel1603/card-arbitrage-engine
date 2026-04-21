'use strict';

// ── PSA 10 Hunter — scan raw cards for PSA 10 grading candidates ──────────────
//
// Searches eBay for ungraded/raw cards. Runs GPT-4o Vision on every listing
// image (no price threshold gate). The grading premium (raw → PSA 10) is the
// arbitrage play. Covers NFL 2025 Topps Chrome + NHL Upper Deck Young Guns.
//
// Grade-based alert thresholds:
//   PSA 10 (conf > 0.70): alert at any price up to 100% raw FMV
//   PSA 9  (conf > 0.70): alert at up to 95% raw FMV
//   PSA 8  (any conf):    alert at up to 80% raw FMV
//   Below PSA 8:          skip

const { getDb } = require('../db');
const { searchBinListings, searchBestOfferListings } = require('./ebay');
const { gradeCard } = require('../engine/condition-grader');
const { sendPsa10Alert } = require('../alerts/sms');

// ── Target players and search queries ────────────────────────────────────────
// Each query appends -PSA -BGS -SGC -graded -slab to exclude slabbed listings.
const RAW_EXCLUSIONS = '-PSA -BGS -SGC -graded -slab -oversized';

// For Topps Chrome: autos and case hits ONLY (no base).
// Two companion queries per player: one for autos, one for case hits / refractors.
// Case hit terms: SSP (super short print), UV (ultra violet refractor),
// atomic (Atomic refractor), image variation — all signal a premium non-base card.
const CHROME_CASE_HITS = 'SSP UV atomic "case hit" "image variation"';

const PSA10_TARGETS = [
  // ── NFL: 2025 Topps Chrome (AUTOS + CASE HITS only — never base) ─────────
  {
    name: 'Jayden Daniels',
    sport: 'NFL',
    queries: [
      `Jayden Daniels 2025 Topps Chrome auto ${RAW_EXCLUSIONS}`,
      `Jayden Daniels 2025 Topps Chrome ${CHROME_CASE_HITS} ${RAW_EXCLUSIONS}`,
      `Jayden Daniels Kaboom 2025 ${RAW_EXCLUSIONS}`,
      `Jayden Daniels Downtown ${RAW_EXCLUSIONS}`,
    ],
  },
  {
    // Spec: case hits only — no Topps Chrome autos exist for Saquon
    name: 'Saquon Barkley',
    sport: 'NFL',
    queries: [
      `Saquon Barkley 2025 Topps Chrome ${CHROME_CASE_HITS} ${RAW_EXCLUSIONS}`,
      `Saquon Barkley Kaboom 2025 ${RAW_EXCLUSIONS}`,
      `Saquon Barkley Downtown ${RAW_EXCLUSIONS}`,
    ],
  },
  {
    name: 'Joe Burrow',
    sport: 'NFL',
    queries: [
      `Joe Burrow 2025 Topps Chrome auto ${RAW_EXCLUSIONS}`,
      `Joe Burrow 2025 Topps Chrome ${CHROME_CASE_HITS} ${RAW_EXCLUSIONS}`,
      `Joe Burrow Downtown ${RAW_EXCLUSIONS}`,
    ],
  },
  {
    name: 'Cam Ward',
    sport: 'NFL',
    queries: [
      `Cam Ward 2025 Topps Chrome auto ${RAW_EXCLUSIONS}`,
      `Cam Ward 2025 Topps Chrome ${CHROME_CASE_HITS} ${RAW_EXCLUSIONS}`,
      `Cam Ward Downtown ${RAW_EXCLUSIONS}`,
    ],
  },
  {
    name: 'Caleb Williams',
    sport: 'NFL',
    queries: [
      `Caleb Williams 2025 Topps Chrome auto ${RAW_EXCLUSIONS}`,
      `Caleb Williams 2025 Topps Chrome ${CHROME_CASE_HITS} ${RAW_EXCLUSIONS}`,
      `2025 Caleb Williams Kaboom ${RAW_EXCLUSIONS}`,
      `Caleb Williams Downtown ${RAW_EXCLUSIONS}`,
    ],
  },
  {
    name: 'Josh Allen',
    sport: 'NFL',
    queries: [
      `Josh Allen 2025 Topps Chrome auto ${RAW_EXCLUSIONS}`,
      `Josh Allen 2025 Topps Chrome ${CHROME_CASE_HITS} ${RAW_EXCLUSIONS}`,
      `Josh Allen Kaboom 2025 ${RAW_EXCLUSIONS}`,
      `Josh Allen Downtown ${RAW_EXCLUSIONS}`,
    ],
  },
  {
    name: 'Jaxson Dart',
    sport: 'NFL',
    queries: [
      `Jaxson Dart 2025 Topps Chrome auto ${RAW_EXCLUSIONS}`,
      `Jaxson Dart 2025 Topps Chrome ${CHROME_CASE_HITS} ${RAW_EXCLUSIONS}`,
      `Jaxson Dart Downtown ${RAW_EXCLUSIONS}`,
    ],
  },
  {
    name: 'Tom Brady',
    sport: 'NFL',
    queries: [
      `Tom Brady 2025 Topps Chrome auto ${RAW_EXCLUSIONS}`,
      `Tom Brady 2025 Topps Chrome ${CHROME_CASE_HITS} ${RAW_EXCLUSIONS}`,
      `Tom Brady Downtown ${RAW_EXCLUSIONS}`,
    ],
  },
  {
    name: 'Travis Hunter',
    sport: 'NFL',
    queries: [
      `Travis Hunter 2025 Topps Chrome auto ${RAW_EXCLUSIONS}`,
      `Travis Hunter 2025 Topps Chrome ${CHROME_CASE_HITS} ${RAW_EXCLUSIONS}`,
      `Travis Hunter Downtown ${RAW_EXCLUSIONS}`,
    ],
  },
  {
    name: 'Shedeur Sanders',
    sport: 'NFL',
    queries: [
      `Shedeur Sanders 2025 Topps Chrome auto ${RAW_EXCLUSIONS}`,
      `Shedeur Sanders 2025 Topps Chrome ${CHROME_CASE_HITS} ${RAW_EXCLUSIONS}`,
      `Shedeur Sanders Downtown ${RAW_EXCLUSIONS}`,
    ],
  },
  {
    name: 'Abdul Carter',
    sport: 'NFL',
    queries: [
      `Abdul Carter 2025 Topps Chrome auto ${RAW_EXCLUSIONS}`,
      `Abdul Carter 2025 Topps Chrome ${CHROME_CASE_HITS} ${RAW_EXCLUSIONS}`,
      `Abdul Carter Downtown ${RAW_EXCLUSIONS}`,
    ],
  },
  {
    name: 'Tetairoa McMillan',
    sport: 'NFL',
    queries: [
      `Tetairoa McMillan 2025 Topps Chrome auto ${RAW_EXCLUSIONS}`,
      `Tetairoa McMillan 2025 Topps Chrome ${CHROME_CASE_HITS} ${RAW_EXCLUSIONS}`,
      `Tetairoa McMillan Downtown ${RAW_EXCLUSIONS}`,
    ],
  },
  {
    name: 'Mason Graham',
    sport: 'NFL',
    queries: [
      `Mason Graham 2025 Topps Chrome auto ${RAW_EXCLUSIONS}`,
      `Mason Graham 2025 Topps Chrome ${CHROME_CASE_HITS} ${RAW_EXCLUSIONS}`,
    ],
  },
  {
    name: 'Drake Maye',
    sport: 'NFL',
    queries: [
      `Drake Maye 2025 Topps Chrome auto ${RAW_EXCLUSIONS}`,
      `Drake Maye 2025 Topps Chrome ${CHROME_CASE_HITS} ${RAW_EXCLUSIONS}`,
      `Drake Maye Downtown ${RAW_EXCLUSIONS}`,
    ],
  },
  {
    name: 'Bo Nix',
    sport: 'NFL',
    queries: [
      `Bo Nix 2025 Topps Chrome auto ${RAW_EXCLUSIONS}`,
      `Bo Nix 2025 Topps Chrome ${CHROME_CASE_HITS} ${RAW_EXCLUSIONS}`,
      `Bo Nix Downtown ${RAW_EXCLUSIONS}`,
    ],
  },
  {
    name: 'Malik Nabers',
    sport: 'NFL',
    queries: [
      `Malik Nabers 2025 Topps Chrome auto ${RAW_EXCLUSIONS}`,
      `Malik Nabers 2025 Topps Chrome ${CHROME_CASE_HITS} ${RAW_EXCLUSIONS}`,
      `Malik Nabers Downtown ${RAW_EXCLUSIONS}`,
    ],
  },
  {
    name: 'Brock Bowers',
    sport: 'NFL',
    queries: [
      `Brock Bowers 2025 Topps Chrome auto ${RAW_EXCLUSIONS}`,
      `Brock Bowers 2025 Topps Chrome ${CHROME_CASE_HITS} ${RAW_EXCLUSIONS}`,
      `Brock Bowers Downtown ${RAW_EXCLUSIONS}`,
    ],
  },
  {
    name: 'Marvin Harrison Jr',
    sport: 'NFL',
    queries: [
      `"Marvin Harrison Jr" 2025 Topps Chrome auto ${RAW_EXCLUSIONS}`,
      `"Marvin Harrison Jr" 2025 Topps Chrome ${CHROME_CASE_HITS} ${RAW_EXCLUSIONS}`,
      `"Marvin Harrison Jr" Downtown ${RAW_EXCLUSIONS}`,
    ],
  },
  {
    name: 'Patrick Mahomes',
    sport: 'NFL',
    queries: [
      `Patrick Mahomes 2025 Topps Chrome auto ${RAW_EXCLUSIONS}`,
      `Patrick Mahomes Downtown ${RAW_EXCLUSIONS}`,
      `Patrick Mahomes Kaboom ${RAW_EXCLUSIONS}`,
    ],
  },

  // ── NBA: Steph Curry Kabooms, Downtowns, 2025 Topps Chrome (autos/case hits) ─
  {
    name: 'Stephen Curry',
    sport: 'NBA',
    queries: [
      `Steph Curry 2025 Topps Chrome auto ${RAW_EXCLUSIONS}`,
      `Stephen Curry 2025 Topps Chrome auto ${RAW_EXCLUSIONS}`,
      `Steph Curry 2025 Topps Chrome ${CHROME_CASE_HITS} ${RAW_EXCLUSIONS}`,
      `Steph Curry Kaboom ${RAW_EXCLUSIONS}`,
      `Stephen Curry Kaboom ${RAW_EXCLUSIONS}`,
      `Steph Curry Downtown ${RAW_EXCLUSIONS}`,
      `Stephen Curry Downtown ${RAW_EXCLUSIONS}`,
    ],
  },

  // ── Broad insert set sweeps (catch all players in these sets) ────────────
  // Covers Wemby, LeBron, Luka, Ant Edwards, etc. in basketball;
  // all NFL skill players in football Kabooms/Downtowns.
  {
    name: 'Kaboom Football 2025',
    sport: 'NFL',
    queries: [
      `2025 Kaboom football ${RAW_EXCLUSIONS}`,
      `2025 Downtown football ${RAW_EXCLUSIONS}`,
    ],
  },
  {
    name: 'Kaboom Basketball 2025',
    sport: 'NBA',
    queries: [
      `2025 Kaboom basketball ${RAW_EXCLUSIONS}`,
      `2025 Downtown basketball ${RAW_EXCLUSIONS}`,
    ],
  },

  // ── Soccer: World Cup 2026 hype players — Kabooms exploding in value ─────
  {
    name: 'Lionel Messi',
    sport: 'Soccer',
    queries: [
      `Messi Kaboom ${RAW_EXCLUSIONS}`,
      `Lionel Messi Kaboom ${RAW_EXCLUSIONS}`,
    ],
  },
  {
    name: 'Cristiano Ronaldo',
    sport: 'Soccer',
    queries: [
      `Cristiano Ronaldo Kaboom ${RAW_EXCLUSIONS}`,
    ],
  },
  {
    name: 'Kylian Mbappe',
    sport: 'Soccer',
    queries: [
      `Kylian Mbappe Kaboom ${RAW_EXCLUSIONS}`,
    ],
  },
  {
    name: 'Erling Haaland',
    sport: 'Soccer',
    queries: [
      `Erling Haaland Kaboom ${RAW_EXCLUSIONS}`,
    ],
  },
  {
    name: 'Vinicius Jr',
    sport: 'Soccer',
    queries: [
      `Vinicius Jr Kaboom ${RAW_EXCLUSIONS}`,
    ],
  },
  {
    name: 'Jude Bellingham',
    sport: 'Soccer',
    queries: [
      `Jude Bellingham Kaboom ${RAW_EXCLUSIONS}`,
    ],
  },
  {
    name: 'Lamine Yamal',
    sport: 'Soccer',
    queries: [
      `Lamine Yamal Kaboom ${RAW_EXCLUSIONS}`,
    ],
  },
  {
    name: 'Endrick',
    sport: 'Soccer',
    queries: [
      `Endrick Kaboom ${RAW_EXCLUSIONS}`,
    ],
  },

  // ── MLB: Blue-chip rookies (wide net — multiple products) ────────────────
  {
    name: 'Shohei Ohtani',
    sport: 'MLB',
    queries: [
      `Shohei Ohtani rookie ${RAW_EXCLUSIONS}`,
      `Shohei Ohtani 2018 Topps Chrome ${RAW_EXCLUSIONS}`,
      `Shohei Ohtani Bowman Chrome ${RAW_EXCLUSIONS}`,
    ],
  },
  {
    name: 'Aaron Judge',
    sport: 'MLB',
    queries: [
      `Aaron Judge rookie ${RAW_EXCLUSIONS}`,
      `Aaron Judge 2017 Topps Chrome ${RAW_EXCLUSIONS}`,
      `Aaron Judge Bowman Chrome ${RAW_EXCLUSIONS}`,
    ],
  },

  // ── NHL: Upper Deck Young Guns ────────────────────────────────────────────
  // Young Guns are notorious for centering issues — AI grading is especially
  // valuable here to find the rare well-centered copies worth grading.
  {
    name: 'Macklin Celebrini',
    sport: 'NHL',
    queries: [
      `Macklin Celebrini Young Guns ${RAW_EXCLUSIONS}`,
      `Macklin Celebrini Upper Deck Young Guns ${RAW_EXCLUSIONS}`,
    ],
  },
  {
    name: 'Connor Bedard',
    sport: 'NHL',
    queries: [
      `Connor Bedard Young Guns ${RAW_EXCLUSIONS}`,
    ],
  },
  {
    name: 'Ivan Demidov',
    sport: 'NHL',
    queries: [
      `Ivan Demidov Young Guns ${RAW_EXCLUSIONS}`,
    ],
  },
  {
    name: 'Matthew Schaefer',
    sport: 'NHL',
    queries: [
      `Matthew Schaefer Young Guns ${RAW_EXCLUSIONS}`,
    ],
  },
  {
    name: 'Cale Makar',
    sport: 'NHL',
    queries: [
      `Cale Makar Young Guns ${RAW_EXCLUSIONS}`,
    ],
  },
  {
    name: 'Nathan MacKinnon',
    sport: 'NHL',
    queries: [
      `Nathan MacKinnon Young Guns ${RAW_EXCLUSIONS}`,
    ],
  },
  {
    name: 'Connor McDavid',
    sport: 'NHL',
    queries: [
      `Connor McDavid Young Guns ${RAW_EXCLUSIONS}`,
    ],
  },
  {
    name: 'Matvei Michkov',
    sport: 'NHL',
    queries: [
      `Matvei Michkov Young Guns ${RAW_EXCLUSIONS}`,
    ],
  },
  {
    name: 'Logan Stankoven',
    sport: 'NHL',
    queries: [
      `Logan Stankoven Young Guns ${RAW_EXCLUSIONS}`,
    ],
  },
  {
    name: 'Will Smith',
    sport: 'NHL',
    queries: [
      `Will Smith Young Guns Upper Deck ${RAW_EXCLUSIONS}`,
    ],
  },
  {
    name: 'Lane Hutson',
    sport: 'NHL',
    queries: [
      `Lane Hutson Young Guns ${RAW_EXCLUSIONS}`,
    ],
  },
];

// ── Grade thresholds — determines when to alert on a candidate ───────────────
// PSA 10 premium over raw FMV is usually 3–8x for elite rookies.
const GRADE_THRESHOLDS = {
  10: { minConfidence: 0.70, maxFmvRatio: 1.00 }, // any price at/below raw FMV
  9:  { minConfidence: 0.70, maxFmvRatio: 0.95 }, // ≤95% raw FMV
  8:  { minConfidence: 0.00, maxFmvRatio: 0.80 }, // ≤80% raw FMV (normal threshold)
};
const MIN_GRADE_TO_ALERT = 8;

// ── Cursor state (rotates across all queries each cycle) ─────────────────────
// Each target may have multiple queries; cursor advances through the flat list.
let hunterCursor = 0;
const HUNTER_BATCH_SIZE = parseInt(process.env.PSA10_HUNTER_BATCH_SIZE || '10', 10);

// ── Deduplicate: skip listing_ids already in psa10_candidates ───────────────
function isAlreadyScanned(db, listingId) {
  if (!listingId) return false;
  return !!db.prepare('SELECT 1 FROM psa10_candidates WHERE listing_id=?').get(listingId);
}

// ── Save a candidate to DB ───────────────────────────────────────────────────
function saveCandidate(db, { target, listing, aiGrade, rawFmv, psa10Fmv }) {
  const gradeNum = aiGrade ? parseInt(String(aiGrade.estimatedGrade).replace(/[^0-9]/g, ''), 10) : null;
  const result = db.prepare(`
    INSERT OR IGNORE INTO psa10_candidates(
      player_name, sport, card_description, listing_url, listing_id,
      listing_price, raw_fmv, psa10_fmv, image_url,
      ai_grade, ai_grade_num, ai_confidence,
      ai_recommendation, ai_details, ai_notes
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    target.name,
    target.sport,
    listing.title || listing.description || `${target.name} ${target.sport}`,
    listing.url,
    listing.listing_id || null,
    listing.price,
    rawFmv  || null,
    psa10Fmv || null,
    listing.image_url || null,
    aiGrade?.estimatedGrade || null,
    gradeNum,
    aiGrade?.confidence || null,
    aiGrade?.recommendation || null,
    aiGrade?.details ? JSON.stringify(aiGrade.details) : null,
    aiGrade?.notes || null,
  );
  return result.lastInsertRowid;
}

// ── FMV lookups from fmv_estimates — best match by player name ───────────────
// Returns null when the player isn't in the main watchlist yet; callers tolerate that.
function getRawFmv(db, playerName) {
  const row = db.prepare(`
    SELECT fe.fmv FROM fmv_estimates fe
    JOIN players p ON p.id = fe.player_id
    WHERE p.name=? AND fe.grade IN ('RAW','PSA 9')
    ORDER BY CASE fe.grade WHEN 'RAW' THEN 0 ELSE 1 END
    LIMIT 1
  `).get(playerName);
  return row ? row.fmv : null;
}

function getPsa10Fmv(db, playerName) {
  const row = db.prepare(`
    SELECT fe.fmv FROM fmv_estimates fe
    JOIN players p ON p.id = fe.player_id
    WHERE p.name=? AND fe.grade='PSA 10'
    LIMIT 1
  `).get(playerName);
  return row ? row.fmv : null;
}

// ── Evaluate if a graded candidate meets alert thresholds ────────────────────
// Returns true if we should alert, false otherwise.
function meetsAlertThreshold(aiGrade, rawFmv, listingPrice) {
  if (!aiGrade) return false;
  const gradeNum = parseInt(String(aiGrade.estimatedGrade).replace(/[^0-9]/g, ''), 10);
  if (!Number.isFinite(gradeNum) || gradeNum < MIN_GRADE_TO_ALERT) return false;

  const thresholds = GRADE_THRESHOLDS[gradeNum] || GRADE_THRESHOLDS[8];
  if (aiGrade.confidence < thresholds.minConfidence) return false;

  // If no FMV available, alert on PSA 10 candidates regardless of price
  if (!rawFmv || rawFmv <= 0) {
    return gradeNum >= 10 && aiGrade.confidence >= 0.70;
  }

  return listingPrice <= rawFmv * thresholds.maxFmvRatio;
}

// ── Main scanner job ─────────────────────────────────────────────────────────
async function scanPsa10Candidates() {
  const db = getDb();

  // Build flat list of all queries across all targets
  const allQueries = [];
  for (const target of PSA10_TARGETS) {
    for (const query of target.queries) {
      allQueries.push({ target, query });
    }
  }

  const totalQueries = allQueries.length;
  if (totalQueries === 0) return;

  const startIdx   = hunterCursor % totalQueries;
  const count      = Math.min(HUNTER_BATCH_SIZE, totalQueries);
  hunterCursor     = (startIdx + count) % totalQueries;

  console.log(`[PSA10Hunter] Scanning ${count} queries (slot ${startIdx + 1}–${startIdx + count} of ${totalQueries})`);

  let graded = 0;
  let alerted = 0;

  for (let i = 0; i < count; i++) {
    const { target, query } = allQueries[(startIdx + i) % totalQueries];

    try {
      // Fetch BIN + Best Offer listings (raw/ungraded only via search query exclusions)
      const [bins, bos] = await Promise.allSettled([
        searchBinListings(query, { limit: 8 }),
        searchBestOfferListings(query, { limit: 5 }),
      ]);

      const binItems = bins.status === 'fulfilled' ? bins.value : [];
      const boItems  = bos.status  === 'fulfilled' ? bos.value  : [];

      // Merge, dedupe by listing_id
      const seen  = new Set(binItems.map(l => l.listing_id));
      const items = [...binItems, ...boItems.filter(l => !seen.has(l.listing_id))];

      for (const listing of items) {
        // Skip already-scanned listings
        if (isAlreadyScanned(db, listing.listing_id)) continue;

        // Skip listings that contain slab keywords in the title (double guard)
        const titleText = String(listing.title || '');
        if (/\b(PSA|BGS|SGC|CGC|HGA|GRADED|SLAB)\b/i.test(titleText)) continue;

        // Look up FMVs once per listing (cheap DB reads, no API call)
        const rawFmv   = getRawFmv(db, target.name);
        const psa10Fmv = getPsa10Fmv(db, target.name);

        if (!listing.image_url) {
          saveCandidate(db, { target, listing, aiGrade: null, rawFmv, psa10Fmv });
          continue;
        }

        // Run GPT-4o Vision grading on every listing (no price gate).
        // Infer the card set from the query so GPT-4o gets accurate context.
        let cardSetHint = '2025 Topps Chrome';
        if (target.sport === 'NHL')                           cardSetHint = 'Upper Deck Young Guns';
        else if (/kaboom/i.test(query))                       cardSetHint = 'Panini Kaboom';
        else if (/downtown/i.test(query))                     cardSetHint = 'Panini Downtown';
        else if (/soccer|messi|ronaldo|mbappe|haaland/i.test(query)) cardSetHint = 'Soccer Kaboom';
        else if (/baseball|ohtani|judge|bowman/i.test(query)) cardSetHint = 'Baseball Chrome';

        const aiGrade = await gradeCard(listing.image_url, {
          playerName: target.name,
          cardSet:    cardSetHint,
        });
        graded++;

        const candidateId = saveCandidate(db, { target, listing, aiGrade, rawFmv, psa10Fmv });

        // Skip below PSA 8 or failed grading
        if (!aiGrade) continue;
        const gradeNum = parseInt(String(aiGrade.estimatedGrade).replace(/[^0-9]/g, ''), 10);
        if (gradeNum < MIN_GRADE_TO_ALERT) {
          console.log(`[PSA10Hunter] ${target.name} → ${aiGrade.estimatedGrade} (${Math.round(aiGrade.confidence * 100)}%) — below threshold, skipping`);
          continue;
        }

        // Check price vs raw FMV threshold (rawFmv already fetched above)
        if (!meetsAlertThreshold(aiGrade, rawFmv, listing.price)) {
          console.log(
            `[PSA10Hunter] ${target.name} → ${aiGrade.estimatedGrade} — price $${listing.price} exceeds threshold` +
            (rawFmv ? ` (raw FMV $${rawFmv.toFixed(0)})` : ' (no FMV)') +
            `, skipping alert`
          );
          continue;
        }

        // Send SMS alert
        try {
          await sendPsa10Alert({
            candidateId,
            playerName:      target.name,
            sport:           target.sport,
            cardDescription: listing.title || `${target.name} — ${cardSetHint}`,
            price:           listing.price,
            rawFmv,
            listingUrl:      listing.url,
            aiGrade,
          });
          db.prepare(`
            UPDATE psa10_candidates SET alert_sent=1, sms_sent_at=CURRENT_TIMESTAMP
            WHERE id=?
          `).run(candidateId);
          alerted++;
        } catch (err) {
          console.error('[PSA10Hunter] SMS error:', err.message);
        }
      }
    } catch (err) {
      console.error(`[PSA10Hunter] Scan error for "${query}":`, err.message);
    }
  }

  console.log(`[PSA10Hunter] Cycle complete — graded ${graded} cards, sent ${alerted} alerts`);
}

// ── Re-grade candidates that were saved before OPENAI_API_KEY was configured ──
// Runs after each scan cycle. Picks up to HUNTER_BATCH_SIZE rows that have an
// image_url but no ai_grade yet and grades them now. This means existing
// candidates don't need to be re-scanned once the API key is live.
async function gradeUngradedCandidates() {
  const key = process.env.OPENAI_API_KEY;
  if (!key || key.startsWith('sk-your') || key === 'your_key_here') {
    console.log('[PSA10Hunter] OPENAI_API_KEY not set — skipping re-grade pass');
    return;
  }

  const db = getDb();

  const rows = db.prepare(`
    SELECT id, player_name, image_url, listing_price, raw_fmv, listing_url
    FROM psa10_candidates
    WHERE status='candidate' AND ai_grade IS NULL AND image_url IS NOT NULL
    ORDER BY scanned_at DESC
    LIMIT ?
  `).all(HUNTER_BATCH_SIZE);

  if (rows.length === 0) return;
  console.log(`[PSA10Hunter] Re-grading ${rows.length} ungraded candidate(s)…`);

  let graded = 0;
  for (const row of rows) {
    const aiGrade = await gradeCard(row.image_url, { playerName: row.player_name });
    if (!aiGrade) continue; // API key still not set — stop early

    const gradeNum = parseInt(String(aiGrade.estimatedGrade).replace(/[^0-9]/g, ''), 10);
    db.prepare(`
      UPDATE psa10_candidates SET
        ai_grade=?, ai_grade_num=?, ai_confidence=?,
        ai_recommendation=?, ai_details=?, ai_notes=?
      WHERE id=?
    `).run(
      aiGrade.estimatedGrade,
      gradeNum,
      aiGrade.confidence,
      aiGrade.recommendation,
      aiGrade.details ? JSON.stringify(aiGrade.details) : null,
      aiGrade.notes || null,
      row.id,
    );
    graded++;
  }

  if (graded > 0) console.log(`[PSA10Hunter] Re-graded ${graded} candidate(s)`);
}

// ── Expire old candidates (>24h) ──────────────────────────────────────────────
function expireOldCandidates() {
  const db = getDb();
  const result = db.prepare(`
    UPDATE psa10_candidates SET status='passed'
    WHERE status='candidate' AND scanned_at < datetime('now','-24 hours')
  `).run();
  if (result.changes > 0) {
    console.log(`[PSA10Hunter] Expired ${result.changes} old candidate(s)`);
  }
}

module.exports = {
  scanPsa10Candidates,
  gradeUngradedCandidates,
  expireOldCandidates,
  PSA10_TARGETS,
};
