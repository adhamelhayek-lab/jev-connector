// Jev Trader Engine
// V3.3.0
//
// Jev is the Trader decision engine.
//
// FLOW:
// Market Data -> Jev Evaluation -> Base Decision
// -> Accumulation Rules -> DCA Rules -> Trade Intent
// -> Risk Check -> Hard Safety -> Final Intent
// -> Paper/Live Execution layer
//
// SAFETY:
// - Paper trading by default
// - Live trading requires explicit environment enablement
// - Emergency kill switch
// - Daily loss lockout
// - Consecutive-loss protection
// - Maximum exposure / leverage / slippage
// - Daily accumulation control
// - Explicit DCA controls and sizing
// - BTC long-term accumulation with manual exit only
// - Duplicate-trade protection
// - Decision cooldown
// - Market-data freshness
// - Audit information
//
// IMPORTANT:
// This module creates trade INTENTS only.
// It does not contain exchange credentials or private keys.
// An execution connector must separately decide whether/how to execute.

import crypto from "node:crypto";
import { evaluateMarketState } from "./jev-engine.js";

const ENGINE_NAME = "Jev Trader Engine";
const ENGINE_VERSION = "3.3.0";

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
  // Position / account risk
  maxPositionNotional: 100,
  maxExposure: 100,
  maxDailyLoss: 10,
  maxLeverage: 3,
  maxSlippageBps: 100,

  // Decision quality
  minimumSetupQuality: 3,
  minimumEvidenceProbability: 0.5,
  minimumRiskCompatibility: 0.5,

  // Safety timing
  staleDataSeconds: 30,
  decisionCooldownSeconds: 30,
  maxConsecutiveLosses: 3,

  // Accumulation
  maxAccumulationEntries: 3,
  maxDailyAccumulationEntries: 1,

  // BTC DCA
  dcaEnabled: true,
  dcaSymbol: "BTCUSDT",
  dcaLongOnly: true,
  dcaNotionalFraction: 0.25,
  maxDcaNotional: 25,
  minDcaDistanceBps: 100,

  // Automatic BTC DCA entry
  dcaEntryEnabled: true,
  dcaEntryMode: "JEV_OR_COPY",
  dcaInitialNotional: 25,
  dcaCopySignalEnabled: true,
  dcaCopySignalMaxAgeSeconds: 120,
  dcaCopyMinConfidence: 0.6,
  dcaPriceCheckRequired: true,

  // BTC accumulation is manual-exit only
  manualAccumulationExit: true,

  // Legacy monthly switch retained for compatibility.
  monthlyAccumulationExit: false,

  requireMarketTimestamp: true,
  allowOppositePosition: false
});

const runtime = {
  lastDecisionAt: 0,
  lastDecisionFingerprint: null,
  lastTradeFingerprint: null,

  consecutiveLosses: 0,
  dailyLossLocked: false,

  accumulationEntries: 0,
  accumulationDate: null,
  accumulationTotalEntries: 0,

  killSwitch: false
};

/* =========================================================
   BASIC HELPERS
   ========================================================= */

function createTradeId() {
  return crypto.randomUUID();
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveNumberOrNull(value) {
  const number = numberOrNull(value);

  return number === null || number < 0
    ? null
    : number;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/* =========================================================
   POLICY
   ========================================================= */

function normalizePolicy(input = {}) {
  const source =
    input &&
    typeof input === "object" &&
    !Array.isArray(input)
      ? input
      : {};

  const merged = {
    ...DEFAULT_POLICY,
    ...source
  };

  return {
    maxPositionNotional:
      positiveNumberOrNull(merged.maxPositionNotional)
      ?? DEFAULT_POLICY.maxPositionNotional,

    maxExposure:
      positiveNumberOrNull(merged.maxExposure)
      ?? DEFAULT_POLICY.maxExposure,

    maxDailyLoss:
      positiveNumberOrNull(merged.maxDailyLoss)
      ?? DEFAULT_POLICY.maxDailyLoss,

    maxLeverage:
      positiveNumberOrNull(merged.maxLeverage)
      ?? DEFAULT_POLICY.maxLeverage,

    maxSlippageBps:
      positiveNumberOrNull(merged.maxSlippageBps)
      ?? DEFAULT_POLICY.maxSlippageBps,

    minimumSetupQuality:
      positiveNumberOrNull(merged.minimumSetupQuality)
      ?? DEFAULT_POLICY.minimumSetupQuality,

    minimumEvidenceProbability:
      clamp(
        positiveNumberOrNull(
          merged.minimumEvidenceProbability
        ) ?? DEFAULT_POLICY.minimumEvidenceProbability,
        0,
        1
      ),

    minimumRiskCompatibility:
      clamp(
        positiveNumberOrNull(
          merged.minimumRiskCompatibility
        ) ?? DEFAULT_POLICY.minimumRiskCompatibility,
        0,
        1
      ),

    staleDataSeconds:
      positiveNumberOrNull(merged.staleDataSeconds)
      ?? DEFAULT_POLICY.staleDataSeconds,

    decisionCooldownSeconds:
      positiveNumberOrNull(merged.decisionCooldownSeconds)
      ?? DEFAULT_POLICY.decisionCooldownSeconds,

    maxConsecutiveLosses:
      positiveNumberOrNull(merged.maxConsecutiveLosses)
      ?? DEFAULT_POLICY.maxConsecutiveLosses,

    maxAccumulationEntries:
      positiveNumberOrNull(merged.maxAccumulationEntries)
      ?? DEFAULT_POLICY.maxAccumulationEntries,

    maxDailyAccumulationEntries:
      positiveNumberOrNull(
        merged.maxDailyAccumulationEntries
      ) ?? DEFAULT_POLICY.maxDailyAccumulationEntries,

    dcaEnabled:
      merged.dcaEnabled !== false,

    dcaSymbol:
      typeof merged.dcaSymbol === "string" &&
      merged.dcaSymbol.trim()
        ? merged.dcaSymbol.trim().toUpperCase()
        : DEFAULT_POLICY.dcaSymbol,

    dcaLongOnly:
      merged.dcaLongOnly !== false,

    dcaNotionalFraction:
      positiveNumberOrNull(merged.dcaNotionalFraction)
      ?? DEFAULT_POLICY.dcaNotionalFraction,

    maxDcaNotional:
      positiveNumberOrNull(merged.maxDcaNotional)
      ?? DEFAULT_POLICY.maxDcaNotional,

    minDcaDistanceBps:
      positiveNumberOrNull(merged.minDcaDistanceBps)
      ?? DEFAULT_POLICY.minDcaDistanceBps,

    dcaEntryEnabled:
      merged.dcaEntryEnabled !== false,

    dcaEntryMode:
      typeof merged.dcaEntryMode === "string" &&
      merged.dcaEntryMode.trim()
        ? merged.dcaEntryMode.trim().toUpperCase()
        : DEFAULT_POLICY.dcaEntryMode,

    dcaInitialNotional:
      positiveNumberOrNull(merged.dcaInitialNotional)
      ?? DEFAULT_POLICY.dcaInitialNotional,

    dcaCopySignalEnabled:
      merged.dcaCopySignalEnabled !== false,

    dcaCopySignalMaxAgeSeconds:
      positiveNumberOrNull(
        merged.dcaCopySignalMaxAgeSeconds
      ) ?? DEFAULT_POLICY.dcaCopySignalMaxAgeSeconds,

    dcaCopyMinConfidence:
      clamp(
        positiveNumberOrNull(
          merged.dcaCopyMinConfidence
        ) ?? DEFAULT_POLICY.dcaCopyMinConfidence,
        0,
        1
      ),

    dcaPriceCheckRequired:
      merged.dcaPriceCheckRequired !== false,

    manualAccumulationExit:
      merged.manualAccumulationExit !== false,

    monthlyAccumulationExit:
      merged.monthlyAccumulationExit === true,

    requireMarketTimestamp:
      merged.requireMarketTimestamp !== false,

    allowOppositePosition:
      merged.allowOppositePosition === true
  };
}

/* =========================================================
   ENVIRONMENT / MODE
   ========================================================= */

function getTradingMode() {
  const value =
    typeof process.env.TRADING_MODE === "string"
      ? process.env.TRADING_MODE.trim().toUpperCase()
      : "PAPER";

  return value === "LIVE" ? "LIVE" : "PAPER";
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

/* =========================================================
   STATE NORMALIZATION
   ========================================================= */

function validateState(state) {
  if (state === null || state === undefined) {
    throw new Error("Market state is required.");
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
    unrealizedPnl: 0,
    accumulation: null
  };

  if (
    !state ||
    typeof state !== "object" ||
    Array.isArray(state)
  ) {
    return empty;
  }

  const source = state.position;

  if (
    !source ||
    typeof source !== "object" ||
    Array.isArray(source)
  ) {
    return empty;
  }

  const rawSide =
    typeof source.side === "string"
      ? source.side.trim().toUpperCase()
      : "FLAT";

  const side =
    VALID_POSITION_SIDES.has(rawSide)
      ? rawSide
      : "FLAT";

  const size =
    positiveNumberOrNull(source.size) ?? 0;

  const markPrice =
    positiveNumberOrNull(source.markPrice);

  const suppliedNotional =
    positiveNumberOrNull(source.notional);

  const calculatedNotional =
    markPrice !== null
      ? size * markPrice
      : 0;

  return {
    side,
    size,

    notional:
      suppliedNotional ?? calculatedNotional,

    entryPrice:
      positiveNumberOrNull(source.entryPrice),

    markPrice,

    leverage:
      positiveNumberOrNull(source.leverage) ?? 1,

    unrealizedPnl:
      numberOrNull(source.unrealizedPnl) ?? 0,

    accumulation:
      source.accumulation &&
      typeof source.accumulation === "object"
        ? source.accumulation
        : null
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
    const number = positiveNumberOrNull(value);

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

  const number = numberOrNull(value);

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

function checkFreshness(state, policy) {
  const rawTimestamp =
    getMarketTimestamp(state);

  if (!rawTimestamp) {
    return {
      passed: !policy.requireMarketTimestamp,
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

  const ageSeconds = Math.max(
    0,
    (Date.now() - timestamp) / 1000
  );

  return {
    passed:
      ageSeconds <= policy.staleDataSeconds,

    ageSeconds,

    reason:
      ageSeconds > policy.staleDataSeconds
        ? "Market data is stale."
        : null
  };
}

/* =========================================================
   RISK
   ========================================================= */

function checkRisk(
  state,
  position,
  policy,
  proposedNotional = null
) {
  const violations = [];

  const requestedNotional =
    proposedNotional ??
    getRequestedNotional(state);

  const baseExposure =
    getExposure(state, position);

  const exposure =
    proposedNotional !== null
      ? baseExposure + proposedNotional
      : baseExposure;

  const leverage = Math.abs(
    numberOrNull(position.leverage) ?? 1
  );

  const slippage =
    getSlippageBps(state);

  const dailyLoss =
    getDailyLoss(state);

  if (
    requestedNotional !== null &&
    requestedNotional >
      policy.maxPositionNotional
  ) {
    violations.push(
      "Requested notional exceeds the maximum position size."
    );
  }

  if (exposure > policy.maxExposure) {
    violations.push(
      "Account exposure exceeds the maximum allowed exposure."
    );
  }

  if (dailyLoss >= policy.maxDailyLoss) {
    violations.push(
      "Daily loss limit has been reached."
    );
  }

  if (leverage > policy.maxLeverage) {
    violations.push(
      "Leverage exceeds the maximum allowed leverage."
    );
  }

  if (
    slippage !== null &&
    slippage > policy.maxSlippageBps
  ) {
    violations.push(
      "Estimated slippage exceeds the maximum allowed slippage."
    );
  }

  if (runtime.dailyLossLocked) {
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
    passed: violations.length === 0,

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

/* =========================================================
   JEV DECISION
   ========================================================= */

function getSetupQuality(evaluation) {
  return numberOrNull(
    evaluation?.decision?.scores?.setupQuality
  );
}

function getProbability(evaluation, key) {
  return numberOrNull(
    evaluation?.decision?.probabilities?.[key]
  );
}

function determineDecision(
  evaluation,
  position,
  policy
) {
  const raw =
    evaluation?.decision?.direction?.choice;

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
    setup < policy.minimumSetupQuality
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

  if (reasons.length > 0) {
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

/* =========================================================
   ACCUMULATION
   ========================================================= */

function utcDateKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function utcMonthKey(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

function getAccumulationState(
  state,
  position
) {
  const source =
    state &&
    typeof state === "object" &&
    !Array.isArray(state)
      ? state
      : {};

  const positionAccumulation =
    position.accumulation &&
    typeof position.accumulation === "object"
      ? position.accumulation
      : null;

  const rootAccumulation =
    source.accumulation &&
    typeof source.accumulation === "object"
      ? source.accumulation
      : null;

  const accumulation =
    positionAccumulation ??
    rootAccumulation ??
    {};

  const enabled =
    accumulation.enabled === true ||
    accumulation.isAccumulation === true ||
    source.accumulationEnabled === true;

  const monthKey =
    typeof accumulation.monthKey === "string"
      ? accumulation.monthKey.slice(0, 7)
      : null;

  const lastAccumulationDate =
    typeof accumulation.lastAccumulationDate === "string"
      ? accumulation.lastAccumulationDate.slice(0, 10)
      : null;

  const entriesToday =
    positiveNumberOrNull(
      accumulation.entriesToday
    ) ?? 0;

  const entriesTotal =
    positiveNumberOrNull(
      accumulation.entriesTotal
    ) ?? 0;

  const lastAccumulationPrice =
    positiveNumberOrNull(
      accumulation.lastAccumulationPrice
    );

  return {
    enabled,
    monthKey,
    lastAccumulationDate,
    entriesToday,
    entriesTotal,
    lastAccumulationPrice
  };
}

function getEffectiveDailyAccumulationEntries(
  accumulation
) {
  const today = utcDateKey();

  if (runtime.accumulationDate !== today) {
    runtime.accumulationDate = today;
    runtime.accumulationEntries = 0;
  }

  const stateEntries =
    accumulation.lastAccumulationDate === today
      ? accumulation.entriesToday
      : 0;

  return Math.max(
    runtime.accumulationEntries,
    stateEntries
  );
}

function checkAccumulationRules(
  state,
  position,
  policy,
  proposedDecision
) {
  const accumulation =
    getAccumulationState(
      state,
      position
    );

  const currentDate =
    utcDateKey();

  const currentMonth =
    utcMonthKey();

  const dailyEntries =
    getEffectiveDailyAccumulationEntries(
      accumulation
    );

  const monthlyExitRequired =
    policy.monthlyAccumulationExit &&
    !policy.manualAccumulationExit &&
    accumulation.enabled &&
    position.side !== "FLAT" &&
    accumulation.monthKey !== null &&
    accumulation.monthKey !== currentMonth;

  const sameSideAdd =
    accumulation.enabled &&
    position.side !== "FLAT" &&
    proposedDecision === position.side;

  const totalEntries =
    Math.max(
      runtime.accumulationTotalEntries,
      accumulation.entriesTotal
    );

  const totalAddLimitReached =
    sameSideAdd &&
    totalEntries >=
      policy.maxAccumulationEntries;

  const dailyAddLimitReached =
    sameSideAdd &&
    dailyEntries >=
      policy.maxDailyAccumulationEntries;

  return {
    enabled: accumulation.enabled,

    currentDate,
    currentMonth,

    positionMonth:
      accumulation.monthKey,

    lastAccumulationDate:
      accumulation.lastAccumulationDate,

    dailyEntries,

    maxDailyEntries:
      policy.maxDailyAccumulationEntries,

    totalEntries,

    maxTotalEntries:
      policy.maxAccumulationEntries,

    monthlyExitRequired,

    dailyAddLimitReached,

    totalAddLimitReached
  };
}

/* =========================================================
   DCA
   ========================================================= */

function calculateBpsDistance(
  priceA,
  priceB
) {
  if (
    priceA === null ||
    priceB === null ||
    priceA <= 0 ||
    priceB <= 0
  ) {
    return null;
  }

  return (
    Math.abs(priceA - priceB) /
    priceB *
    10_000
  );
}

function getDcaSymbol(state) {
  if (
    state &&
    typeof state === "object" &&
    !Array.isArray(state)
  ) {
    const symbol =
      state.symbol ??
      state.market?.symbol ??
      state.position?.symbol;

    if (
      typeof symbol === "string" &&
      symbol.trim()
    ) {
      return symbol
        .trim()
        .toUpperCase();
    }
  }

  return null;
}

function isBtcAccumulation(
  state,
  position,
  policy
) {
  const accumulation =
    getAccumulationState(
      state,
      position
    );

  return (
    policy.dcaSymbol === "BTCUSDT" &&
    getDcaSymbol(state) === "BTCUSDT" &&
    position.side === "LONG" &&
    accumulation.enabled
  );
}

function getDcaState(
  state,
  position,
  accumulation,
  policy,
  proposedDecision
) {
  const currentPrice =
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

  const symbol =
    getDcaSymbol(state);

  const isBtc =
    symbol === "BTCUSDT" &&
    policy.dcaSymbol === "BTCUSDT";

  const isFlat =
    position.side === "FLAT";

  const isLong =
    position.side === "LONG";

  const sameSide =
    isLong &&
    proposedDecision === "LONG";

  const accumulationEnabled =
    policy.dcaEnabled &&
    policy.dcaEntryEnabled &&
    accumulation.enabled &&
    isBtc;

  const copySignal =
    state &&
    typeof state === "object" &&
    state.copySignal &&
    typeof state.copySignal === "object"
      ? state.copySignal
      : null;

  const copySignalTimestamp =
    copySignal?.timestamp ?? null;

  const parsedCopyTimestamp =
    copySignalTimestamp
      ? new Date(
          copySignalTimestamp
        ).getTime()
      : NaN;

  const copySignalAgeSeconds =
    Number.isFinite(parsedCopyTimestamp)
      ? Math.max(
          0,
          (Date.now() -
            parsedCopyTimestamp) /
            1000
        )
      : null;

  const copySignalFresh =
    copySignal?.approved === true &&
    typeof copySignal?.symbol === "string" &&
    copySignal.symbol.toUpperCase() === "BTCUSDT" &&
    typeof copySignal?.side === "string" &&
    copySignal.side.toUpperCase() === "LONG" &&
    Number.isFinite(
      Number(copySignal?.confidence)
    ) &&
    Number(copySignal.confidence) >=
      policy.dcaCopyMinConfidence &&
    copySignalAgeSeconds !== null &&
    copySignalAgeSeconds <=
      policy.dcaCopySignalMaxAgeSeconds;

  const jevLong =
    proposedDecision === "LONG";

  const entrySignalPassed =
    jevLong ||
    (
      policy.dcaCopySignalEnabled &&
      copySignalFresh
    );

  const lastAccumulationPrice =
    accumulation.lastAccumulationPrice ??
    position.entryPrice ??
    null;

  const distanceBps =
    calculateBpsDistance(
      currentPrice,
      lastAccumulationPrice
    );

  const distancePassed =
    isFlat
      ? true
      : (
          !policy.dcaPriceCheckRequired ||
          (
            currentPrice !== null &&
            lastAccumulationPrice !== null &&
            currentPrice <=
              lastAccumulationPrice *
              (
                1 -
                policy.minDcaDistanceBps /
                  10_000
              )
          )
        );

  const requestedDcaNotional =
    positiveNumberOrNull(
      state?.dcaNotional
    ) ??
    positiveNumberOrNull(
      state?.order?.dcaNotional
    ) ??
    positiveNumberOrNull(
      state?.trade?.dcaNotional
    );

  const calculatedDcaNotional =
    isFlat
      ? policy.dcaInitialNotional
      : (
          position.notional > 0
            ? position.notional *
              policy.dcaNotionalFraction
            : policy.dcaInitialNotional
        );

  const rawDcaNotional =
    requestedDcaNotional ??
    calculatedDcaNotional;

  const remainingPositionCapacity =
    Math.max(
      0,
      policy.maxPositionNotional -
        position.notional
    );

  const proposedNotional =
    rawDcaNotional === null
      ? null
      : Math.min(
          rawDcaNotional,
          policy.maxDcaNotional,
          remainingPositionCapacity
        );

  const sizePassed =
    proposedNotional !== null &&
    proposedNotional > 0;

  const dailyLimitReached =
    accumulation.dailyEntries >=
    policy.maxDailyAccumulationEntries;

  const totalLimitReached =
    accumulation.totalEntries >=
    policy.maxAccumulationEntries;

  let reason = null;

  if (!policy.dcaEnabled) {
    reason =
      "DCA is disabled by policy.";
  } else if (!policy.dcaEntryEnabled) {
    reason =
      "Automatic DCA entry is disabled by policy.";
  } else if (
    symbol !== policy.dcaSymbol
  ) {
    reason =
      `DCA is restricted to ${policy.dcaSymbol}.`;
  } else if (
    policy.dcaLongOnly &&
    !isFlat &&
    !isLong
  ) {
    reason =
      "DCA is restricted to LONG BTC accumulation.";
  } else if (
    !accumulation.enabled
  ) {
    reason =
      "DCA requires accumulation mode to be enabled.";
  } else if (
    accumulation.monthlyExitRequired
  ) {
    reason =
      "DCA is blocked because monthly accumulation exit is required.";
  } else if (
    dailyLimitReached
  ) {
    reason =
      "DCA is blocked by the daily accumulation limit.";
  } else if (
    totalLimitReached
  ) {
    reason =
      "DCA is blocked by the maximum accumulation count.";
  } else if (
    currentPrice === null
  ) {
    reason =
      "DCA requires a valid current BTC price.";
  } else if (
    !entrySignalPassed
  ) {
    reason =
      "DCA requires a LONG signal from Jev or a fresh approved copy signal.";
  } else if (
    !distancePassed
  ) {
    reason =
      "DCA price-distance requirement has not been met.";
  } else if (
    !sizePassed
  ) {
    reason =
      "DCA has no remaining position capacity or valid entry size.";
  }

  const eligible =
    accumulationEnabled &&
    currentPrice !== null &&
    entrySignalPassed &&
    !accumulation.monthlyExitRequired &&
    !dailyLimitReached &&
    !totalLimitReached &&
    distancePassed &&
    sizePassed &&
    (
      isFlat ||
      sameSide
    );

  return {
    enabled: accumulationEnabled,

    symbol,
    targetSymbol:
      policy.dcaSymbol,

    longOnly:
      policy.dcaLongOnly,

    initialEntry:
      isFlat,

    existingLong:
      isLong,

    entrySignal:
      jevLong
        ? "JEV"
        : copySignalFresh
          ? "COPY"
          : null,

    copySignal: {
      enabled:
        policy.dcaCopySignalEnabled,

      approved:
        copySignal?.approved === true,

      fresh:
        copySignalFresh,

      source:
        copySignal?.source ?? null,

      confidence:
        Number.isFinite(
          Number(copySignal?.confidence)
        )
          ? Number(copySignal.confidence)
          : null,

      ageSeconds:
        copySignalAgeSeconds
    },

    eligible,

    currentPrice,

    lastAccumulationPrice,

    distanceBps,

    minDistanceBps:
      policy.minDcaDistanceBps,

    requestedNotional:
      requestedDcaNotional,

    calculatedNotional:
      calculatedDcaNotional,

    proposedNotional,

    maxDcaNotional:
      policy.maxDcaNotional,

    remainingPositionCapacity,

    reason
  };
}

/* =========================================================
   ACCUMULATION DECISION OVERRIDES
   ========================================================= */

function applyAccumulationRules(
  selected,
  accumulation,
  position,
  state,
  policy
) {
  // BTC long-term accumulation cannot be automatically
  // exited or reduced.
  if (
    policy.manualAccumulationExit &&
    isBtcAccumulation(
      state,
      position,
      policy
    ) &&
    (
      selected.decision === "EXIT" ||
      selected.decision === "REDUCE"
    )
  ) {
    return {
      decision: "WAIT",
      overridden: true,
      reasons: [
        "BTC long-term accumulation is manual-exit only; Jev cannot auto-EXIT or auto-REDUCE it."
      ]
    };
  }

  if (
    accumulation.monthlyExitRequired
  ) {
    if (position.side !== "FLAT") {
      return {
        decision: "EXIT",
        overridden: true,
        reasons: [
          "Monthly accumulation exit is required because the accumulation month has ended."
        ]
      };
    }
  }

  if (
    accumulation.totalAddLimitReached &&
    (
      selected.decision === "LONG" ||
      selected.decision === "SHORT"
    )
  ) {
    return {
      decision: "WAIT",
      overridden: true,
      reasons: [
        "Maximum accumulation count has been reached."
      ]
    };
  }

  if (
    accumulation.dailyAddLimitReached &&
    (
      selected.decision === "LONG" ||
      selected.decision === "SHORT"
    )
  ) {
    return {
      decision: "WAIT",
      overridden: true,
      reasons: [
        "Daily accumulation limit has been reached for the UTC calendar day."
      ]
    };
  }

  return selected;
}

/* =========================================================
   INTENT
   ========================================================= */

function buildIntent(
  decision,
  state,
  position,
  policy,
  accumulation = null,
  dca = null
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

  // A DCA_ENTRY is only allowed when the DCA engine
  // explicitly marks the entry eligible.
  if (
    dca?.eligible &&
    (
      decision === "LONG" ||
      decision === "DCA_ENTRY"
    )
  ) {
    return {
      action: "DCA_ENTRY",
      side: "LONG",
      notional:
        dca.proposedNotional ??
        dca.requestedNotional ??
        policy.dcaInitialNotional,
      reduceOnly: false,
      price,

      reason:
        dca.entrySignal === "JEV"
          ? "BTC DCA entry approved by Jev."
          : dca.entrySignal === "COPY"
            ? "BTC DCA entry approved by copy signal."
            : "BTC DCA entry approved by DCA rules."
    };
  }

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

  if (decision === "EXIT") {
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
        "EXIT required by Trader lifecycle rules."
    };
  }

  if (decision === "REDUCE") {
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
      dca?.eligible &&
      position.side === decision
    ) {
      return {
        action: "DCA_ADD",
        side: decision,
        notional:
          dca.proposedNotional,
        reduceOnly: false,
        price,
        reason:
          `Jev selected ${decision}; DCA add is eligible.`
      };
    }

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

/* =========================================================
   DUPLICATE / COOLDOWN / GLOBAL SAFETY
   ========================================================= */

function fingerprintState(state) {
  try {
    return crypto
      .createHash("sha256")
      .update(JSON.stringify(state))
      .digest("hex");
  } catch {
    return null;
  }
}

function checkDuplicate(fingerprint) {
  if (!fingerprint) {
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
  if (runtime.killSwitch) {
    return {
      blocked: true,
      reason:
        "Runtime emergency kill switch is active."
    };
  }

  if (isKillSwitchEnabled()) {
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
  globalSafety,
  policy
) {
  const blockers = [];

  if (!risk.passed) {
    blockers.push(
      ...risk.violations
    );
  }

  if (!freshness.passed) {
    blockers.push(
      freshness.reason
    );
  }

  if (duplicate) {
    blockers.push(
      "Duplicate market state detected."
    );
  }

  if (
    cooldown.active &&
    (
      intent.action === "OPEN_OR_ADD" ||
      intent.action === "DCA_ENTRY" ||
      intent.action === "DCA_ADD"
    )
  ) {
    blockers.push(
      "Trade decision cooldown is active."
    );
  }

  if (globalSafety.blocked) {
    blockers.push(
      globalSafety.reason
    );
  }

  // Live mode requires BOTH explicit switches.
  if (
    getTradingMode() === "LIVE" &&
    !isLiveTradingEnabled()
  ) {
    blockers.push(
      "LIVE mode requested but LIVE_TRADING_ENABLED is not true."
    );
  }

  // This engine never turns a NONE intent into an order.
  if (
    intent.notional > 0 &&
    intent.notional >
      policy.maxPositionNotional &&
    !intent.reduceOnly
  ) {
    blockers.push(
      "Final intent exceeds maximum position notional."
    );
  }

  return {
    allowed:
      blockers.length === 0,

    blockers
  };
}

/* =========================================================
   RUNTIME ACCOUNTING
   ========================================================= */

function updateAccumulationRuntime(
  finalIntent,
  position,
  accumulation
) {
  if (
    finalIntent.action !== "DCA_ADD"
  ) {
    return;
  }

  if (
    position.side === "FLAT" ||
    finalIntent.side !== position.side ||
    !accumulation.enabled
  ) {
    return;
  }

  runtime.accumulationEntries =
    accumulation.dailyEntries + 1;

  runtime.accumulationTotalEntries =
    Math.max(
      runtime.accumulationTotalEntries,
      accumulation.totalEntries
    ) + 1;
}

/* =========================================================
   MAIN EVALUATION
   ========================================================= */

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
    checkCooldown(policy);

  const globalSafety =
    applyGlobalSafety();

  const freshness =
    checkFreshness(
      normalizedState,
      policy
    );

  const evaluation =
    await evaluateMarketState(
      normalizedState
    );

  const selectedBase =
    determineDecision(
      evaluation,
      position,
      policy
    );

  const accumulation =
    checkAccumulationRules(
      normalizedState,
      position,
      policy,
      selectedBase.decision
    );

  const selected =
    applyAccumulationRules(
      selectedBase,
      accumulation,
      position,
      normalizedState,
      policy
    );

  const dca =
    getDcaState(
      normalizedState,
      position,
      accumulation,
      policy,
      selectedBase.decision
    );

  const intent =
    buildIntent(
      selected.decision,
      normalizedState,
      position,
      policy,
      accumulation,
      dca
    );

  const proposedNotional =
    (
      intent.action === "DCA_ENTRY" ||
      intent.action === "DCA_ADD"
    )
      ? intent.notional
      : null;

  const risk =
    checkRisk(
      normalizedState,
      position,
      policy,
      proposedNotional
    );

  const safety =
    applyHardSafety(
      intent,
      risk,
      freshness,
      duplicateResult.duplicate,
      cooldown,
      globalSafety,
      policy
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

  // Runtime bookkeeping happens after the final decision.
  runtime.lastDecisionAt =
    Date.now();

  runtime.lastDecisionFingerprint =
    fingerprint;

  if (
    finalIntent.action ===
      "OPEN_OR_ADD" ||
    finalIntent.action ===
      "DCA_ENTRY" ||
    finalIntent.action ===
      "DCA_ADD"
  ) {
    runtime.lastTradeFingerprint =
      fingerprint;

    updateAccumulationRuntime(
      finalIntent,
      position,
      accumulation
    );
  }

  return {
    engine: {
      name: ENGINE_NAME,
      version: ENGINE_VERSION
    },

    tradeId:
      createTradeId(),

    timestamp:
      new Date().toISOString(),

    mode:
      getTradingMode(),

    liveTradingEnabled:
      isLiveTradingEnabled(),

    evaluation,

    decision: {
      base:
        selectedBase.decision,

      final:
        selected.decision,

      overridden:
        selected.overridden,

      reasons:
        selected.reasons
    },

    position,

    accumulation,

    dca,

    intent,

    risk,

    freshness,

    safety: {
      allowed:
        safety.allowed,

      blockers:
        safety.blockers,

      duplicate:
        duplicateResult.duplicate,

      cooldown
    },

    audit: {
      fingerprint,
      runtime: getEngineStatus()
    }
  };
}

/* =========================================================
   KILL SWITCH
   ========================================================= */

export function setKillSwitch(enabled = true) {
  runtime.killSwitch =
    enabled === true;

  return getEngineStatus();
}

export function resetKillSwitch() {
  runtime.killSwitch = false;

  return getEngineStatus();
}

/* =========================================================
   DAILY LOSS LOCK
   ========================================================= */

export function setDailyLossLock(
  locked = true
) {
  runtime.dailyLossLocked =
    locked === true;

  return getEngineStatus();
}

export function resetDailyLossLock() {
  runtime.dailyLossLocked = false;

  return getEngineStatus();
}

/* =========================================================
   TRADE RESULT / CONSECUTIVE LOSS TRACKING
   ========================================================= */

export function recordTradeResult(
  result = {}
) {
  const pnl =
    numberOrNull(
      result.pnl ??
      result.realizedPnl ??
      result.profit
    );

  if (pnl === null) {
    throw new Error(
      "Trade result requires a numeric pnl, realizedPnl, or profit."
    );
  }

  if (pnl < 0) {
    runtime.consecutiveLosses += 1;
  } else if (pnl > 0) {
    runtime.consecutiveLosses = 0;
  }

  const dailyLoss =
    numberOrNull(
      result.dailyLoss
    );

  if (
    dailyLoss !== null
  ) {
    runtime.dailyLossLocked =
      Math.abs(dailyLoss) >=
      DEFAULT_POLICY.maxDailyLoss;
  }

  return {
    pnl,
    consecutiveLosses:
      runtime.consecutiveLosses,

    dailyLossLocked:
      runtime.dailyLossLocked,

    status:
      getEngineStatus()
  };
}

export function resetConsecutiveLosses() {
  runtime.consecutiveLosses = 0;

  return getEngineStatus();
}

/* =========================================================
   STATUS
   ========================================================= */

export function getEngineStatus() {
  return {
    engine:
      ENGINE_NAME,

    version:
      ENGINE_VERSION,

    tradingMode:
      getTradingMode(),

    liveTradingEnabled:
      isLiveTradingEnabled(),

    effectiveKillSwitch:
      runtime.killSwitch ||
      isKillSwitchEnabled(),

    consecutiveLosses:
      runtime.consecutiveLosses,

    dailyLossLocked:
      runtime.dailyLossLocked,

    accumulationEntries:
      runtime.accumulationEntries,

    accumulationTotalEntries:
      runtime.accumulationTotalEntries,

    lastDecisionAt:
      runtime.lastDecisionAt,

    lastDecisionFingerprint:
      runtime.lastDecisionFingerprint,

    lastTradeFingerprint:
      runtime.lastTradeFingerprint
  };
}

/* =========================================================
   POLICY EXPORT
   ========================================================= */

export function getDefaultPolicy() {
  return {
    ...DEFAULT_POLICY
  };
}

/* =========================================================
   RUNTIME RESET
   ========================================================= */

export function resetRuntime() {
  runtime.lastDecisionAt = 0;
  runtime.lastDecisionFingerprint = null;
  runtime.lastTradeFingerprint = null;

  runtime.consecutiveLosses = 0;
  runtime.dailyLossLocked = false;

  runtime.accumulationEntries = 0;
  runtime.accumulationDate = null;
  runtime.accumulationTotalEntries = 0;

  runtime.killSwitch = false;

  return getEngineStatus();
}

/* =========================================================
   DEFAULT EXPORT
   ========================================================= */

export default {
  evaluateTrade,
  getEngineStatus,
  getDefaultPolicy,

  setKillSwitch,
  resetKillSwitch,

  setDailyLossLock,
  resetDailyLossLock,

  recordTradeResult,
  resetConsecutiveLosses,

  resetRuntime
};
