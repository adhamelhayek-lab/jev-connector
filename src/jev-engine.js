// Jev Connector
// Jev Trading Evaluation Engine V2.1
//
// Purpose:
// - Evaluate real-market conditions
// - Evaluate LONG / SHORT / HOLD / REDUCE / EXIT / WAIT
// - Evaluate accumulation conditions
// - Evaluate market structure
// - Evaluate evidence quality
// - Evaluate risk compatibility
// - Evaluate thesis invalidation
// - Preserve Jev probabilities
//
// SECURITY BOUNDARY
// -----------------
// Jev does NOT:
// - place trades
// - access wallets
// - hold private keys
// - withdraw funds
// - modify exchange permissions
// - bypass risk controls
//
// Jev evaluates market state.
// The future Risk Engine controls permission.
// The future Execution Engine controls orders.
//
// REAL MARKET ONLY.
// No prediction-market logic.

import {
  experimental_evaluate as evaluate
} from "ai";


// ============================================================
// CONFIGURATION
// ============================================================

const JEV_MODEL =
  process.env.JEV_MODEL || "typesafe-ai/jev";

const ENGINE_NAME =
  "Jev Trading Evaluation Engine";

const ENGINE_VERSION =
  "2.1.0";


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
// VALIDATION
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
    !state ||
    typeof state !== "object" ||
    Array.isArray(state)
  ) {
    return emptyPosition;
  }

  if (
    !state.position ||
    typeof state.position !== "object"
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

function buildQuestions() {
  return {

    // --------------------------------------------------------
    // PRIMARY TRADING DIRECTION
    // --------------------------------------------------------

    direction: {
      type: "choice",

      instructions:
        "Evaluate the supplied real-market state and select the most " +
        "appropriate current trading decision. Consider market structure, " +
        "trend, momentum, volume, liquidity, volatility, derivatives data, " +
        "current position, invalidation conditions and supplied risk data. " +
        "Do not force a directional trade when evidence is insufficient.",

      criteria: {

        LONG:
          "Evidence supports a bullish directional setup or continuation " +
          "that could justify long exposure.",

        SHORT:
          "Evidence supports a bearish directional setup or continuation " +
          "that could justify short exposure.",

        HOLD:
          "An existing position remains supported and should generally remain " +
          "unchanged.",

        REDUCE:
          "Existing exposure should be reduced because risk has increased or " +
          "the strength of the thesis has weakened, but complete exit is not " +
          "yet clearly required.",

        EXIT:
          "An existing position should be closed because the thesis has failed, " +
          "invalidation conditions are present, or risk has materially changed.",

        WAIT:
          "Evidence is insufficient, contradictory, stale, or unreliable for " +
          "a meaningful directional decision."
      }
    },


    // --------------------------------------------------------
    // ACCUMULATION
    // --------------------------------------------------------

    accumulation: {
      type: "boolean",

      instructions:
        "Determine whether controlled additional entries into an existing " +
        "position are supported by the supplied evidence. Do not recommend " +
        "accumulation merely because price moved against the position. Consider " +
        "trend confirmation, liquidity, volatility, current exposure, invalidation " +
        "and risk information.",

      criteria: {
        true:
          "The supplied evidence supports controlled additional entries " +
          "without relying on loss-chasing.",

        false:
          "Accumulation is unsupported, premature, too risky, or the required " +
          "evidence is missing."
      }
    },


    // --------------------------------------------------------
    // BULLISH STRUCTURE
    // --------------------------------------------------------

    bullishStructure: {
      type: "boolean",

      instructions:
        "Determine whether the supplied evidence supports bullish market structure.",

      criteria: {
        true:
          "The supplied evidence supports a bullish structure.",

        false:
          "The supplied evidence does not sufficiently support bullish structure."
      }
    },


    // --------------------------------------------------------
    // BEARISH STRUCTURE
    // --------------------------------------------------------

    bearishStructure: {
      type: "boolean",

      instructions:
        "Determine whether the supplied evidence supports bearish market structure.",

      criteria: {
        true:
          "The supplied evidence supports a bearish structure.",

        false:
          "The supplied evidence does not sufficiently support bearish structure."
      }
    },


    // --------------------------------------------------------
    // EVIDENCE QUALITY
    // --------------------------------------------------------

    sufficientEvidence: {
      type: "boolean",

      instructions:
        "Determine whether the market information is sufficiently complete, " +
        "current and internally consistent for meaningful evaluation.",

      criteria: {
        true:
          "Important market information is sufficiently complete and usable.",

        false:
          "Important information is missing, stale, contradictory or unreliable."
      }
    },


    // --------------------------------------------------------
    // RISK COMPATIBILITY
    // --------------------------------------------------------

    riskCompatible: {
      type: "boolean",

      instructions:
        "Determine whether the evaluated setup is compatible with the supplied " +
        "risk information and current exposure. Missing essential risk information " +
        "must not be treated as acceptable risk.",

      criteria: {
        true:
          "The supplied risk information is compatible with the evaluated setup.",

        false:
          "Risk information is incompatible, insufficient, or materially concerning."
      }
    },


    // --------------------------------------------------------
    // SETUP QUALITY
    // --------------------------------------------------------

    setupQuality: {
      type: "score",

      instructions:
        "Rate the overall quality of the supplied trading setup using only " +
        "the evidence present in the market state. This is a setup-quality " +
        "assessment, not a probability of profit.",

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
        "Rate how strongly the supplied evidence supports controlled accumulation. " +
        "Do not reward averaging down simply because a position is losing.",

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
      type: "boolean",

      instructions:
        "Determine whether the current trading thesis has been materially " +
        "invalidated by the supplied market state.",

      criteria: {
        true:
          "The current thesis appears materially invalidated.",

        false:
          "The current thesis does not appear materially invalidated."
      }
    },


    // --------------------------------------------------------
    // REVERSAL RISK
    // --------------------------------------------------------

    reversalRisk: {
      type: "score",

      instructions:
        "Rate the current risk of a meaningful reversal against the evaluated " +
        "direction.",

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
// RESULT HELPERS
// ============================================================

function readBoolean(answer) {
  if (
    !answer ||
    typeof answer !== "object"
  ) {
    return null;
  }

  return typeof answer.probability === "number"
    ? answer.probability
    : null;
}


function readChoice(answer) {
  if (
    !answer ||
    typeof answer !== "object"
  ) {
    return {
      choice: null,
      probabilities: {}
    };
  }

  return {
    choice:
      typeof answer.choice === "string"
        ? answer.choice
        : null,

    probabilities:
      answer.probabilities &&
      typeof answer.probabilities === "object"
        ? answer.probabilities
        : {}
  };
}


function readScore(answer) {
  if (
    !answer ||
    typeof answer !== "object"
  ) {
    return {
      score: null,
      probabilities: {}
    };
  }

  return {
    score:
      typeof answer.score === "number"
        ? answer.score
        : null,

    probabilities:
      answer.probabilities &&
      typeof answer.probabilities === "object"
        ? answer.probabilities
        : {}
  };
}


// ============================================================
// NORMALIZE ANSWERS
// ============================================================

function normalizeAnswers(answers) {
  const direction =
    readChoice(
      answers?.direction
    );

  const accumulation =
    readBoolean(
      answers?.accumulation
    );

  const bullish =
    readBoolean(
      answers?.bullishStructure
    );

  const bearish =
    readBoolean(
      answers?.bearishStructure
    );

  const sufficientEvidence =
    readBoolean(
      answers?.sufficientEvidence
    );

  const riskCompatible =
    readBoolean(
      answers?.riskCompatible
    );

  const thesisInvalidated =
    readBoolean(
      answers?.thesisInvalidated
    );

  const setupQuality =
    readScore(
      answers?.setupQuality
    );

  const accumulationQuality =
    readScore(
      answers?.accumulationQuality
    );

  const reversalRisk =
    readScore(
      answers?.reversalRisk
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
        direction.probabilities
    },

    probabilities: {

      accumulation,

      bullishStructure:
        bullish,

      bearishStructure:
        bearish,

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
  // Invalid position transitions
  // ----------------------------------------------------------

  if (
    position.side === "FLAT" &&
    decision.direction.choice === "HOLD"
  ) {
    warnings.push(
      "HOLD was selected while the supplied position is FLAT."
    );
  }


  if (
    position.side === "FLAT" &&
    decision.direction.choice === "EXIT"
  ) {
    warnings.push(
      "EXIT was selected while the supplied position is FLAT."
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
    decision.direction.choice !== "WAIT"
  ) {
    warnings.push(
      "A directional decision was selected despite weak evidence sufficiency."
    );
  }


  // ----------------------------------------------------------
  // Risk
  // ----------------------------------------------------------

  if (
    decision.probabilities.riskCompatible !== null &&
    decision.probabilities.riskCompatible < 0.5
  ) {
    warnings.push(
      "Risk compatibility is weak."
    );
  }


  // ----------------------------------------------------------
  // Thesis invalidation
  // ----------------------------------------------------------

  if (
    decision.probabilities.thesisInvalidated !== null &&
    decision.probabilities.thesisInvalidated >= 0.5 &&
    decision.direction.choice !== "EXIT" &&
    decision.direction.choice !== "REDUCE"
  ) {
    warnings.push(
      "Thesis invalidation probability is elevated without EXIT or REDUCE."
    );
  }


  // ----------------------------------------------------------
  // Long/short conflict
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


  return {
    consistent:
      warnings.length === 0,

    warnings
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

      "WAIT is a valid result.",

      "Accumulation must not become uncontrolled averaging.",

      "Long and short setups are both permitted.",

      "Prediction-market logic is forbidden.",

      "A setup score is not a profit probability.",

      "Jev does not authorize execution."
    ]
  };


  // ----------------------------------------------------------
  // Call Jev
  // ----------------------------------------------------------

  const result =
    await evaluate({

      model:
        JEV_MODEL,

      state:
        evaluationState,

      questions,

      providerOptions: {

        gateway: {

          zeroDataRetention:
            true
        }
      }
    });


  // ----------------------------------------------------------
  // Normalize response
  // ----------------------------------------------------------

  const decision =
    normalizeAnswers(
      result?.answers || {}
    );


  const consistency =
    analyzeConsistency(
      decision,
      position
    );


  const confidence =
    result
      ?.providerMetadata
      ?.typesafe
      ?.confidence
      ?? null;


  // ----------------------------------------------------------
  // Return structured result
  // ----------------------------------------------------------

  return {

    engine: {

      name:
        ENGINE_NAME,

      version:
        ENGINE_VERSION,

      model:
        JEV_MODEL
    },


    position,


    decision,


    confidence,


    usage:
      result?.usage ?? null,


    consistency,


    execution: {

      allowed:
        false,

      reason:
        "Jev is evaluation-only. " +
        "A separate Risk Engine must approve any future action."
    },


    security: {

      walletAccess:
        false,

      privateKeys:
        false,

      withdrawals:
        false,

      execution:
        false
    },


    timestamp:
      new Date().toISOString()
  };
}
