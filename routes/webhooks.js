'use strict';

const express = require('express');
const twilio = require('twilio');
const { handleSmsReply } = require('../engine/sniper');
const { send } = require('../alerts/sms');

const router = express.Router();

// Validates X-Twilio-Signature when credentials are configured.
// Skipped transparently in dev or when TWILIO_AUTH_TOKEN is still a placeholder.
function validateTwilioSignature(req, res, next) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken || authToken.startsWith('your_')) return next();
  twilio.webhook(authToken)(req, res, next);
}

// ── Twilio SMS webhook ────────────────────────────────────────────────────────
// Configure your Twilio number's "When A Message Comes In" webhook to:
//   POST https://your-domain.com/webhooks/sms
//
// Twilio sends form-encoded data with:
//   Body: message text
//   From: sender phone number
//   To: your Twilio number

router.post('/sms',
  express.urlencoded({ extended: false }),
  validateTwilioSignature,
  async (req, res) => {
  const body = (req.body.Body || '').trim();
  const from = req.body.From || '';

  console.log(`[Webhook] SMS from ${from}: "${body}"`);

  // Return TwiML immediately to acknowledge receipt
  // Then handle asynchronously
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');

  // Process reply
  try {
    const result = await handleSmsReply(body, from);
    console.log('[Webhook] SMS reply result:', result);

    if (result.handled) {
      if (result.action === 'purchase') {
        await send(`[CrazyCardzCo] Purchase confirmed. Check eBay to complete. Deal #${result.result?.deal?.id || 'N/A'}`);
      } else if (result.action === 'pass') {
        await send(`[CrazyCardzCo] Deal #${result.dealId} passed. Watching for next one.`);
      }
    } else if (body.toUpperCase() === 'HELP') {
      await send('[CrazyCardzCo] Commands: YES (confirm purchase), STOP (cancel snipe), PASS (skip deal), STATUS (scanner status)');
    } else if (body.toUpperCase() === 'STATUS') {
      const { getSetting, getWeeklySpend } = require('../db');
      const active = getSetting('scan_active') !== 'false';
      const weeklySpent = getWeeklySpend();
      const weeklyCap = parseFloat(getSetting('weekly_spend_cap') || '1000');
      await send(`[CrazyCardzCo] Scanner: ${active ? 'ON' : 'OFF'} | Week spent: $${weeklySpent.toFixed(0)} / $${weeklyCap.toFixed(0)}`);
    }
  } catch (err) {
    console.error('[Webhook] SMS processing error:', err.message);
  }
});

module.exports = router;
