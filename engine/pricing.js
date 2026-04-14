'use strict';

const { getDb } = require('../db');

// ── FMV calculation ──────────────────────────────────────────────────────────
// Median of last 10 comps, weighted by recency (newer sales count more).

function calcFmv(comps) {
  if (!comps || comps.length === 0) return null;

  // Sort newest first
  const sorted = [...comps].sort((a, b) => new Date(b.sale_date) - new Date(a.sale_date));
  const recent = sorted.slice(0, 10);

  if (recent.length === 1) return recent[0].price;

  // Recency weights: index 0 = most recent gets highest weight
  const now = Date.now();
  const oneDay = 86400000;

  const weights = recent.map(comp => {
    const ageMs = now - new Date(comp.sale_date).getTime();
    const ageDays = ageMs / oneDay;
    // Exponential decay: weight = e^(-0.1 * ageDays), floor at 0.2
    return Math.max(0.2, Math.exp(-0.1 * ageDays));
  });

  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const weightedSum = recent.reduce((sum, comp, i) => sum + comp.price * weights[i], 0);

  // Weighted average (better than median for volatile markets)
  return Math.round((weightedSum / totalWeight) * 100) / 100;
}

function calcTrend(comps) {
  if (!comps || comps.length < 4) return 'stable';

  const sorted = [...comps].sort((a, b) => new Date(a.sale_date) - new Date(b.sale_date));
  const half = Math.floor(sorted.length / 2);
  const oldAvg = avg(sorted.slice(0, half).map(c => c.price));
  const newAvg = avg(sorted.slice(half).map(c => c.price));

  const changePct = (newAvg - oldAvg) / oldAvg;
  if (changePct > 0.05) return 'up';
  if (changePct < -0.05) return 'down';
  return 'stable';
}

function avg(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// ── Persist FMV estimate from new comps ──────────────────────────────────────
function upsertFmv({ playerId, playerName, cardSet, grade, comps, source = 'ebay' }) {
  const db = getDb();
  const fmv = calcFmv(comps);
  if (fmv === null) return null;

  const trend = calcTrend(comps);

  // Upsert FMV estimate
  db.prepare(`
    INSERT INTO fmv_estimates(player_id, player_name, card_set, grade, fmv, sample_count, last_updated, trend)
    VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP,?)
    ON CONFLICT(player_id, card_set, grade) DO UPDATE SET
      fmv=excluded.fmv,
      sample_count=excluded.sample_count,
      last_updated=excluded.last_updated,
      trend=excluded.trend
  `).run(playerId, playerName, cardSet, grade, fmv, comps.length, trend);

  const fmvRow = db.prepare(
    'SELECT id FROM fmv_estimates WHERE player_id=? AND card_set=? AND grade=?'
  ).get(playerId, cardSet, grade);

  if (!fmvRow) return fmv;

  // Store individual comps for history
  const insertComp = db.prepare(`
    INSERT OR IGNORE INTO price_comps(fmv_id, price, sale_date, source, listing_id)
    VALUES(?,?,?,?,?)
  `);
  for (const comp of comps) {
    insertComp.run(fmvRow.id, comp.price, comp.sale_date, source, comp.listing_id || null);
  }

  return fmv;
}

// ── Load FMV for a specific card ─────────────────────────────────────────────
function getFmv(playerId, cardSet, grade) {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM fmv_estimates WHERE player_id=? AND card_set=? AND grade=?'
  ).get(playerId, cardSet, grade);
}

// ── Load price history for chart ─────────────────────────────────────────────
function getPriceHistory(fmvId, days = 30) {
  const db = getDb();
  return db.prepare(`
    SELECT price, sale_date
    FROM price_comps
    WHERE fmv_id=?
      AND sale_date >= datetime('now', '-' || ? || ' days')
    ORDER BY sale_date ASC
  `).all(fmvId, days);
}

// ── Calculate break-even for raw card submission ─────────────────────────────
function calcRawBreakEven({ purchasePrice, psa10Fmv, psa9Fmv }) {
  const gradingCost = 40;
  const shippingCost = 7.50;
  const ebayFee = 0.13;
  const totalCost = purchasePrice + gradingCost + shippingCost;

  const psa10Net = psa10Fmv ? psa10Fmv * (1 - ebayFee) : 0;
  const psa9Net  = psa9Fmv  ? psa9Fmv  * (1 - ebayFee) : 0;

  return {
    totalCost,
    psa10Net,
    psa9Net,
    psa10Profitable: psa10Net > totalCost,
    psa9Profitable:  psa9Net  > totalCost,
    psa10Ratio:      psa10Fmv ? psa10Fmv / purchasePrice : null,
  };
}

module.exports = { calcFmv, calcTrend, upsertFmv, getFmv, getPriceHistory, calcRawBreakEven };
