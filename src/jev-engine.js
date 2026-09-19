// jev-engine.js
// Jev Trading Evaluation Engine V4.0.0
//
// Purpose:
// - Market evaluation only
// - Uses current OpenRouter-compatible API
// - Uses TypeSafe Jev
// - Returns structured trading evaluation
// - Deterministic safety layer
// - NEVER executes trades
// - NEVER accesses wallets
// - NEVER accesses private keys
// - NEVER enables live trading
//
// Required:
//   OPENROUTER_API_KEY
//
// Optional:
//   JEV_MODEL
//   JEV_TIMEOUT_MS
//
// Current default model:
//   ~typesafe/jev-latest
//
// Current OpenRouter API:
//   https://openrouter.ai/api/v1/chat/completions

const OPENROUTER_URL =
  "https://openrouter.ai/api/v1/chat/completions";

const JEV_MODEL =
  process.env.JEV_MODEL ||
  "~typesafe/jev-latest";

const TIMEOUT_MS =
  Number(process.env.JEV_TIMEOUT_MS) || 30000;

const ENGINE_NAME =
  "Jev Trading Evaluation Engine";

const ENGINE_VERSION =
  "4.0.0";

const VALID_DECISIONS = new Set([
  "LONG",
  "SHORT",
  "HOLD",
  "REDUCE",
  "EXIT",
  "WAIT"
]);

const VALID_POSITION_SIDES = new Set([
  "FLAT",
  "LONG",
  "SHORT"
]);

const MAX_STATE_BYTES = 900000;
const MAX_RESPONSE_BYTES = 2000000;


// --------------------------------------------------
// Utility
// --------------------------------------------------

function isObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function jsonSize(value) {
  try {
    return Buffer.byteLength(
      JSON.stringify(value),
      "utf8"
    );
  } catch {
    return Infinity;
  }
}

function clamp(value, min, max) {
  return Math.min(
    max,
    Math.max(min, value)
  );
}

function normalizeProbability(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return null;
  }

  if (number > 1) {
    return clamp(number / 100, 0, 1);
  }

  return clamp(number, 0, 1);
}

function normalizeDecision(value) {
  if (
    typeof value !== "string"
  ) {
    return null;
  }

  const decision =
    value
      .trim()
      .toUpperCase();

  return VALID_DECISIONS.has(decision)
    ? decision
    : null;
}


// --------------------------------------------------
// Position
// --------------------------------------------------

function normalizePosition(position = {}) {
  const rawSide =
    typeof position.side === "string"
      ? position.side.toUpperCase()
      : "FLAT";

  return {
    side:
      VALID_POSITION_SIDES.has(rawSide)
        ? rawSide
        : "FLAT",

    size:
      Number.isFinite(Number(position.size))
        ? Number(position.size)
        : 0,

    entryPrice:
      Number.isFinite(Number(position.entryPrice))
        ? Number(position.entryPrice)
        : null,

    unrealizedPnl:
      Number.isFinite(Number(position.unrealizedPnl))
        ? Number(position.unrealizedPnl)
        : null
  };
}


// --------------------------------------------------
// Validation
// --------------------------------------------------

function validateMarketData(marketData) {
  if (!isObject(marketData)) {
    throw new Error(
      "Invalid market data"
    );
  }

  if (
    jsonSize(marketData) >
    MAX_STATE_BYTES
  ) {
    throw new Error(
      "Market data is too large"
    );
  }

  return true;
}


// --------------------------------------------------
// System prompt
// --------------------------------------------------

function buildSystemPrompt() {
  return `
You are Jev, a structured market-evaluation engine.

Your job is ONLY to evaluate the supplied market state.

You are NOT a trade executor.

You do NOT:
- place orders
- access wallets
- access private keys
- withdraw funds
- change exchange permissions
- override risk controls
- invent missing market information

You MUST:
- use only information supplied in the input
- distinguish evidence from uncertainty
- allow WAIT when evidence is insufficient
- avoid forcing a trade
- consider the current position
- consider risk information
- return exactly one decision

Valid decisions:

LONG
SHORT
HOLD
REDUCE
EXIT
WAIT

Decision meanings:

LONG:
Evidence supports bullish exposure.

SHORT:
Evidence supports bearish exposure.

HOLD:
An existing position remains justified.

REDUCE:
An existing position should have lower exposure.

EXIT:
An existing position should be closed.

WAIT:
Evidence is insufficient, contradictory, or uncertain.

Safety has priority over aggressiveness.

If evidence is insufficient or contradictory,
prefer WAIT.

Return ONLY valid JSON.
Do not return markdown.
Do not return explanations outside the JSON.
`.trim();
}


// --------------------------------------------------
// User prompt
// --------------------------------------------------

function buildUserPrompt(
  marketData,
  position
) {
  return `
Evaluate the following market state.

MARKET DATA:
${JSON.stringify(
  marketData,
  null,
  2
)}

CURRENT POSITION:
${JSON.stringify(
  position,
  null,
  2
)}

Return JSON with exactly this structure:

{
  "decision": "LONG | SHORT | HOLD | REDUCE | EXIT | WAIT",
  "confidence": 0.0,
  "bullishProbability": 0.0,
  "bearishProbability": 0.0,
  "evidence": {
    "sufficient": true,
    "bullishStructure": 0.0,
    "bearishStructure": 0.0,
    "accumulation": 0.0,
    "reversalRisk": 0.0,
    "thesisInvalidated": 0.0,
    "riskCompatible": true
  },
  "reason": "Short factual explanation based only on supplied data"
}

All probability values must be between 0 and 1.

Do not invent prices, indicators, news,
volume data, order flow, or other information.
`.trim();
}


// --------------------------------------------------
// JSON extraction
// --------------------------------------------------

function extractJson(text) {
  if (
    typeof text !== "string"
  ) {
    return null;
  }

  const cleaned =
    text
      .trim()
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    // Try extracting the first JSON object.
  }

  const start =
    cleaned.indexOf("{");

  const end =
    cleaned.lastIndexOf("}");

  if (
    start === -1 ||
    end === -1 ||
    end <= start
  ) {
    return null;
  }

  try {
    return JSON.parse(
      cleaned.slice(
        start,
        end + 1
      )
    );
  } catch {
    return null;
  }
}


// --------------------------------------------------
// OpenRouter request
// --------------------------------------------------

async function requestJev(
  marketData,
  position
) {
  const apiKey =
    process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is not configured"
    );
  }

  const requestId =
    `jev-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 10)}`;

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      TIMEOUT_MS
    );

  try {
    const response =
      await fetch(
        OPENROUTER_URL,
        {
          method: "POST",

          headers: {
            "Authorization":
              `Bearer ${apiKey}`,

            "Content-Type":
              "application/json",

            "HTTP-Referer":
              "https://jev-connector.onrender.com",

            "X-Title":
              "Jev Trading Evaluation Engine",

            "X-Request-ID":
              requestId
          },

          body:
            JSON.stringify({
              model:
                JEV_MODEL,

              messages: [
                {
                  role:
                    "system",

                  content:
                    buildSystemPrompt()
                },

                {
                  role:
                    "user",

                  content:
                    buildUserPrompt(
                      marketData,
                      position
                    )
                }
              ],

              temperature:
                0,

              max_tokens:
                1200
            }),

          signal:
            controller.signal
        }
      );

    const text =
      await response.text();

    if (
      Buffer.byteLength(
        text,
        "utf8"
      ) > MAX_RESPONSE_BYTES
    ) {
      throw new Error(
        "OpenRouter response is too large"
      );
    }

    let data;

    try {
      data =
        JSON.parse(text);
    } catch {
      throw new Error(
        `OpenRouter returned invalid JSON (HTTP ${response.status})`
      );
    }

    if (!response.ok) {
      const message =
        data?.error?.message ||
        data?.error ||
        data?.message ||
        `HTTP ${response.status}`;

      throw new Error(
        `OpenRouter request failed: ${message}`
      );
    }

    const content =
      data?.choices?.[0]?.message?.content;

    if (
      typeof content !== "string" ||
      !content.trim()
    ) {
      throw new Error(
        "Jev returned no decision content"
      );
    }

    const parsed =
      extractJson(content);

    if (!parsed) {
      throw new Error(
        "Jev returned non-structured decision data"
      );
    }

    return {
      requestId,

      providerRequestId:
        data?.id || null,

      model:
        data?.model ||
        JEV_MODEL,

      decision:
        parsed,

      usage:
        data?.usage || null
    };

  } catch (error) {
    if (
      error?.name ===
      "AbortError"
    ) {
      throw new Error(
        `Jev request timed out after ${TIMEOUT_MS}ms`
      );
    }

    throw error;

  } finally {
    clearTimeout(timeout);
  }
}


// --------------------------------------------------
// Normalize Jev response
// --------------------------------------------------

function normalizeDecisionResult(
  result
) {
  const raw =
    result?.decision || {};

  const decision =
    normalizeDecision(
      raw.decision
    );

  const confidence =
    normalizeProbability(
      raw.confidence
    );

  const bullishProbability =
    normalizeProbability(
      raw.bullishProbability
    );

  const bearishProbability =
    normalizeProbability(
      raw.bearishProbability
    );

  const evidence =
    isObject(raw.evidence)
      ? raw.evidence
      : {};

  return {
    decision,

    confidence,

    bullishProbability,

    bearishProbability,

    evidence: {
      sufficient:
        evidence.sufficient === true,

      bullishStructure:
        normalizeProbability(
          evidence.bullishStructure
        ),

      bearishStructure:
        normalizeProbability(
          evidence.bearishStructure
        ),

      accumulation:
        normalizeProbability(
          evidence.accumulation
        ),

      reversalRisk:
        normalizeProbability(
          evidence.reversalRisk
        ),

      thesisInvalidated:
        normalizeProbability(
          evidence.thesisInvalidated
        ),

      riskCompatible:
        evidence.riskCompatible === true
    },

    reason:
      typeof raw.reason === "string"
        ? raw.reason.slice(0, 1000)
        : ""
  };
}


// --------------------------------------------------
// Safety / consistency
// --------------------------------------------------

function analyzeConsistency(
  result,
  position
) {
  const warnings = [];
  const hardWarnings = [];

  const decision =
    result.decision;

  const evidence =
    result.evidence;

  if (!decision) {
    hardWarnings.push(
      "No valid decision returned."
    );
  }

  if (
    !evidence.sufficient &&
    (
      decision === "LONG" ||
      decision === "SHORT"
    )
  ) {
    hardWarnings.push(
      "Directional decision returned despite insufficient evidence."
    );
  }

  if (
    !evidence.riskCompatible
  ) {
    hardWarnings.push(
      "Decision is not risk compatible."
    );
  }

  if (
    evidence.thesisInvalidated !== null &&
    evidence.thesisInvalidated >= 0.70 &&
    (
      decision === "LONG" ||
      decision === "SHORT" ||
      position.side !== "FLAT"
    )
  ) {
    hardWarnings.push(
      "Trading thesis appears invalidated."
    );
  }

  if (
    evidence.reversalRisk !== null &&
    evidence.reversalRisk >= 0.75 &&
    (
      decision === "LONG" ||
      decision === "SHORT"
    )
  ) {
    warnings.push(
      "High reversal risk."
    );
  }

  if (
    evidence.bullishStructure !== null &&
    evidence.bearishStructure !== null &&
    evidence.bullishStructure >= 0.75 &&
    evidence.bearishStructure >= 0.75
  ) {
    warnings.push(
      "Bullish and bearish structure are both elevated."
    );
  }

  if (
    position.side === "FLAT" &&
    (
      decision === "HOLD" ||
      decision === "REDUCE" ||
      decision === "EXIT"
    )
  ) {
    warnings.push(
      `${decision} returned while position is FLAT.`
    );
  }

  return {
    consistent:
      hardWarnings.length === 0,

    warnings,

    hardWarnings,

    blockExecution:
      hardWarnings.length > 0
  };
}


// --------------------------------------------------
// Main market evaluation
// --------------------------------------------------

async function evaluateMarketState(
  marketData,
  options = {}
) {
  validateMarketData(
    marketData
  );

  const position =
    normalizePosition(
      marketData.position ||
      options.currentPosition ||
      {}
    );

  const provider =
    await requestJev(
      marketData,
      position
    );

  const normalized =
    normalizeDecisionResult(
      provider
    );

  const consistency =
    analyzeConsistency(
      normalized,
      position
    );

  /*
   * Deterministic safety rule:
   *
   * If Jev produces an unsafe/inconsistent
   * directional answer, the connector changes
   * the result to WAIT.
   */
  let finalDecision =
    normalized.decision;

  if (
    consistency.blockExecution &&
    (
      finalDecision === "LONG" ||
      finalDecision === "SHORT"
    )
  ) {
    finalDecision =
      "WAIT";
  }

  return {
    engine: {
      name:
        ENGINE_NAME,

      version:
        ENGINE_VERSION,

      model:
        provider.model
    },

    request: {
      requestId:
        provider.requestId,

      providerRequestId:
        provider.providerRequestId
    },

    position,

    decision:
      finalDecision,

    rawDecision:
      normalized.decision,

    confidence:
      normalized.confidence,

    probabilities: {
      bullish:
        normalized.bullishProbability,

      bearish:
        normalized.bearishProbability
    },

    evidence:
      normalized.evidence,

    reason:
      normalized.reason,

    consistency,

    usage:
      provider.usage,

    safety: {
      executionApproved:
        false,

      executionAllowed:
        false,

      paperTrading:
        true,

      liveTrading:
        false,

      walletAccess:
        false,

      privateKeysAvailable:
        false,

      withdrawalsEnabled:
        false,

      riskOverrideAllowed:
        false
    },

    execution: {
      allowed:
        false,

      executed:
        false
    },

    timestamp:
      new Date().toISOString()
  };
}


// --------------------------------------------------
// Engine status
// --------------------------------------------------

function getJevEngineStatus() {
  return {
    ok: true,

    engine:
      ENGINE_NAME,

    version:
      ENGINE_VERSION,

    model:
      JEV_MODEL,

    endpoint:
      OPENROUTER_URL,

    apiKeyConfigured:
      Boolean(
        process.env.OPENROUTER_API_KEY
      ),

    execution: {
      paper:
        true,

      live:
        false,

      executor:
        false
    },

    security: {
      walletAccess:
        false,

      privateKeys:
        false,

      withdrawals:
        false
    }
  };
}


// --------------------------------------------------
// Questions / capabilities
// --------------------------------------------------

function getJevQuestions() {
  return {
    decisions: [
      "LONG",
      "SHORT",
      "HOLD",
      "REDUCE",
      "EXIT",
      "WAIT"
    ],

    evidence: [
      "sufficient",
      "bullishStructure",
      "bearishStructure",
      "accumulation",
      "reversalRisk",
      "thesisInvalidated",
      "riskCompatible"
    ],

    execution:
      false
  };
}


// --------------------------------------------------
// Exports
// --------------------------------------------------

export {
  evaluateMarketState,
  getJevEngineStatus,
  getJevQuestions
};

export default {
  evaluateMarketState,
  getJevEngineStatus,
  getJevQuestions
};
