// ============================================================
// JEV CONNECTOR
// TRADING EVALUATION ENGINE V3.1
// ============================================================
//
// Provider:
//   OpenRouter Decisions API
//
// Model:
//   TypeSafe Jev 1.13
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
//   - Preserve Jev probabilities and confidence
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
// Other modules decide whether execution is permitted.
//
// ============================================================


// ============================================================
// CONFIGURATION
// ============================================================

const OPENROUTER_URL =
  "https://openrouter.ai/api/alpha/decisions";

const JEV_MODEL =
  process.env.JEV_MODEL ||
  "typesafe/jev-1.13";

const ENGINE_NAME =
  "Jev Trading Evaluation Engine";

const ENGINE_VERSION =
  "3.1.0";

const REQUEST_TIMEOUT_MS =
  20_000;

const MAX_STATE_BYTES =
  900_000;


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


function clamp01(value) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value)
  ) {
    return null;
  }

  return Math.min(
    1,
    Math.max(0, value)
  );
}


function safeNumber(value) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value)
  ) {
    return null;
  }

  return value;
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


  let serialized;

  try {
    serialized =
      JSON.stringify(state);
  } catch {
    throw new Error(
      "Market state cannot be serialized"
    );
  }


  if (
    typeof serialized === "string" &&
    Buffer.byteLength(
      serialized,
      "utf8"
    ) > MAX_STATE_BYTES
  ) {
    throw new Error(
      "Market state is too large for Jev evaluation"
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


  if (
    !isObject(state)
  ) {
    return emptyPosition;
  }


  if (
    !isObject(state.position)
  ) {
    return emptyPosition;
  }


  const position =
    state.position;


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
      position.size ?? null,

    entryPrice:
      position.entryPrice ?? null,

    markPrice:
      position.markPrice ?? null,

    unrealizedPnl:
      position.unrealizedPnl ?? null,

    leverage:
      position.leverage ?? null
  };
}


// ============================================================
// QUESTION DEFINITIONS
// ============================================================
//
// OpenRouter's native Jev Decisions API uses:
//
//   noul    -> yes/no probability
//   choice  -> selected option + probability distribution
//   score   -> ordered numerical score + distribution
//
// ============================================================

function buildQuestions() {

  return {

    // --------------------------------------------------------
    // DIRECTION
    // --------------------------------------------------------

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


    // --------------------------------------------------------
    // ACCUMULATION
    // --------------------------------------------------------

    accumulation: {

      type: "noul",

      instructions:
        "Determine whether the supplied evidence supports controlled " +
        "additional exposure to an existing position. Do not recommend " +
        "accumulation merely because price moved against the position. " +
        "Consider trend confirmation, liquidity, volatility, current " +
        "exposure, invalidation and risk information."
    },


    // --------------------------------------------------------
    // BULLISH STRUCTURE
    // --------------------------------------------------------

    bullishStructure: {

      type: "noul",

      instructions:
        "Determine whether the supplied evidence supports bullish " +
        "market structure."
    },


    // --------------------------------------------------------
    // BEARISH STRUCTURE
    // --------------------------------------------------------

    bearishStructure: {

      type: "noul",

      instructions:
        "Determine whether the supplied evidence supports bearish " +
        "market structure."
    },


    // --------------------------------------------------------
    // EVIDENCE
    // --------------------------------------------------------

    sufficientEvidence: {

      type: "noul",

      instructions:
        "Determine whether the market information is sufficiently " +
        "complete, current and internally consistent for meaningful " +
        "evaluation. Missing or stale information should reduce confidence."
    },


    // --------------------------------------------------------
    // RISK
    // --------------------------------------------------------

    riskCompatible: {

      type: "noul",

      instructions:
        "Determine whether the evaluated setup is compatible with " +
        "the supplied risk information and current exposure. Missing " +
        "essential risk information must not be treated as acceptable risk."
    },


    // --------------------------------------------------------
    // SETUP QUALITY
    // --------------------------------------------------------

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


    // --------------------------------------------------------
    // ACCUMULATION QUALITY
    // --------------------------------------------------------

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


    // --------------------------------------------------------
    // THESIS INVALIDATION
    // --------------------------------------------------------

    thesisInvalidated: {

      type: "noul",

      instructions:
        "Determine whether the current trading thesis has been materially " +
        "invalidated by the supplied market state."
    },


    // --------------------------------------------------------
    // REVERSAL RISK
    // --------------------------------------------------------

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

  if (
    !isObject(answer)
  ) {
    return null;
  }


  // Native OpenRouter / Jev field.
  if (
    typeof answer.noul === "number"
  ) {
    return clamp01(
      answer.noul
    );
  }


  // Compatibility with other Jev adapters.
  if (
    typeof answer.probability === "number"
  ) {
    return clamp01(
      answer.probability
    );
  }


  return null;
}


function parseChoice(answer) {

  if (
    !isObject(answer)
  ) {
    return {
      choice: null,
      probabilities: {},
      confidence: null
    };
  }


  const probabilities =
    isObject(answer.probabilities)
      ? answer.probabilities
      : {};


  return {

    choice:
      typeof answer.choice === "string"
        ? answer.choice
        : null,

    probabilities,

    confidence:
      clamp01(
        answer.confidence
      )
  };
}


function parseScore(answer) {

  if (
    !isObject(answer)
  ) {
    return {
      score: null,
      probabilities: {},
      confidence: null
    };
  }


  const probabilities =
    isObject(answer.probabilities)
      ? answer.probabilities
      : {};


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

  if (
    !isObject(answers)
  ) {
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


  // ----------------------------------------------------------
  // Direction validity
  // ----------------------------------------------------------

  if (
    !VALID_DECISIONS.has(
      decision.direction.choice
    )
  ) {

    warnings.push(
      "Jev returned an invalid trading decision."
    );
  }


  // ----------------------------------------------------------
  // Flat position checks
  // ----------------------------------------------------------

  if (
    position.side === "FLAT" &&
    (
      decision.direction.choice === "HOLD" ||
      decision.direction.choice === "REDUCE" ||
      decision.direction.choice === "EXIT"
    )
  ) {

    warnings.push(
      `${decision.direction.choice} was selected while the supplied position is FLAT.`
    );
  }


  // ----------------------------------------------------------
  // Accumulation
  // ----------------------------------------------------------

  if (
    position.side === "FLAT" &&
    decision.probabilities.accumulation !== null &&
    decision.probabilities.accumulation >= 0.5
  ) {

    warnings.push(
      "Accumulation probability is elevated while the supplied position is FLAT."
    );
  }


  // ----------------------------------------------------------
  // Evidence
  // ----------------------------------------------------------

  if (
    decision.probabilities.sufficientEvidence !== null &&
    decision.probabilities.sufficientEvidence < 0.5 &&
    (
      decision.direction.choice === "LONG" ||
      decision.direction.choice === "SHORT"
    )
  ) {

    warnings.push(
      "Directional exposure was selected despite insufficient evidence."
    );
  }


  // ----------------------------------------------------------
  // Risk
  // ----------------------------------------------------------

  if (
    decision.probabilities.riskCompatible !== null &&
    decision.probabilities.riskCompatible < 0.5 &&
    (
      decision.direction.choice === "LONG" ||
      decision.direction.choice === "SHORT" ||
      decision.direction.choice === "HOLD"
    )
  ) {

    warnings.push(
      "Risk compatibility is weak for the selected direction."
    );
  }


  // ----------------------------------------------------------
  // Thesis invalidation
  // ----------------------------------------------------------

  if (
    decision.probabilities.thesisInvalidated !== null &&
    decision.probabilities.thesisInvalidated >= 0.5 &&
    position.side !== "FLAT" &&
    decision.direction.choice !== "EXIT" &&
    decision.direction.choice !== "REDUCE"
  ) {

    warnings.push(
      "Thesis invalidation probability is elevated without EXIT or REDUCE."
    );
  }


  // ----------------------------------------------------------
  // Bull/bear conflict
  // ----------------------------------------------------------

  if (
    decision.probabilities.bullishStructure !== null &&
    decision.probabilities.bearishStructure !== null
  ) {

    const bullish =
      decision.probabilities.bullishStructure;

    const bearish =
      decision.probabilities.bearishStructure;


    if (
      bullish >= 0.5 &&
      bearish >= 0.5
    ) {

      warnings.push(
        "Both bullish and bearish structure probabilities are elevated."
      );
    }
  }


  // ----------------------------------------------------------
  // Directional structure mismatch
  // ----------------------------------------------------------

  if (
    decision.direction.choice === "LONG" &&
    decision.probabilities.bearishStructure !== null &&
    decision.probabilities.bearishStructure >= 0.75
  ) {

    warnings.push(
      "LONG conflicts with strongly elevated bearish-structure probability."
    );
  }


  if (
    decision.direction.choice === "SHORT" &&
    decision.probabilities.bullishStructure !== null &&
    decision.probabilities.bullishStructure >= 0.75
  ) {

    warnings.push(
      "SHORT conflicts with strongly elevated bullish-structure probability."
    );
  }


  return {

    consistent:
      warnings.length === 0,

    warnings
  };
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


  const controller =
    new AbortController();


  const timeout =
    setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS
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
              "Jev Connector"
          },

          body:
            JSON.stringify({

              model:
                JEV_MODEL,

              state,

              questions
            }),

          signal:
            controller.signal
        }
      );


    const responseText =
      await response.text();


    let result;


    try {

      result =
        responseText
          ? JSON.parse(responseText)
          : {};

    } catch {

      throw new Error(
        `OpenRouter returned invalid JSON (HTTP ${response.status})`
      );
    }


    if (
      !response.ok
    ) {

      const providerMessage =
        result?.error?.message ||
        result?.error ||
        result?.message ||
        `HTTP ${response.status}`;


      throw new Error(
        `OpenRouter Jev request failed: ${providerMessage}`
      );
    }


    if (
      !isObject(result)
    ) {

      throw new Error(
        "OpenRouter Jev returned an invalid response"
      );
    }


    if (
      !isObject(result.answers)
    ) {

      throw new Error(
        "OpenRouter Jev returned no structured answers"
      );
    }


    return result;


  } catch (error) {

    if (
      error?.name === "AbortError"
    ) {

      throw new Error(
        "OpenRouter Jev request timed out after 20 seconds"
      );
    }


    throw error;


  } finally {

    clearTimeout(
      timeout
    );
  }
}


// ============================================================
// MAIN EVALUATION FUNCTION
// ============================================================

export async function evaluateMarketState(
  state
) {

  validateState(
    state
  );


  const position =
    normalizePosition(
      state
    );


  const questions =
    buildQuestions();


  // ----------------------------------------------------------
  // Evaluation state
  // ----------------------------------------------------------

  const evaluationState = {

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


  // ----------------------------------------------------------
  // Call Jev
  // ----------------------------------------------------------

  const result =
    await requestJev(
      evaluationState,
      questions
    );


  // ----------------------------------------------------------
  // Normalize
  // ----------------------------------------------------------

  const decision =
    normalizeAnswers(
      result.answers
    );


  // ----------------------------------------------------------
  // Consistency
  // ----------------------------------------------------------

  const consistency =
    analyzeConsistency(
      decision,
      position
    );


  // ----------------------------------------------------------
  // Direction confidence
  //
  // Jev's Choice answer provides confidence.
  // We do NOT invent an "overall confidence" by averaging
  // unrelated probabilities.
  // ----------------------------------------------------------

  const directionConfidence =
    decision.confidence.direction;


  // ----------------------------------------------------------
  // Provider/model information
  // ----------------------------------------------------------

  const resolvedModel =
    typeof result.model === "string" &&
    result.model.length > 0
      ? result.model
      : JEV_MODEL;


  // ----------------------------------------------------------
  // Return
  // ----------------------------------------------------------

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


    position,


    decision,


    confidence: {

      direction:
        directionConfidence
    },


    usage:
      result.usage ??
      null,


    providerRequestId:
      result.id ??
      null,


    consistency,


    execution: {

      allowed:
        false,

      reason:
        "Jev is evaluation-only. " +
        "A separate Trader Risk Engine must approve any future action."
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
      new Date().toISOString()
  };
}


// ============================================================
// OPTIONAL DEFAULT EXPORT
// ============================================================

export default {
  evaluateMarketState
};
