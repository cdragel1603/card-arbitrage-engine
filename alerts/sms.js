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

const FROM = process.env.TWILIO_FROM_NUMBER;
const TO   = process.env.TWILIO_TO_NUMBER;

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

  if (!FROM || !TO) {
    console.log(`[SMS] Phone numbers not configured — would send: ${body}`);
    return { sent: false, reason: 'TWILIO_FROM_NUMBER / TWILIO_TO_NUMBER not configured' };
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
  discountPct, netDiscountPct, source, aiGrade, lowConfidenceFmv, rarity, hasBestOffer,
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

  const listingType = hasBestOffer ? 'BIN+BO' : 'BIN';
  const boStr = hasBestOffer ? '\n💬 Best Offer accepted — try lowballing.' : '';

  const body =
    `[DEAL #${dealId}] ${playerName} — ${cardDescription}\n` +
    `${source} ${listingType} $${price.toFixed(0)} vs $${fmv.toFixed(0)} FMV${netStr}` +
    confStr + gradeStr + boStr + `\nReply YES to buy. PASS to skip.`;
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

// ── Urgent deal reminder (no response after URGENT_REMINDER_MINUTES) ─────────
async function sendUrgentReminder({
  dealId, playerName, cardDescription, price, fmv, discountPct, hoursLeft,
}) {
  const timeStr = hoursLeft != null
    ? (hoursLeft < 1
        ? `${Math.round(hoursLeft * 60)} min`
        : `${hoursLeft.toFixed(1)} hrs`)
    : 'soon';

  const body =
    `⏰ REMINDER [DEAL #${dealId}] ${playerName} — ${cardDescription}\n` +
    `$${price.toFixed(0)} (${discountPct}% below FMV $${fmv.toFixed(0)}) — ending in ${timeStr}.\n` +
    `Reply YES to snipe or PASS to skip.`;
  return send(body);
}

// ── Last-chance alert (<30 min remaining, tier escalation trigger) ────────────
async function sendLastChanceAlert({
  dealId, playerName, cardDescription, price, fmv, discountPct, minsLeft,
}) {
  const body =
    `🚨 LAST CHANCE [DEAL #${dealId}] ${playerName} — ${cardDescription}\n` +
    `Ending in ${minsLeft} min — $${price.toFixed(0)} (${discountPct}% below FMV $${fmv.toFixed(0)}).\n` +
    `Reply YES NOW to snipe or PASS to skip.`;
  return send(body);
}

// ── PSA 10 Hunter candidate alert ────────────────────────────────────────────
async function sendPsa10Alert({
  candidateId, playerName, sport, cardDescription, price, rawFmv, listingUrl, aiGrade,
}) {
  const gradeNum  = aiGrade ? parseInt(String(aiGrade.estimatedGrade).replace(/[^0-9]/g, ''), 10) : null;
  const conf      = aiGrade ? Math.round(aiGrade.confidence * 100) : null;
  const details   = aiGrade?.details || {};

  const gradeStr  = aiGrade ? `AI Grade: ${aiGrade.estimatedGrade} (${conf}% conf)` : 'AI Grade: unavailable';
  const detailStr = (details.corners || details.edges || details.surface || details.centering)
    ? `Corners:${details.corners ?? '?'} Edges:${details.edges ?? '?'} Surface:${details.surface ?? '?'} Ctr:${details.centering ?? '?'}`
    : '';
  const fmvStr    = rawFmv ? ` | Raw FMV ~$${rawFmv.toFixed(0)}` : '';
  const noteStr   = aiGrade?.notes ? `\n${aiGrade.notes.slice(0, 120)}` : '';
  const urlStr    = listingUrl ? `\n${listingUrl}` : '';

  const body =
    `🎯 PSA 10 CANDIDATE [#${candidateId}] ${sport}\n` +
    `${playerName} — ${cardDescription}\n` +
    `${gradeStr}\n` +
    (detailStr ? `${detailStr}\n` : '') +
    `Price: $${price.toFixed(0)}${fmvStr}` +
    noteStr + urlStr +
    `\nReply YES to buy. PASS to skip.`;

  return send(body);
}

// ── Test SMS ─────────────────────────────────────────────────────────────────
async function sendTestSms() {
  return send('[CrazyCardzCo] Card Arbitrage Engine is online and monitoring. 🃏');
}

module.exports = {
  send,
  sendDealAlert,
  sendSnipeAlert,
  sendUrgentReminder,
  sendLastChanceAlert,
  sendDailySummary,
  sendPsa10Alert,
  sendTestSms,
};
