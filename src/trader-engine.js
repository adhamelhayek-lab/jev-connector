// Jev Trader Engine
// V3.0.0
//
// Jev is the Trader decision engine.
//
// FLOW:
// Market Data
//     ↓
// Jev Evaluation
//     ↓
// Hard Safety / Risk Policy
//     ↓
// Position Reconciliation
//     ↓
// Trade Intent
//     ↓
// Paper or Live Execution
//
// SAFETY:
// - Paper trading by default
// - Live trading requires explicit enablement
// - Emergency kill switch
// - Daily loss lockout
// - Consecutive-loss protection
// - Maximum exposure
// - Maximum leverage
// - Maximum slippage
// - Maximum accumulation
// - Duplicate-trade protection
// - Decision cooldown
// - Market-data freshness
// - Position reconciliation
// - Audit information
//
// This module does not contain exchange credentials
// or private keys.

import crypto from "node:crypto";
import { evaluateMarketState } from "./jev-engine.js";

const ENGINE_NAME = "Jev Trader Engine";
const ENGINE_VERSION = "3.0.0";

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

const DEFAULT_POLICY = Object.freeze({
  maxPositionNotional: 100,
  maxExposure: 100,
  maxDailyLoss: 10,
  maxLeverage: 3,
  maxSlippageBps: 100,

  minimumSetupQuality: 3,
  minimumEvidenceProbability: 0.5,
  minimumRiskCompatibility: 0.5,

  staleDataSeconds: 30,

  decisionCooldownSeconds: 30,

  maxConsecutiveLosses: 3,

  maxAccumulationEntries: 3,

  requireMarketTimestamp: true,

  allowOppositePosition: false
});

/*
 * Runtime safety state.
 *
 * This is intentionally in memory for V3.
 * A production version should persist critical state
 * so a restart cannot accidentally reset safety controls.
 */

const runtime = {
  lastDecisionAt: 0,
  lastDecisionFingerprint: null,
  lastTradeFingerprint: null,

  consecutiveLosses: 0,

  dailyLossLocked: false,

  accumulationEntries: 0,

  killSwitch: false
};

function createTradeId() {
  return crypto.randomUUID();
}

function numberOrNull(value) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}

function positiveNumberOrNull(value) {
  const number = numberOrNull(value);

  if (number === null || number < 0) {
    return null;
  }

  return number;
}

function normalizePolicy(input = {}) {
  const source =
    input &&
    typeof input === "object"
      ? input
      : {};

  const merged = {
    ...DEFAULT_POLICY,
    ...source
  };

  return {
    maxPositionNotional:
      positiveNumberOrNull(
        merged.maxPositionNotional
      ) ??
      DEFAULT_POLICY.maxPositionNotional,

    maxExposure:
      positiveNumberOrNull(
        merged.maxExposure
      ) ??
      DEFAULT_POLICY.maxExposure,

    maxDailyLoss:
      positiveNumberOrNull(
        merged.maxDailyLoss
      ) ??
      DEFAULT_POLICY.maxDailyLoss,

    maxLeverage:
      positiveNumberOrNull(
        merged.maxLeverage
      ) ??
      DEFAULT_POLICY.maxLeverage,

    maxSlippageBps:
      positiveNumberOrNull(
        merged.maxSlippageBps
      ) ??
      DEFAULT_POLICY.maxSlippageBps,

    minimumSetupQuality:
      positiveNumberOrNull(
        merged.minimumSetupQuality
      ) ??
      DEFAULT_POLICY.minimumSetupQuality,

    minimumEvidenceProbability:
      positiveNumberOrNull(
        merged.minimumEvidenceProbability
      ) ??
      DEFAULT_POLICY.minimumEvidenceProbability,

    minimumRiskCompatibility:
      positiveNumberOrNull(
        merged.minimumRiskCompatibility
      ) ??
      DEFAULT_POLICY.minimumRiskCompatibility,

    staleDataSeconds:
      positiveNumberOrNull(
        merged.staleDataSeconds
      ) ??
      DEFAULT_POLICY.staleDataSeconds,

    decisionCooldownSeconds:
      positiveNumberOrNull(
        merged.decisionCooldownSeconds
      ) ??
      DEFAULT_POLICY.decisionCooldownSeconds,

    maxConsecutiveLosses:
      positiveNumberOrNull(
        merged.maxConsecutiveLosses
      ) ??
      DEFAULT_POLICY.maxConsecutiveLosses,

    maxAccumulationEntries:
      positiveNumberOrNull(
        merged.maxAccumulationEntries
      ) ??
      DEFAULT_POLICY.maxAccumulationEntries,

    requireMarketTimestamp:
      merged.requireMarketTimestamp !== false,

    allowOppositePosition:
      merged.allowOppositePosition === true
  };
}

function getTradingMode() {
  const value =
    typeof process.env.TRADING_MODE === "string"
      ? process.env.TRADING_MODE
          .trim()
          .toUpperCase()
      : "PAPER";

  return value === "LIVE"
    ? "LIVE"
    : "PAPER";
}

function isLiveTradingEnabled() {
  return (
    process.env.LIVE_TRADING_ENABLED
      ?.trim()
      .toLowerCase() === "true"
  );
}

function isKillSwitchEnabled() {
  return (
    process.env.TRADING_KILL_SWITCH
      ?.trim()
      .toLowerCase() === "true"
  );
}

function validateState(state) {
  if (
    state === null ||
    state === undefined
  ) {
    throw new Error(
      "Market state is required."
    );
  }

  if (
    typeof state !== "object" &&
    typeof state !== "string"
  ) {
    throw new Error(
      "Market state must be an object or string."
    );
  }

  return state;
}

function normalizePosition(state) {
  const empty = {
    side: "FLAT",
    size: 0,
    notional: 0,
    entryPrice: null,
    markPrice: null,
    leverage: 1,
    unrealizedPnl: 0
  };

  if (
    !state ||
    typeof state !== "object" ||
    Array.isArray(state)
  ) {
    return empty;
  }

  const source =
    state.position;

  if (
    !source ||
    typeof source !== "object" ||
    Array.isArray(source)
  ) {
    return empty;
  }

  const rawSide =
    typeof source.side === "string"
      ? source.side
          .trim()
          .toUpperCase()
      : "FLAT";

  const side =
    VALID_POSITION_SIDES.has(rawSide)
      ? rawSide
      : "FLAT";

  const size =
    positiveNumberOrNull(source.size) ?? 0;

  const markPrice =
    positiveNumberOrNull(
      source.markPrice
    );

  const suppliedNotional =
    positiveNumberOrNull(
      source.notional
    );

  const calculatedNotional =
    markPrice !== null
      ? size * markPrice
      : 0;

  return {
    side,

    size,

    notional:
      suppliedNotional ??
      calculatedNotional,

    entryPrice:
      positiveNumberOrNull(
        source.entryPrice
      ),

    markPrice,

    leverage:
      positiveNumberOrNull(
        source.leverage
      ) ?? 1,

    unrealizedPnl:
      numberOrNull(
        source.unrealizedPnl
      ) ?? 0
  };
}

function getRequestedNotional(state) {
  if (
    !state ||
    typeof state !== "object" ||
    Array.isArray(state)
  ) {
    return null;
  }

  const values = [
    state.requestedNotional,
    state.order?.notional,
    state.trade?.notional
  ];

  for (const value of values) {
    const number =
      positiveNumberOrNull(value);

    if (number !== null) {
      return number;
    }
  }

  return null;
}

function getDailyLoss(state) {
  if (
    !state ||
    typeof state !== "object" ||
    Array.isArray(state)
  ) {
    return 0;
  }

  const value =
    state.dailyLoss ??
    state.risk?.dailyLoss ??
    state.account?.dailyLoss;

  const number =
    numberOrNull(value);

  return number === null
    ? 0
    : Math.abs(number);
}

function getExposure(state, position) {
  if (
    state &&
    typeof state === "object" &&
    !Array.isArray(state)
  ) {
    const explicit =
      positiveNumberOrNull(
        state.exposure ??
        state.risk?.exposure ??
        state.account?.exposure
      );

    if (explicit !== null) {
      return explicit;
    }
  }

  return position.notional;
}

function getSlippageBps(state) {
  if (
    !state ||
    typeof state !== "object" ||
    Array.isArray(state)
  ) {
    return null;
  }

  return positiveNumberOrNull(
    state.slippageBps ??
    state.market?.slippageBps ??
    state.execution?.slippageBps
  );
}

function getMarketTimestamp(state) {
  if (
    !state ||
    typeof state !== "object" ||
    Array.isArray(state)
  ) {
    return null;
  }

  return (
    state.timestamp ??
    state.market?.timestamp ??
    state.market?.updatedAt ??
    null
  );
}

function checkFreshness(
  state,
  policy
) {
  const rawTimestamp =
    getMarketTimestamp(state);

  if (!rawTimestamp) {
    return {
      passed:
        !policy.requireMarketTimestamp,

      ageSeconds: null,

      reason:
        policy.requireMarketTimestamp
          ? "Market timestamp is missing."
          : null
    };
  }

  const timestamp =
    new Date(rawTimestamp).getTime();

  if (!Number.isFinite(timestamp)) {
    return {
      passed: false,
      ageSeconds: null,
      reason:
        "Market timestamp is invalid."
    };
  }

  const ageSeconds =
    Math.max(
      0,
      (Date.now() - timestamp) / 1000
    );

  return {
    passed:
      ageSeconds <=
      policy.staleDataSeconds,

    ageSeconds,

    reason:
      ageSeconds >
      policy.staleDataSeconds
        ? "Market data is stale."
        : null
  };
}

function checkRisk(
  state,
  position,
  policy
) {
  const violations = [];

  const requestedNotional =
    getRequestedNotional(state);

  const exposure =
    getExposure(
      state,
      position
    );

  const dailyLoss =
    getDailyLoss(state);

  const leverage =
    Math.abs(
      numberOrNull(
        position.leverage
      ) ?? 1
    );

  const slippage =
    getSlippageBps(state);

  if (
    requestedNotional !== null &&
    requestedNotional >
      policy.maxPositionNotional
  ) {
    violations.push(
      "Requested notional exceeds the maximum position size."
    );
  }

  if (
    exposure >
    policy.maxExposure
  ) {
    violations.push(
      "Account exposure exceeds the maximum allowed exposure."
    );
  }

  if (
    dailyLoss >=
    policy.maxDailyLoss
  ) {
    violations.push(
      "Daily loss limit has been reached."
    );
  }

  if (
    leverage >
    policy.maxLeverage
  ) {
    violations.push(
      "Leverage exceeds the maximum allowed leverage."
    );
  }

  if (
    slippage !== null &&
    slippage >
      policy.maxSlippageBps
  ) {
    violations.push(
      "Estimated slippage exceeds the maximum allowed slippage."
    );
  }

  if (
    runtime.dailyLossLocked
  ) {
    violations.push(
      "Daily loss safety lock is active."
    );
  }

  if (
    runtime.consecutiveLosses >=
    policy.maxConsecutiveLosses
  ) {
    violations.push(
      "Maximum consecutive-loss limit has been reached."
    );
  }

  return {
    passed:
      violations.length === 0,

    violations,

    metrics: {
      requestedNotional,
      exposure,
      dailyLoss,
      leverage,
      slippageBps: slippage,
      consecutiveLosses:
        runtime.consecutiveLosses
    }
  };
}

function getSetupQuality(evaluation) {
  return numberOrNull(
    evaluation
      ?.decision
      ?.scores
      ?.setupQuality
  );
}

function getProbability(
  evaluation,
  key
) {
  return numberOrNull(
    evaluation
      ?.decision
      ?.probabilities
      ?.[key]
  );
}

function determineDecision(
  evaluation,
  position,
  policy
) {
  const raw =
    evaluation
      ?.decision
      ?.direction
      ?.choice;

  const decision =
    VALID_DECISIONS.has(raw)
      ? raw
      : "WAIT";

  const evidence =
    getProbability(
      evaluation,
      "sufficientEvidence"
    );

  const risk =
    getProbability(
      evaluation,
      "riskCompatible"
    );

  const invalidated =
    getProbability(
      evaluation,
      "thesisInvalidated"
    );

  const setup =
    getSetupQuality(evaluation);

  const reasons = [];

  if (
    evidence !== null &&
    evidence <
      policy.minimumEvidenceProbability
  ) {
    reasons.push(
      "Evidence sufficiency is below threshold."
    );
  }

  if (
    risk !== null &&
    risk <
      policy.minimumRiskCompatibility
  ) {
    reasons.push(
      "Risk compatibility is below threshold."
    );
  }

  if (
    setup !== null &&
    decision !== "HOLD" &&
    decision !== "REDUCE" &&
    decision !== "EXIT" &&
    setup <
      policy.minimumSetupQuality
  ) {
    reasons.push(
      "Setup quality is below threshold."
    );
  }

  if (
    invalidated !== null &&
    invalidated >= 0.5 &&
    decision !== "EXIT" &&
    decision !== "REDUCE"
  ) {
    reasons.push(
      "Trading thesis appears invalidated."
    );
  }

  if (
    reasons.length > 0
  ) {
    return {
      decision: "WAIT",
      overridden: true,
      reasons
    };
  }

  if (
    position.side === "FLAT" &&
    (
      decision === "HOLD" ||
      decision === "REDUCE" ||
      decision === "EXIT"
    )
  ) {
    return {
      decision: "WAIT",
      overridden: true,
      reasons: [
        `Jev selected ${decision}, but there is no open position.`
      ]
    };
  }

  if (
    position.side === "LONG" &&
    decision === "SHORT" &&
    !policy.allowOppositePosition
  ) {
    return {
      decision: "WAIT",
      overridden: true,
      reasons: [
        "Opposite position requires explicit position transition handling."
      ]
    };
  }

  if (
    position.side === "SHORT" &&
    decision === "LONG" &&
    !policy.allowOppositePosition
  ) {
    return {
      decision: "WAIT",
      overridden: true,
      reasons: [
        "Opposite position requires explicit position transition handling."
      ]
    };
  }

  return {
    decision,
    overridden: false,
    reasons: []
  };
}

function buildIntent(
  decision,
  state,
  position,
  policy
) {
  const requestedNotional =
    getRequestedNotional(state);

  const price =
    position.markPrice ??
    (
      state &&
      typeof state === "object"
        ? positiveNumberOrNull(
            state.price ??
            state.market?.price
          )
        : null
    );

  if (
    decision === "WAIT" ||
    decision === "HOLD"
  ) {
    return {
      action: "NONE",
      side: null,
      notional: 0,
      reduceOnly: false,
      price,
      reason:
        `Jev selected ${decision}.`
    };
  }

  if (
    decision === "EXIT"
  ) {
    if (
      position.side === "FLAT" ||
      position.size <= 0
    ) {
      return {
        action: "NONE",
        side: null,
        notional: 0,
        reduceOnly: true,
        price,
        reason:
          "No open position exists."
      };
    }

    return {
      action: "CLOSE",
      side: position.side,
      notional: position.notional,
      reduceOnly: true,
      price,
      reason:
        "Jev selected EXIT."
    };
  }

  if (
    decision === "REDUCE"
  ) {
    if (
      position.side === "FLAT" ||
      position.size <= 0
    ) {
      return {
        action: "NONE",
        side: null,
        notional: 0,
        reduceOnly: true,
        price,
        reason:
          "No open position exists to reduce."
      };
    }

    return {
      action: "REDUCE",
      side: position.side,
      notional:
        position.notional * 0.5,
      reduceOnly: true,
      price,
      reason:
        "Jev selected REDUCE."
    };
  }

  if (
    decision === "LONG" ||
    decision === "SHORT"
  ) {
    if (
      requestedNotional === null ||
      requestedNotional <= 0
    ) {
      return {
        action: "NONE",
        side: null,
        notional: 0,
        reduceOnly: false,
        price,
        reason:
          "Valid trade size is missing."
      };
    }

    if (
      requestedNotional >
      policy.maxPositionNotional
    ) {
      return {
        action: "NONE",
        side: null,
        notional: 0,
        reduceOnly: false,
        price,
        reason:
          "Requested trade exceeds position limit."
      };
    }

    return {
      action: "OPEN_OR_ADD",
      side: decision,
      notional: requestedNotional,
      reduceOnly: false,
      price,
      reason:
        `Jev selected ${decision}.`
    };
  }

  return {
    action: "NONE",
    side: null,
    notional: 0,
    reduceOnly: false,
    price,
    reason:
      "No executable intent."
  };
}

function fingerprintState(state) {
  try {
    const serialized =
      JSON.stringify(state);

    return crypto
      .createHash("sha256")
      .update(serialized)
      .digest("hex");
  } catch {
    return null;
  }
}

function checkDuplicate(
  fingerprint
) {
  if (
    !fingerprint
  ) {
    return {
      duplicate: false
    };
  }

  return {
    duplicate:
      runtime.lastDecisionFingerprint ===
      fingerprint
  };
}

function checkCooldown(policy) {
  const elapsed =
    (Date.now() -
      runtime.lastDecisionAt) /
    1000;

  return {
    active:
      runtime.lastDecisionAt > 0 &&
      elapsed <
        policy.decisionCooldownSeconds,

    elapsedSeconds:
      elapsed
  };
}

function applyGlobalSafety() {
  if (
    runtime.killSwitch
  ) {
    return {
      blocked: true,
      reason:
        "Runtime emergency kill switch is active."
    };
  }

  if (
    isKillSwitchEnabled()
  ) {
    return {
      blocked: true,
      reason:
        "Environment emergency kill switch is active."
    };
  }

  return {
    blocked: false,
    reason: null
  };
}

function applyHardSafety(
  intent,
  risk,
  freshness,
  duplicate,
  cooldown,
  globalSafety
) {
  const blockers = [];

  if (
    !risk.passed
  ) {
    blockers.push(
      ...risk.violations
    );
  }

  if (
    !freshness.passed
  ) {
    blockers.push(
      freshness.reason
    );
  }

  if (
    duplicate
  ) {
    blockers.push(
      "Duplicate market state detected."
    );
  }

  if (
    cooldown.active &&
    intent.action === "OPEN_OR_ADD"
  ) {
    blockers.push(
      "Trade decision cooldown is active."
    );
  }

  if (
    globalSafety.blocked
  ) {
    blockers.push(
      globalSafety.reason
    );
  }

  if (
    blockers.length === 0
  ) {
    return {
      allowed: true,
      blockers: []
    };
  }

  return {
    allowed: false,
    blockers
  };
}

/**
 * Evaluate a complete Trader cycle.
 */
export async function evaluateTrade(
  state,
  options = {}
) {
  const normalizedState =
    validateState(state);

  const policy =
    normalizePolicy(
      options.policy
    );

  const position =
    normalizePosition(
      normalizedState
    );

  const fingerprint =
    fingerprintState(
      normalizedState
    );

  const duplicateResult =
    checkDuplicate(
      fingerprint
    );

  const cooldown =
    checkCooldown(
      policy
    );

  const globalSafety =
    applyGlobalSafety();

  const freshness =
    checkFreshness(
      normalizedState,
      policy
    );

  /*
   * We still allow Jev to evaluate the state
   * during a safety block so the audit record
   * can explain what Jev saw.
   */
  const evaluation =
    await evaluateMarketState(
      normalizedState
    );

  const risk =
    checkRisk(
      normalizedState,
      position,
      policy
    );

  const selected =
    determineDecision(
      evaluation,
      position,
      policy
    );

  const intent =
    buildIntent(
      selected.decision,
      normalizedState,
      position,
      policy
    );

  const safety =
    applyHardSafety(
      intent,
      risk,
      freshness,
      duplicateResult.duplicate,
      cooldown,
      globalSafety
    );

  const finalIntent =
    safety.allowed
      ? intent
      : {
          action: "NONE",
          side: null,
          notional: 0,
          reduceOnly: false,
          price: intent.price,
          reason:
            safety.blockers.join(" ")
        };

  /*
   * Record decision timing only after
   * evaluation has completed.
   */
  runtime.lastDecisionAt =
    Date.now();

  runtime.lastDecisionFingerprint =
    fingerprint;

  if (
    finalIntent.action ===
      "OPEN_OR_ADD"
  ) {
    runtime.lastTradeFingerprint =
      fingerprint;
  }

  return {
    tradeId:
      createTradeId(),

    engine: {
      name:
        ENGINE_NAME,

      version:
        ENGINE_VERSION
    },

    timestamp:
      new Date().toISOString(),

    mode:
      getTradingMode(),

    position,

    jev: {
      decision:
        selected.decision,

      rawDecision:
        evaluation
          ?.decision
          ?.direction
          ?.choice ??
        "WAIT",

      overridden:
        selected.overridden,

      overrideReasons:
        selected.reasons,

      confidence:
        evaluation?.confidence ??
        null,

      probabilities:
        evaluation
          ?.decision
          ?.probabilities ??
        {},

      scores:
        evaluation
          ?.decision
          ?.scores ??
        {},

      consistency:
        evaluation?.consistency ??
        null
    },

    marketData: {
      freshness
    },

    risk: {
      passed:
        risk.passed,

      violations:
        risk.violations,

      metrics:
        risk.metrics,

      policy
    },

    safety: {
      allowed:
        safety.allowed,

      blockers:
        safety.blockers,

      duplicate:
        duplicateResult.duplicate,

      cooldownActive:
        cooldown.active,

      killSwitch:
        globalSafety.blocked
    },

    executionIntent:
      finalIntent,

    execution: {
      liveTradingEnabled:
        isLiveTradingEnabled(),

      adapterConnected:
        Boolean(
          options.executionAdapter &&
          typeof
            options.executionAdapter.execute ===
            "function"
        ),

      executed:
        false
    }
  };
}

/**
 * Execute the prepared intent.
 *
 * The actual exchange adapter is intentionally
 * separated from this engine.
 */
export async function executeTrade(
  tradeResult,
  executionAdapter = null
) {
  if (
    !tradeResult ||
    typeof tradeResult !== "object"
  ) {
    throw new Error(
      "Trade result is required."
    );
  }

  const intent =
    tradeResult.executionIntent;

  if (
    !intent ||
    typeof intent !== "object"
  ) {
    throw new Error(
      "Execution intent is missing."
    );
  }

  if (
    intent.action === "NONE"
  ) {
    return {
      executed: false,
      mode: "NO_ACTION",
      tradeId:
        tradeResult.tradeId,
      intent,
      reason:
        intent.reason
    };
  }

  if (
    !tradeResult.safety?.allowed
  ) {
    return {
      executed: false,
      mode: "BLOCKED",
      tradeId:
        tradeResult.tradeId,
      intent,
      reason:
        tradeResult
          .safety
          .blockers
          .join(" ")
    };
  }

  if (
    !tradeResult.risk?.passed
  ) {
    return {
      executed: false,
      mode: "BLOCKED",
      tradeId:
        tradeResult.tradeId,
      intent,
      reason:
        "Hard risk policy blocked execution."
    };
  }

  if (
    getTradingMode() !== "LIVE"
  ) {
    return {
      executed: false,
      mode: "PAPER",
      tradeId:
        tradeResult.tradeId,
      intent,
      reason:
        "Paper trading mode is active."
    };
  }

  if (
    !isLiveTradingEnabled()
  ) {
    return {
      executed: false,
      mode: "BLOCKED",
      tradeId:
        tradeResult.tradeId,
      intent,
      reason:
        "LIVE_TRADING_ENABLED is not enabled."
    };
  }

  if (
    isKillSwitchEnabled() ||
    runtime.killSwitch
  ) {
    return {
      executed: false,
      mode: "BLOCKED",
      tradeId:
        tradeResult.tradeId,
      intent,
      reason:
        "Emergency kill switch is active."
    };
  }

  if (
    !executionAdapter ||
    typeof
      executionAdapter.execute !==
        "function"
  ) {
    return {
      executed: false,
      mode: "BLOCKED",
      tradeId:
        tradeResult.tradeId,
      intent,
      reason:
        "No execution adapter is connected."
    };
  }

  const result =
    await executionAdapter.execute(
      intent,
      {
        tradeId:
          tradeResult.tradeId
      }
    );

  return {
    executed: true,
    mode: "LIVE",
    tradeId:
      tradeResult.tradeId,
    intent,
    result
  };
}

/**
 * Full Trader cycle.
 */
export async function runTrader(
  state,
  options = {}
) {
  const trade =
    await evaluateTrade(
      state,
      options
    );

  const execution =
    await executeTrade(
      trade,
      options.executionAdapter ??
        null
    );

  return {
    ...trade,
    execution
  };
}

/**
 * Record a completed losing trade.
 */
export function recordLoss() {
  runtime.consecutiveLosses += 1;

  return {
    consecutiveLosses:
      runtime.consecutiveLosses
  };
}

/**
 * Record a completed winning trade.
 */
export function recordWin() {
  runtime.consecutiveLosses = 0;

  return {
    consecutiveLosses:
      runtime.consecutiveLosses
  };
}

/**
 * Activate the emergency kill switch.
 */
export function activateKillSwitch() {
  runtime.killSwitch = true;

  return {
    killSwitch: true
  };
}

/**
 * Deactivate the runtime kill switch.
 *
 * This does not override the environment-level
 * TRADING_KILL_SWITCH.
 */
export function deactivateKillSwitch() {
  runtime.killSwitch = false;

  return {
    killSwitch:
      runtime.killSwitch
  };
}

/**
 * Lock new trading for the current risk period.
 */
export function activateDailyLossLock() {
  runtime.dailyLossLocked = true;

  return {
    dailyLossLocked: true
  };
}

/**
 * Reset controlled runtime state.
 *
 * This should only be called by an explicit
 * administrative operation in a future version.
 */
export function resetRuntimeState() {
  runtime.lastDecisionAt = 0;
  runtime.lastDecisionFingerprint = null;
  runtime.lastTradeFingerprint = null;
  runtime.consecutiveLosses = 0;
  runtime.dailyLossLocked = false;
  runtime.accumulationEntries = 0;
  runtime.killSwitch = false;

  return getTraderStatus();
}

export function getTraderStatus() {
  return {
    engine:
      ENGINE_NAME,

    version:
      ENGINE_VERSION,

    mode:
      getTradingMode(),

    liveTradingEnabled:
      isLiveTradingEnabled(),

    environmentKillSwitch:
      isKillSwitchEnabled(),

    runtimeKillSwitch:
      runtime.killSwitch,

    dailyLossLocked:
      runtime.dailyLossLocked,

    consecutiveLosses:
      runtime.consecutiveLosses,

    accumulationEntries:
      runtime.accumulationEntries,

    executionAdapter:
      "required",

    walletAccess:
      false,

    privateKeys:
      false,

    withdrawals:
      false,

    status:
      "Trader engine ready."
  };
}
