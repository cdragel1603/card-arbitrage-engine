'use strict';

require('dotenv').config();

const twilio = require('twilio');
const { getSetting } = require('../db');

function getClient() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token || sid.startsWith('your_')) {
    return null; // SMS disabled — credentials not configured
  }
  return twilio(sid, token);
}

const FROM = process.env.TWILIO_FROM_NUMBER || '+16026339330';
const TO   = process.env.TWILIO_TO_NUMBER   || '+17088376553';

async function send(body) {
  const smsEnabled = getSetting('sms_enabled');
  if (smsEnabled === 'false') {
    console.log(`[SMS] Disabled — would send: ${body}`);
    return { sent: false, reason: 'SMS disabled in settings' };
  }

  const client = getClient();
  if (!client) {
    console.log(`[SMS] No credentials — would send: ${body}`);
    return { sent: false, reason: 'Twilio credentials not configured' };
  }

  try {
    const message = await client.messages.create({ body, from: FROM, to: TO });
    console.log(`[SMS] Sent SID=${message.sid} → ${body.slice(0, 60)}...`);
    return { sent: true, sid: message.sid };
  } catch (err) {
    console.error('[SMS] Send failed:', err.message);
    return { sent: false, reason: err.message };
  }
}

// ── BIN deal alert — Connor must reply YES to purchase ───────────────────────
async function sendDealAlert({
  dealId, playerName, cardDescription, price, fmv, netFmv,
  discountPct, netDiscountPct, source, aiGrade, lowConfidenceFmv, rarity,
}) {
  const netStr = netFmv != null
    ? ` → net $${netFmv.toFixed(0)} (${netDiscountPct ?? discountPct}% under net).`
    : '.';

  let confStr = '';
  if (lowConfidenceFmv) {
    const rarityLabel = rarity?.rarityType ? ` Serial ${rarity.rarityType}.` : '';
    confStr = `\n⚠ Low-conf FMV (few comps).${rarityLabel}`;
  }

  let gradeStr = '';
  if (aiGrade) {
    const conf = Math.round(aiGrade.confidence * 100);
    gradeStr = `\nAI Grade: ${aiGrade.estimatedGrade} (${conf}% conf) → ${aiGrade.recommendation}`;
  }

  const body =
    `[DEAL #${dealId}] ${playerName} — ${cardDescription}\n` +
    `${source} BIN $${price.toFixed(0)} vs $${fmv.toFixed(0)} FMV${netStr}` +
    confStr + gradeStr + `\nReply YES to buy. PASS to skip.`;
  return send(body);
}

// ── Auction snipe alert — Connor can reply STOP to cancel ────────────────────
async function sendSnipeAlert({
  dealId, playerName, cardDescription, currentBid, fmv, netFmv, maxBid, minsLeft,
  lowConfidenceFmv, rarity,
}) {
  const netStr = netFmv != null ? ` (net $${netFmv.toFixed(0)})` : '';

  let confStr = '';
  if (lowConfidenceFmv) {
    const rarityLabel = rarity?.rarityType ? ` Serial ${rarity.rarityType}.` : '';
    confStr = `\n⚠ Low-conf FMV.${rarityLabel}`;
  }

  const body =
    `[SNIPE #${dealId}] ${playerName} — ${cardDescription}\n` +
    `Auction ends ${minsLeft}min — current $${currentBid.toFixed(0)} vs $${fmv.toFixed(0)} FMV${netStr}.\n` +
    `Max bid: $${maxBid.toFixed(0)}.` +
    confStr + `\nReply STOP to cancel.`;
  return send(body);
}

// ── Daily summary ────────────────────────────────────────────────────────────
async function sendDailySummary({ dealsFound, dealsCount, purchased }) {
  const lines = [`Today: ${dealsCount} deal${dealsCount !== 1 ? 's' : ''} found`];
  if (purchased.length > 0) {
    lines.push(`${purchased.length} purchased:`);
    for (const t of purchased) {
      lines.push(`  • ${t.card_description} — $${t.purchase_price} (${t.discount_pct}% under FMV)`);
    }
  } else {
    lines.push('0 purchased');
  }
  return send(lines.join('\n'));
}

// ── Test SMS ─────────────────────────────────────────────────────────────────
async function sendTestSms() {
  return send('[CrazyCardzCo] Card Arbitrage Engine is online and monitoring. 🃏');
}

module.exports = { send, sendDealAlert, sendSnipeAlert, sendDailySummary, sendTestSms };
