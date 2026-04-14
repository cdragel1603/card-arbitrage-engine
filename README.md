# 🃏 CrazyCardzCo — Card Arbitrage Engine

Automated trading card deal scanner. Monitors eBay (+ Arena Club / ALT stubs) for undervalued cards against your watchlist, sends SMS alerts via Twilio, and tracks your portfolio P&L.

---

## Quick Start

### 1. Install dependencies
```bash
cd card-arbitrage-engine
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
```

Edit `.env` with your credentials (see [Configuration](#configuration) below).

### 3. Run
```bash
npm start
# or for auto-reload during development:
npm run dev
```

Open **http://localhost:3000** — default password: `crazycardz2024`

**Change the password immediately** in Settings after first login.

---

## Configuration

### `.env` variables

| Variable | Description |
|---|---|
| `EBAY_CLIENT_ID` | eBay Developer App ID (same as Client ID) |
| `EBAY_CLIENT_SECRET` | eBay Developer Client Secret |
| `EBAY_APP_ID` | Same as Client ID — used for Finding API (sold comps) |
| `EBAY_ENVIRONMENT` | `production` or `sandbox` |
| `TWILIO_ACCOUNT_SID` | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Twilio auth token |
| `TWILIO_FROM_NUMBER` | Your Twilio number: `+16026339330` |
| `TWILIO_TO_NUMBER` | Connor's cell: `+17088376553` |
| `SESSION_SECRET` | Long random string for session signing |
| `DASHBOARD_PASSWORD` | Login password (change immediately) |
| `MOCK_SCANNER` | `true` = fake deals for testing, `false` = live eBay |
| `SCAN_INTERVAL_SECONDS` | How often to scan eBay (min ~30s, default 45s) |
| `COMP_REFRESH_HOURS` | FMV refresh interval (default 8h = 3x/day) |
| `MAX_SPEND_PER_CARD` | Hard cap per card (default $2,500) |
| `MAX_SPEND_PER_DAY` | Daily spend limit (default $5,000) |

---

## eBay API Setup

### Step 1 — Get credentials
1. Go to [developer.ebay.com](https://developer.ebay.com) → sign in with your eBay account
2. My Account → Application Keys → **Create a Keyset** (Production)
3. Copy **App ID (Client ID)** → `EBAY_CLIENT_ID` and `EBAY_APP_ID`
4. Copy **Cert ID (Client Secret)** → `EBAY_CLIENT_SECRET`

### Step 2 — APIs used
| API | Purpose | Access |
|---|---|---|
| Browse API (`/buy/browse/v1`) | Search active BIN + auction listings | Available by default |
| Marketplace Insights API (`/buy/marketplace_insights/v1_beta`) | Fetch sold comp prices | May need approval |
| Finding API (legacy) | Fallback for sold comps | Available with App ID |

The engine automatically falls back to the Finding API if Marketplace Insights returns a 403.

### Step 3 — Rate limits
- Basic access: **5,000 Browse API calls/day**
- With 45s scan interval across ~32 players × 2 grades = ~128 calls/scan
- At 45s intervals = ~192 scans/day = ~24,576 calls/day ⚠️
- **Recommendation**: scan top 10 players only OR apply for higher rate limits at developer.ebay.com

### Phase 2 — Auto-buying
eBay's **Offer API** (for placing bids/BINs programmatically) is gated. Apply at:
`https://developer.ebay.com/my/keys` → "Apply for API Access" → Buy APIs

Until approved, the sniper logs purchase intent and sends SMS. You manually complete the buy on eBay.

---

## Twilio SMS Setup

Your Twilio number `(602) 633-9330` is already purchased. To enable webhooks for SMS replies:

1. Log into [twilio.com/console](https://console.twilio.com)
2. Phone Numbers → Active Numbers → `(602) 633-9330`
3. Under "Messaging" → "When A Message Comes In":
   - Set to **Webhook** → `POST`
   - URL: `https://your-railway-domain.up.railway.app/webhooks/sms`
4. Save

### SMS Commands (reply to alerts)
| Reply | Action |
|---|---|
| `YES` | Confirm BIN purchase |
| `STOP` | Cancel auction snipe |
| `PASS` | Skip the deal |
| `STATUS` | Scanner status + daily spend |
| `HELP` | Show commands |

---

## Architecture

```
card-arbitrage-engine/
├── server.js           Express app entry point
├── db.js               SQLite setup, tables, seed data
├── config.js           Player watchlist, card targets, thresholds
├── scanner/
│   ├── ebay.js         eBay Browse + Finding + Marketplace Insights APIs
│   ├── mock.js         Fake deal generator for testing
│   ├── arena-club.js   Arena Club stub (Phase 2)
│   ├── alt.js          ALT auction stub (Phase 2)
│   └── scheduler.js    Cron jobs: scan loop, comp refresh, daily SMS
├── engine/
│   ├── pricing.js      FMV calc (weighted median of last 10 comps)
│   ├── deal-detector.js Apply buy rules, save deals, trigger SMS
│   ├── sniper.js       Bid/buy logic, SMS reply handler
│   └── condition-grader.js Phase 2 stub for AI card grading
├── alerts/
│   └── sms.js          Twilio SMS send + alert formatters
├── routes/
│   ├── api.js          REST API for dashboard
│   ├── webhooks.js     Twilio inbound SMS webhook
│   └── auth.js         Session auth, login/logout
└── public/
    ├── index.html      Dashboard HTML
    ├── app.js          Vanilla JS frontend
    └── style.css       Dark theme styles
```

---

## Buy Rules

| Type | Threshold | Notes |
|---|---|---|
| Blue chip (Ohtani, LeBron, MJ, Curry, Wemby, Flagg, Mahomes, McDavid) | ≤95% of FMV | No spend ceiling |
| Standard graded | ≤80% of FMV | Max $2,500/card |
| Raw (PSA 10 upside) | ≤80% if PSA 10 value is 3x+ purchase | Factor in grading cost |
| Min price | $100 | Skip cheap cards unless grading upside |

**Costs factored in:** grading ($40), shipping ($7.50), eBay resale fees (13%)

---

## Deploy to Railway

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login and init
railway login
railway init

# Set environment variables
railway variables set EBAY_CLIENT_ID=xxx EBAY_CLIENT_SECRET=xxx ...

# Deploy
railway up
```

Then update your Twilio webhook URL to the Railway domain.

---

## Database

SQLite file: `cards.db` (auto-created on first run)

Key tables:
- `players` — watchlist players
- `card_targets` — card sets to watch per player
- `fmv_estimates` — current FMV per player+set+grade
- `price_comps` — raw sold listing data (time series)
- `deals` — detected deals
- `transactions` — purchased cards + P&L
- `settings` — app config

---

## Phase 2 Roadmap

- [ ] **eBay Offer API** — true auto-buy/bid (pending API approval)
- [ ] **Arena Club integration** — price drop monitoring
- [ ] **ALT integration** — live auction feed
- [ ] **AI card grader** — computer vision PSA grade prediction
- [ ] **Comp cross-validation** — PSA cert DB lookup
- [ ] **Price alerts** — notify when FMV spikes on owned cards
- [ ] **Bulk listing scanner** — scan eBay lots for hidden value
