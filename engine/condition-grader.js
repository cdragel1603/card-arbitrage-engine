'use strict';

// ── AI Card Condition Grader — GPT-4o Vision ─────────────────────────────────
//
// Uses OpenAI GPT-4o Vision to analyze trading card images and estimate the
// PSA grade a raw card would receive if submitted for grading.
//
// Integration flow:
//   1. deal-detector finds a raw card deal that passes price threshold
//   2. If the listing has an image_url, gradeCard() is called
//   3. Result is stored on the deal record (ai_grade, ai_confidence, ai_recommendation)
//   4. Grade info is appended to the SMS alert
//   5. Dashboard deal card shows an AI Condition badge
//
// Requires: OPENAI_API_KEY in environment

const OpenAI = require('openai');

// ── Rate limiter — max 10 vision calls per minute ────────────────────────────
const rateLimit = {
  calls: [],
  maxPerMinute: parseInt(process.env.GRADER_RATE_LIMIT || '10', 10),
  canCall() {
    const now = Date.now();
    this.calls = this.calls.filter(t => now - t < 60000);
    return this.calls.length < this.maxPerMinute;
  },
  record() {
    this.calls.push(Date.now());
  },
};

// ── OpenAI client — lazy init ─────────────────────────────────────────────────
function getClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey.startsWith('sk-your') || apiKey === 'your_key_here') {
    return null;
  }
  return new OpenAI({ apiKey });
}

// ── Grading prompt ────────────────────────────────────────────────────────────
const GRADING_PROMPT = `You are a professional trading card grading expert with deep knowledge of PSA grading standards.

Analyze this trading card image and evaluate it for PSA grading potential. Score each category from 1–10 using PSA standards:

1. **Corners** (1-10): Sharp and clean = 10. Slight blunting = 9. Minor fraying = 8. Visible wear = 7 or below.
2. **Edges** (1-10): Perfectly clean = 10. Minor roughness = 9. Light chipping = 8. Visible chipping/nicks = 7 or below.
3. **Surface** (1-10): Pristine gloss, zero scratches/defects = 10. Very light surface wear = 9. Noticeable scratches or print defects = 8 or below.
4. **Centering** (1-10): PSA 10 requires ≤55/45 ratio both axes. PSA 9 allows ≤60/40. Score lower for worse centering.

Overall PSA grade is determined by the weakest sub-grade. Provide:
- An integer PSA grade estimate (1–10)
- A confidence score (0.0–1.0) based on image clarity and card visibility
- A recommendation: "GRADE" if PSA 8+ is likely and grading fees are worth it, "SELL_RAW" if condition is decent but not worth grading, "PASS" if significant wear is visible

Respond ONLY with valid JSON in this exact format, no extra text:
{
  "estimatedGrade": 9,
  "confidence": 0.82,
  "details": {
    "corners": 9,
    "edges": 9,
    "surface": 9.5,
    "centering": 8.5
  },
  "recommendation": "GRADE",
  "notes": "Brief analysis — 1-2 sentences max"
}`;

// ── Main grading function ─────────────────────────────────────────────────────

/**
 * Grade a card image using GPT-4o Vision.
 *
 * @param {string} imageUrl - Public URL of the card image
 * @param {object} opts     - { playerName, cardSet }
 * @returns {Promise<GradeResult|null>}  null on any failure (graceful degradation)
 *
 * @typedef {object} GradeResult
 * @property {string} estimatedGrade    - e.g. "PSA 9"
 * @property {number} confidence        - 0.0–1.0
 * @property {object} details           - { corners, edges, surface, centering }
 * @property {"GRADE"|"SELL_RAW"|"PASS"} recommendation
 * @property {string} notes
 * @property {string} analyzedAt        - ISO timestamp
 */
async function gradeCard(imageUrl, opts = {}) {
  const client = getClient();

  if (!client) {
    console.log('[Grader] OPENAI_API_KEY not configured — skipping vision grading');
    return null;
  }

  if (!imageUrl || !imageUrl.startsWith('http')) {
    console.log('[Grader] Invalid image URL, skipping:', imageUrl);
    return null;
  }

  if (!rateLimit.canCall()) {
    console.warn('[Grader] Rate limit reached (%d/min) — skipping:', rateLimit.maxPerMinute, imageUrl.slice(0, 60));
    return null;
  }

  const label = opts.playerName
    ? `${opts.playerName}${opts.cardSet ? ' / ' + opts.cardSet : ''}`
    : imageUrl.slice(0, 60);

  try {
    rateLimit.record();
    console.log(`[Grader] Analyzing: ${label}`);

    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 400,
      temperature: 0.1, // Low temp for consistent, deterministic grading
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: GRADING_PROMPT },
            {
              type: 'image_url',
              image_url: { url: imageUrl, detail: 'high' },
            },
          ],
        },
      ],
    });

    const raw = response.choices[0]?.message?.content?.trim();
    if (!raw) throw new Error('Empty response from GPT-4o');

    // Extract JSON block (GPT-4o sometimes wraps in ```json ... ```)
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`No JSON in response: ${raw.slice(0, 100)}`);

    const parsed = JSON.parse(jsonMatch[0]);

    // Validate required fields
    const grade = Number(parsed.estimatedGrade);
    const confidence = Number(parsed.confidence);
    if (!Number.isFinite(grade) || grade < 1 || grade > 10) {
      throw new Error(`Invalid estimatedGrade: ${parsed.estimatedGrade}`);
    }
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error(`Invalid confidence: ${parsed.confidence}`);
    }

    // Enforce recommendation logic — override GPT if needed
    let recommendation;
    if (grade >= 8 && confidence > 0.7) {
      recommendation = 'GRADE';
    } else if (grade >= 6) {
      recommendation = 'SELL_RAW';
    } else {
      recommendation = 'PASS';
    }

    const result = {
      estimatedGrade: `PSA ${grade}`,
      confidence: Math.round(confidence * 100) / 100,
      details: {
        corners:    Number(parsed.details?.corners)    || grade,
        edges:      Number(parsed.details?.edges)      || grade,
        surface:    Number(parsed.details?.surface)    || grade,
        centering:  Number(parsed.details?.centering)  || grade,
      },
      recommendation,
      notes: String(parsed.notes || '').slice(0, 200),
      analyzedAt: new Date().toISOString(),
    };

    console.log(`[Grader] ${label} → ${result.estimatedGrade} (${Math.round(result.confidence * 100)}% conf) → ${result.recommendation}`);
    return result;

  } catch (err) {
    // Always fail gracefully — a grading error must never block a deal
    console.error(`[Grader] Vision API error for ${label}:`, err.message);
    return null;
  }
}

/**
 * Batch grade multiple images (e.g. for processing auction lots).
 * Runs sequentially to respect rate limits.
 */
async function gradeCardBatch(items) {
  const results = [];
  for (const item of items) {
    results.push(await gradeCard(item.imageUrl, item));
  }
  return results;
}

module.exports = { gradeCard, gradeCardBatch };
