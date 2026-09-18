// ============================================================
// JEV CONNECTOR
// TRADING EVALUATION ENGINE V3.2
// ============================================================
//
// Provider:
//   OpenRouter / TypeSafe Jev
//
// Purpose:
//   - Evaluate real-market state
//   - Evaluate LONG / SHORT / HOLD / REDUCE / EXIT / WAIT
//   - Evaluate market structure
//   - Evaluate evidence quality
//   - Evaluate risk compatibility
//   - Evaluate accumulation conditions
//   - Detect thesis invalidation
//   - Evaluate reversal risk
//   - Preserve Jev probabilities, scores and confidence
//
// SECURITY BOUNDARY
// -----------------
// This module NEVER:
//   - places trades
//   - accesses wallets
//   - accesses private keys
//   - withdraws funds
//   - changes exchange permissions
//   - bypasses risk controls
//   - overrides the Trader risk engine
//
// Jev evaluates.
// Trader Risk Engine decides whether execution is permitted.
//
// ============================================================


// ============================================================
// CONFIGURATION
// ============================================================

const OPENROUTER_URL =
  process.env.JEV_DECISIONS_URL ||
  "https://openrouter.ai/api/alpha/decisions";

const JEV_MODEL =
  process.env.JEV_MODEL ||
  "typesafe/jev-1.13";

const ENGINE_NAME =
  "Jev Trading Evaluation Engine";

const ENGINE_VERSION =
  "3.2.0";

const REQUEST_TIMEOUT_MS =
  Number.isFinite(Number(process.env.JEV_TIMEOUT_MS))
    ? Math.max(1_000, Math.min(60_000, Number(process.env.JEV_TIMEOUT_MS)))
    : 20_000;

const MAX_STATE_BYTES =
  Number.isFinite(Number(process.env.JEV_MAX_STATE_BYTES))
    ? Math.max(10_000, Math.min(5_000_000, Number(process.env.JEV_MAX_STATE_BYTES)))
    : 900_000;

const MAX_RESPONSE_BYTES =
  Number.isFinite(Number(process.env.JEV_MAX_RESPONSE_BYTES))
    ? Math.max(10_000, Math.min(5_000_000, Number(process.env.JEV_MAX_RESPONSE_BYTES)))
    : 2_000_000;


// ============================================================
// CONSTANTS
// ============================================================

const VALID_POSITION_SIDES =
  new Set([
    "FLAT",
    "LONG",
    "SHORT"
  ]);

const VALID_DECISIONS =
  new Set([
    "LONG",
    "SHORT",
    "HOLD",
    "REDUCE",
    "EXIT",
    "WAIT"
  ]);

const DIRECTIONAL_DECISIONS =
  new Set([
    "LONG",
    "SHORT"
  ]);

const POSITION_MANAGEMENT_DECISIONS =
  new Set([
    "HOLD",
    "REDUCE",
    "EXIT"
  ]);


// ============================================================
// BASIC HELPERS
// ============================================================

function isObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}


function isFiniteNumber(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value)
  );
}


function clamp01(value) {
  if (!isFiniteNumber(value)) {
    return null;
  }

  return Math.min(
    1,
    Math.max(0, value)
  );
}


function safeNumber(value) {
  if (!isFiniteNumber(value)) {
    return null;
  }

  return value;
}


function safeInteger(value, fallback = null) {
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    Number.isSafeInteger(value)
  ) {
    return value;
  }

  return fallback;
}


function normalizeString(value, fallback = null) {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim();

  return trimmed.length > 0
    ? trimmed
    : fallback;
}


function safeIsoTimestamp(value) {
  if (typeof value !== "string") {
    return null;
  }

  const timestamp = Date.parse(value);

  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return new Date(timestamp).toISOString();
}


function createRequestId() {
  try {
    if (
      globalThis.crypto &&
      typeof globalThis.crypto.randomUUID === "function"
    ) {
      return globalThis.crypto.randomUUID();
    }
  } catch {
    // Fall through to timestamp-based identifier.
  }

  return `jev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}


function byteLength(value) {
  try {
    return Buffer.byteLength(
      value,
      "utf8"
    );
  } catch {
    return new TextEncoder().encode(value).length;
  }
}


function serializeJson(value, label) {
  try {
    return JSON.stringify(value);
  } catch {
    throw new Error(
      `${label} cannot be serialized`
    );
  }
}


// ============================================================
// STATE VALIDATION
// ============================================================

function validateState(state) {
  if (
    state === null ||
    state === undefined
  ) {
    throw new Error(
      "Market state is required"
    );
  }

  const stateType =
    typeof state;

  if (
    stateType !== "object" &&
    stateType !== "string"
  ) {
    throw new Error(
      "Market state must be an object, array, or string"
    );
  }

  const serialized =
    serializeJson(
      state,
      "Market state"
    );

  if (
    byteLength(serialized) > MAX_STATE_BYTES
  ) {
    throw new Error(
      "Market state is too large for Jev evaluation"
    );
  }

  if (
    serialized === undefined
  ) {
    throw new Error(
      "Market state produced no JSON payload"
    );
  }
}


// ============================================================
// POSITION NORMALIZATION
// ============================================================

function normalizePosition(state) {
  const emptyPosition = {
    side: "FLAT",
    size: null,
    entryPrice: null,
    markPrice: null,
    unrealizedPnl: null,
    leverage: null
  };

  if (!isObject(state)) {
    return emptyPosition;
  }

  if (!isObject(state.position)) {
    return emptyPosition;
  }

  const position =
    state.position;

  const rawSide =
    typeof position.side === "string"
      ? position.side.trim().toUpperCase()
      : "FLAT";

  const normalized = {
    side:
      VALID_POSITION_SIDES.has(rawSide)
        ? rawSide
        : "FLAT",

    size:
      safeNumber(position.size),

    entryPrice:
      safeNumber(position.entryPrice),

    markPrice:
      safeNumber(position.markPrice),

    unrealizedPnl:
      safeNumber(position.unrealizedPnl),

    leverage:
      safeNumber(position.leverage)
  };

  return normalized;
}


// ============================================================
// QUESTION DEFINITIONS
// ============================================================

function buildQuestions() {
  return {

    direction: {
      type: "choice",

      instructions:
        "Evaluate the supplied real-market state and select the " +
        "most appropriate current trading decision. Consider market " +
        "structure, trend, momentum, volume, liquidity, volatility, " +
        "derivatives data, current position, invalidation conditions " +
        "and supplied risk information. Do not force a directional " +
        "trade when evidence is insufficient.",

      criteria: {
        LONG:
          "Evidence supports a bullish directional setup or continuation " +
          "that could justify long exposure.",

        SHORT:
          "Evidence supports a bearish directional setup or continuation " +
          "that could justify short exposure.",

        HOLD:
          "An existing position remains supported and should generally " +
          "remain unchanged.",

        REDUCE:
          "Existing exposure should be reduced because risk has increased " +
          "or the strength of the thesis has weakened, but complete exit " +
          "is not clearly required.",

        EXIT:
          "An existing position should be closed because the thesis has " +
          "failed, invalidation conditions are present, or risk has " +
          "materially changed.",

        WAIT:
          "Evidence is insufficient, contradictory, stale, or unreliable " +
          "for a meaningful directional decision."
      }
    },

    accumulation: {
      type: "noul",

      instructions:
        "Determine whether the supplied evidence supports controlled " +
        "additional exposure to an existing position. Do not recommend " +
        "accumulation merely because price moved against the position. " +
        "Consider trend confirmation, liquidity, volatility, current " +
        "exposure, invalidation and risk information."
    },

    bullishStructure: {
      type: "noul",

      instructions:
        "Determine whether the supplied evidence supports bullish " +
        "market structure."
    },

    bearishStructure: {
      type: "noul",

      instructions:
        "Determine whether the supplied evidence supports bearish " +
        "market structure."
    },

    sufficientEvidence: {
      type: "noul",

      instructions:
        "Determine whether the market information is sufficiently " +
        "complete, current and internally consistent for meaningful " +
        "evaluation. Missing or stale information should reduce confidence."
    },

    riskCompatible: {
      type: "noul",

      instructions:
        "Determine whether the evaluated setup is compatible with " +
        "the supplied risk information and current exposure. Missing " +
        "essential risk information must not be treated as acceptable risk."
    },

    setupQuality: {
      type: "score",

      instructions:
        "Rate the overall quality of the supplied trading setup using " +
        "only evidence present in the market state. This is setup quality, " +
        "not probability of profit.",

      criteria: [
        "No usable setup or critically insufficient information.",
        "Very weak setup with major uncertainty or conflicting evidence.",
        "Weak setup with important unresolved risks.",
        "Moderate setup with meaningful supporting evidence.",
        "Strong setup with multiple consistent supporting signals.",
        "Very strong setup with highly consistent evidence, adequate liquidity " +
        "and clearly defined invalidation conditions."
      ]
    },

    accumulationQuality: {
      type: "score",

      instructions:
        "Rate how strongly the supplied evidence supports controlled " +
        "accumulation. Do not reward averaging down merely because a " +
        "position is losing.",

      criteria: [
        "Accumulation is unsupported or inappropriate.",
        "Very weak accumulation case with major uncertainty.",
        "Weak accumulation case with important unresolved risks.",
        "Moderate accumulation case with meaningful confirmation.",
        "Strong accumulation case with good confirmation and controlled conditions."
      ]
    },

    thesisInvalidated: {
      type: "noul",

      instructions:
        "Determine whether the current trading thesis has been materially " +
        "invalidated by the supplied market state."
    },

    reversalRisk: {
      type: "score",

      instructions:
        "Rate the current risk of a meaningful reversal against the " +
        "evaluated direction.",

      criteria: [
        "Very low reversal risk.",
        "Low reversal risk.",
        "Moderate reversal risk.",
        "High reversal risk.",
        "Very high reversal risk."
      ]
    }
  };
}


// ============================================================
// ANSWER PARSERS
// ============================================================

function parseNoul(answer) {
  if (!isObject(answer)) {
    return null;
  }

  if (typeof answer.noul === "number") {
    return clamp01(answer.noul);
  }

  if (typeof answer.probability === "number") {
    return clamp01(answer.probability);
  }

  if (typeof answer.value === "number") {
    return clamp01(answer.value);
  }

  return null;
}


function normalizeProbabilityMap(probabilities) {
  if (!isObject(probabilities)) {
    return {};
  }

  const output = {};

  for (const [key, value] of Object.entries(probabilities)) {
    const probability =
      clamp01(
        typeof value === "number"
          ? value
          : null
      );

    if (probability !== null) {
      output[key] = probability;
    }
  }

  return output;
}


function parseChoice(answer) {
  if (!isObject(answer)) {
    return {
      choice: null,
      probabilities: {},
      confidence: null
    };
  }

  const probabilities =
    normalizeProbabilityMap(
      answer.probabilities
    );

  const rawChoice =
    normalizeString(
      answer.choice
    );

  return {
    choice:
      rawChoice
        ? rawChoice.toUpperCase()
        : null,

    probabilities,

    confidence:
      clamp01(
        answer.confidence
      )
  };
}


function parseScore(answer) {
  if (!isObject(answer)) {
    return {
      score: null,
      probabilities: {},
      confidence: null
    };
  }

  const probabilities =
    normalizeProbabilityMap(
      answer.probabilities
    );

  return {
    score:
      safeNumber(
        answer.score
      ),

    probabilities,

    confidence:
      clamp01(
        answer.confidence
      )
  };
}


// ============================================================
// ANSWER NORMALIZATION
// ============================================================

function normalizeAnswers(answers) {
  if (!isObject(answers)) {
    throw new Error(
      "Jev response contains no valid answers object"
    );
  }

  const direction =
    parseChoice(
      answers.direction
    );

  const accumulation =
    parseNoul(
      answers.accumulation
    );

  const bullishStructure =
    parseNoul(
      answers.bullishStructure
    );

  const bearishStructure =
    parseNoul(
      answers.bearishStructure
    );

  const sufficientEvidence =
    parseNoul(
      answers.sufficientEvidence
    );

  const riskCompatible =
    parseNoul(
      answers.riskCompatible
    );

  const thesisInvalidated =
    parseNoul(
      answers.thesisInvalidated
    );

  const setupQuality =
    parseScore(
      answers.setupQuality
    );

  const accumulationQuality =
    parseScore(
      answers.accumulationQuality
    );

  const reversalRisk =
    parseScore(
      answers.reversalRisk
    );

  const selectedDirection =
    VALID_DECISIONS.has(
      direction.choice
    )
      ? direction.choice
      : "WAIT";

  return {
    direction: {
      choice:
        selectedDirection,

      probabilities:
        direction.probabilities,

      confidence:
        direction.confidence
    },

    probabilities: {
      accumulation,
      bullishStructure,
      bearishStructure,
      sufficientEvidence,
      riskCompatible,
      thesisInvalidated
    },

    scores: {
      setupQuality:
        setupQuality.score,

      accumulationQuality:
        accumulationQuality.score,

      reversalRisk:
        reversalRisk.score
    },

    confidence: {
      direction:
        direction.confidence,

      setupQuality:
        setupQuality.confidence,

      accumulationQuality:
        accumulationQuality.confidence,

      reversalRisk:
        reversalRisk.confidence
    },

    probabilityDistributions: {
      direction:
        direction.probabilities,

      setupQuality:
        setupQuality.probabilities,

      accumulationQuality:
        accumulationQuality.probabilities,

      reversalRisk:
        reversalRisk.probabilities
    }
  };
}


// ============================================================
// CONSISTENCY ANALYSIS
// ============================================================

function analyzeConsistency(
  decision,
  position
) {
  const warnings = [];
  const hardWarnings = [];

  const selected =
    decision.direction.choice;

  if (!VALID_DECISIONS.has(selected)) {
    hardWarnings.push(
      "Jev returned an invalid trading decision."
    );
  }

  if (
    position.side === "FLAT" &&
    POSITION_MANAGEMENT_DECISIONS.has(selected)
  ) {
    warnings.push(
      `${selected} was selected while the supplied position is FLAT.`
    );
  }

  if (
    position.side === "FLAT" &&
    decision.probabilities.accumulation !== null &&
    decision.probabilities.accumulation >= 0.5
  ) {
    warnings.push(
      "Accumulation probability is elevated while the supplied position is FLAT."
    );
  }

  if (
    decision.probabilities.sufficientEvidence !== null &&
    decision.probabilities.sufficientEvidence < 0.5 &&
    DIRECTIONAL_DECISIONS.has(selected)
  ) {
    hardWarnings.push(
      "Directional exposure was selected despite insufficient evidence."
    );
  }

  if (
    decision.probabilities.riskCompatible !== null &&
    decision.probabilities.riskCompatible < 0.5 &&
    (
      DIRECTIONAL_DECISIONS.has(selected) ||
      selected === "HOLD"
    )
  ) {
    hardWarnings.push(
      "Risk compatibility is weak for the selected direction."
    );
  }

  if (
    decision.probabilities.thesisInvalidated !== null &&
    decision.probabilities.thesisInvalidated >= 0.5 &&
    position.side !== "FLAT" &&
    selected !== "EXIT" &&
    selected !== "REDUCE"
  ) {
    hardWarnings.push(
      "Thesis invalidation probability is elevated without EXIT or REDUCE."
    );
  }

  const bullish =
    decision.probabilities.bullishStructure;

  const bearish =
    decision.probabilities.bearishStructure;

  if (
    bullish !== null &&
    bearish !== null &&
    bullish >= 0.5 &&
    bearish >= 0.5
  ) {
    warnings.push(
      "Both bullish and bearish structure probabilities are elevated."
    );
  }

  if (
    selected === "LONG" &&
    bearish !== null &&
    bearish >= 0.75
  ) {
    hardWarnings.push(
      "LONG conflicts with strongly elevated bearish-structure probability."
    );
  }

  if (
    selected === "SHORT" &&
    bullish !== null &&
    bullish >= 0.75
  ) {
    hardWarnings.push(
      "SHORT conflicts with strongly elevated bullish-structure probability."
    );
  }

  if (
    decision.scores.reversalRisk !== null &&
    decision.scores.reversalRisk >= 4 &&
    DIRECTIONAL_DECISIONS.has(selected)
  ) {
    warnings.push(
      "Directional decision carries high reversal-risk score."
    );
  }

  return {
    consistent:
      warnings.length === 0 &&
      hardWarnings.length === 0,

    warnings,

    hardWarnings,

    severity:
      hardWarnings.length > 0
        ? "HIGH"
        : warnings.length > 0
          ? "MEDIUM"
          : "NONE"
  };
}


// ============================================================
// RESPONSE EXTRACTION
// ============================================================

function extractAnswers(result) {
  if (!isObject(result)) {
    return null;
  }

  if (isObject(result.answers)) {
    return result.answers;
  }

  if (
    isObject(result.data) &&
    isObject(result.data.answers)
  ) {
    return result.data.answers;
  }

  if (
    isObject(result.result) &&
    isObject(result.result.answers)
  ) {
    return result.result.answers;
  }

  if (
    isObject(result.output) &&
    isObject(result.output.answers)
  ) {
    return result.output.answers;
  }

  return null;
}


function extractProviderRequestId(result) {
  if (!isObject(result)) {
    return null;
  }

  return (
    normalizeString(result.id) ||
    normalizeString(result.request_id) ||
    normalizeString(result.requestId) ||
    normalizeString(result.data?.id)
  );
}


function extractResolvedModel(result) {
  if (!isObject(result)) {
    return JEV_MODEL;
  }

  return (
    normalizeString(result.model) ||
    normalizeString(result.data?.model) ||
    JEV_MODEL
  );
}


function extractUsage(result) {
  if (!isObject(result)) {
    return null;
  }

  const usage =
    result.usage ||
    result.data?.usage ||
    null;

  if (!isObject(usage)) {
    return null;
  }

  return usage;
}


// ============================================================
// OPENROUTER REQUEST
// ============================================================

async function requestJev(
  state,
  questions
) {
  const apiKey =
    typeof process.env.OPENROUTER_API_KEY === "string"
      ? process.env.OPENROUTER_API_KEY.trim()
      : "";

  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is not configured"
    );
  }

  const requestId =
    createRequestId();

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS
    );

  const payload = {
    model:
      JEV_MODEL,

    state,

    questions
  };

  let response;

  try {
    response =
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
              process.env.OPENROUTER_HTTP_REFERER ||
              "https://jev-connector.onrender.com",

            "X-Title":
              process.env.OPENROUTER_X_TITLE ||
              "Jev Connector",

            "X-Jev-Request-Id":
              requestId
          },

          body:
            serializeJson(
              payload,
              "Jev request"
            ),

          signal:
            controller.signal
        }
      );
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(
        `OpenRouter Jev request timed out after ${REQUEST_TIMEOUT_MS} ms`
      );
    }

    throw new Error(
      `OpenRouter Jev network request failed: ${
        normalizeString(error?.message, "unknown network error")
      }`
    );
  } finally {
    clearTimeout(timeout);
  }

  const responseText =
    await response.text();

  if (
    byteLength(responseText) > MAX_RESPONSE_BYTES
  ) {
    throw new Error(
      "OpenRouter Jev response is too large"
    );
  }

  let result = {};

  if (responseText.trim()) {
    try {
      result =
        JSON.parse(
          responseText
        );
    } catch {
      throw new Error(
        `OpenRouter returned invalid JSON (HTTP ${response.status})`
      );
    }
  }

  if (!response.ok) {
    const providerMessage =
      normalizeString(result?.error?.message) ||
      normalizeString(result?.error) ||
      normalizeString(result?.message) ||
      `HTTP ${response.status}`;

    throw new Error(
      `OpenRouter Jev request failed: ${providerMessage}`
    );
  }

  if (!isObject(result)) {
    throw new Error(
      "OpenRouter Jev returned an invalid response"
    );
  }

  const answers =
    extractAnswers(result);

  if (!answers) {
    throw new Error(
      "OpenRouter Jev returned no structured answers"
    );
  }

  return {
    result,
    requestId
  };
}


// ============================================================
// EVALUATION STATE
// ============================================================

function buildEvaluationState(
  state,
  position
) {
  return {
    market:
      state,

    currentPosition:
      position,

    environment: {
      marketType:
        "real_market",

      predictionMarkets:
        false,

      longAllowed:
        true,

      shortAllowed:
        true,

      accumulationAllowed:
        true
    },

    systemBoundary: {
      executionEnabled:
        false,

      walletAccess:
        false,

      privateKeysAvailable:
        false,

      withdrawalsEnabled:
        false,

      exchangePermissionChanges:
        false,

      riskOverrideAllowed:
        false
    },

    evaluationRules: [
      "Evaluate only the supplied evidence.",
      "Do not invent missing market information.",
      "Missing information is uncertainty, not positive evidence.",
      "Do not force a trade.",
      "WAIT is a valid decision.",
      "Accumulation must not become uncontrolled averaging.",
      "Long and short setups are both permitted.",
      "Prediction-market logic is forbidden.",
      "A setup score is not a profit probability.",
      "Jev does not authorize execution.",
      "Risk controls have authority over Jev.",
      "If evidence is contradictory, prefer WAIT or risk reduction."
    ]
  };
}


// ============================================================
// MAIN EVALUATION FUNCTION
// ============================================================

export async function evaluateMarketState(
  state
) {
  validateState(state);

  const position =
    normalizePosition(state);

  const questions =
    buildQuestions();

  const evaluationState =
    buildEvaluationState(
      state,
      position
    );

  const requestedAt =
    new Date().toISOString();

  const request =
    await requestJev(
      evaluationState,
      questions
    );

  const result =
    request.result;

  const answers =
    extractAnswers(result);

  const decision =
    normalizeAnswers(
      answers
    );

  const consistency =
    analyzeConsistency(
      decision,
      position
    );

  const directionConfidence =
    decision.confidence.direction;

  const resolvedModel =
    extractResolvedModel(
      result
    );

  const providerRequestId =
    extractProviderRequestId(
      result
    ) ||
    request.requestId;

  const responseTimestamp =
    safeIsoTimestamp(
      result.timestamp
    );

  return {
    engine: {
      name:
        ENGINE_NAME,

      version:
        ENGINE_VERSION,

      provider:
        "openrouter",

      requestedModel:
        JEV_MODEL,

      resolvedModel
    },

    request: {
      requestId:
        request.requestId,

      requestedAt,

      endpoint:
        OPENROUTER_URL,

      timeoutMs:
        REQUEST_TIMEOUT_MS
    },

    position,

    decision,

    confidence: {
      direction:
        directionConfidence
    },

    usage:
      extractUsage(result),

    providerRequestId,

    consistency,

    safety: {
      executionApproved:
        false,

      requiresTraderRiskReview:
        true,

      blockExecutionWhenInconsistent:
        true,

      blockReasons:
        consistency.hardWarnings
    },

    execution: {
      allowed:
        false,

      reason:
        "Jev is evaluation-only. A separate Trader Risk Engine must approve any future action."
    },

    security: {
      walletAccess:
        false,

      privateKeys:
        false,

      withdrawals:
        false,

      execution:
        false,

      exchangePermissionChanges:
        false
    },

    timestamp:
      responseTimestamp ||
      new Date().toISOString()
  };
}


// ============================================================
// ENGINE INFORMATION
// ============================================================

export function getJevEngineStatus() {
  return {
    name:
      ENGINE_NAME,

    version:
      ENGINE_VERSION,

    provider:
      "openrouter",

    model:
      JEV_MODEL,

    endpointConfigured:
      Boolean(OPENROUTER_URL),

    apiKeyConfigured:
      Boolean(
        typeof process.env.OPENROUTER_API_KEY === "string" &&
        process.env.OPENROUTER_API_KEY.trim()
      ),

    executionEnabled:
      false,

    walletAccess:
      false,

    privateKeys:
      false,

    withdrawals:
      false
  };
}


export function getJevQuestions() {
  return buildQuestions();
}


// ============================================================
// DEFAULT EXPORT
// ============================================================

export default {
  evaluateMarketState,
  getJevEngineStatus,
  getJevQuestions
};
