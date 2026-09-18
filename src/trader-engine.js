Jev Trader Engine V3.3.0 — BTC Auto-DCA Upgrade
Goal
V3.3 changes BTC DCA from a manual/existing-position-only mechanism into an automatic BTC accumulation decision layer.
It can:
check the current BTC price;
use Jev's LONG decision;
optionally consume a fresh, explicitly approved copy-trader/bot LONG signal;
open the first BTC DCA position automatically in PAPER mode;
add to an existing BTC LONG when price has moved at least minDcaDistanceBps lower;
keep BTC accumulation LONG-only;
never auto-EXIT or auto-REDUCE the BTC accumulation position;
keep hard risk, freshness, cooldown and kill-switch controls.
Important
Your GitHub integration rejected the direct file write with HTTP 403, so this upgrade is not pushed to GitHub automatically.
Your current V3.2.0 file remains the source of truth.
Apply the changes below to src/trader-engine.js.
1. Add these policy fields
In DEFAULT_POLICY, immediately after:
dcaNotionalFraction: 0.25,
  maxDcaNotional: 25,
  minDcaDistanceBps: 100,
add:
// Automatic BTC DCA entry controls.
  dcaEntryEnabled: true,
  dcaEntryMode: "JEV_OR_COPY",
  dcaInitialNotional: 25,
  dcaCopySignalEnabled: true,
  dcaCopySignalMaxAgeSeconds: 120,
  dcaCopyMinConfidence: 0.6,
  dcaPriceCheckRequired: true,
In normalizePolicy(), after the existing minDcaDistanceBps field, add:
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
      positiveNumberOrNull(merged.dcaCopySignalMaxAgeSeconds)
      ?? DEFAULT_POLICY.dcaCopySignalMaxAgeSeconds,

    dcaCopyMinConfidence:
      positiveNumberOrNull(merged.dcaCopyMinConfidence)
      ?? DEFAULT_POLICY.dcaCopyMinConfidence,

    dcaPriceCheckRequired:
      merged.dcaPriceCheckRequired !== false,
2. Fix the risk calculation
Replace:
const exposure =
    proposedNotional !== null &&
    position.side !== "FLAT"
      ? baseExposure + proposedNotional
      : baseExposure;
with:
const exposure =
    proposedNotional !== null
      ? baseExposure + proposedNotional
      : baseExposure;
This makes the initial BTC DCA entry count toward exposure limits too.
3. Replace the entire getDcaState() function
Delete the current getDcaState(...) function and replace it with:
function getCopySignal(state) {
  const raw =
    state &&
    typeof state === "object" &&
    !Array.isArray(state)
      ? (
          state.copySignal ??
          state.signal ??
          state.traderSignal ??
          null
        )
      : null;

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      present: false,
      eligible: false,
      reason: "No copy signal supplied."
    };
  }

  const symbol =
    typeof raw.symbol === "string" && raw.symbol.trim()
      ? raw.symbol.trim().toUpperCase()
      : null;

  const side =
    typeof raw.side === "string"
      ? raw.side.trim().toUpperCase()
      : null;

  const confidence =
    positiveNumberOrNull(raw.confidence);

  const timestamp =
    raw.timestamp ??
    raw.updatedAt ??
    null;

  const timestampMs =
    timestamp
      ? new Date(timestamp).getTime()
      : NaN;

  const ageSeconds =
    Number.isFinite(timestampMs)
      ? Math.max(0, (Date.now() - timestampMs) / 1000)
      : null;

  const source =
    typeof raw.source === "string" && raw.source.trim()
      ? raw.source.trim().slice(0, 120)
      : "unknown";

  const approved =
    raw.approved === true;

  const fresh =
    ageSeconds !== null &&
    ageSeconds <= 120;

  const eligible =
    approved &&
    symbol === "BTCUSDT" &&
    side === "LONG" &&
    confidence !== null &&
    confidence >= 0.6 &&
    fresh;

  let reason = null;

  if (!approved) {
    reason = "Copy signal is not explicitly approved.";
  } else if (symbol !== "BTCUSDT") {
    reason = "Copy signal is not for BTCUSDT.";
  } else if (side !== "LONG") {
    reason = "Copy signal is not LONG.";
  } else if (confidence === null) {
    reason = "Copy signal confidence is missing.";
  } else if (confidence < 0.6) {
    reason = "Copy signal confidence is below the minimum.";
  } else if (!fresh) {
    reason = "Copy signal is stale or missing a valid timestamp.";
  }

  return {
    present: true,
    eligible,
    approved,
    source,
    symbol,
    side,
    confidence,
    timestamp,
    ageSeconds,
    fresh,
    reason
  };
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
            state.price ?? state.market?.price
          )
        : null
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

  const symbol = getDcaSymbol(state);
  const copySignal = getCopySignal(state);

  const sameSide =
    position.side !== "FLAT" &&
    proposedDecision === position.side;

  const btcLongOnly =
    policy.dcaSymbol === "BTCUSDT" &&
    symbol === "BTCUSDT" &&
    (position.side === "LONG" || position.side === "FLAT");

  const enabled =
    policy.dcaEnabled &&
    accumulation.enabled &&
    btcLongOnly;

  const priceValid =
    currentPrice !== null &&
    currentPrice > 0;

  const priceCheckPassed =
    !policy.dcaPriceCheckRequired ||
    priceValid;

  const jevSignalEligible =
    proposedDecision === "LONG";

  const copySignalEligible =
    policy.dcaCopySignalEnabled &&
    (
      policy.dcaEntryMode === "COPY_ONLY" ||
      policy.dcaEntryMode === "JEV_OR_COPY"
    ) &&
    copySignal.eligible &&
    copySignal.ageSeconds !== null &&
    copySignal.ageSeconds <= policy.dcaCopySignalMaxAgeSeconds &&
    copySignal.confidence !== null &&
    copySignal.confidence >= policy.dcaCopyMinConfidence;

  const signalEligible =
    policy.dcaEntryMode === "COPY_ONLY"
      ? copySignalEligible
      : policy.dcaEntryMode === "JEV_ONLY"
        ? jevSignalEligible
        : (
            jevSignalEligible ||
            copySignalEligible
          );

  const distancePassed =
    position.side === "FLAT"
      ? true
      : (
          currentPrice !== null &&
          lastAccumulationPrice !== null &&
          currentPrice <=
            lastAccumulationPrice *
            (1 - policy.minDcaDistanceBps / 10_000)
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

  const initialNotional =
    Math.min(
      policy.dcaInitialNotional,
      policy.maxDcaNotional,
      policy.maxPositionNotional
    );

  const calculatedDcaNotional =
    position.side === "FLAT"
      ? initialNotional
      : position.notional > 0
        ? position.notional * policy.dcaNotionalFraction
        : null;

  const rawDcaNotional =
    requestedDcaNotional ??
    calculatedDcaNotional;

  const remainingPositionCapacity =
    Math.max(
      0,
      policy.maxPositionNotional - position.notional
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

  const initialEntryEligible =
    enabled &&
    policy.dcaEntryEnabled &&
    position.side === "FLAT" &&
    priceCheckPassed &&
    signalEligible &&
    sizePassed &&
    !dailyLimitReached &&
    !totalLimitReached;

  const addEligible =
    enabled &&
    policy.dcaEntryEnabled &&
    position.side === "LONG" &&
    sameSide &&
    priceCheckPassed &&
    signalEligible &&
    distancePassed &&
    sizePassed &&
    !accumulation.monthlyExitRequired &&
    !dailyLimitReached &&
    !totalLimitReached;

  let reason = null;

  if (!policy.dcaEnabled) {
    reason = "DCA is disabled by policy.";
  } else if (symbol !== policy.dcaSymbol) {
    reason =
      `DCA is restricted to ${policy.dcaSymbol}.`;
  } else if (!accumulation.enabled) {
    reason = "DCA requires accumulation mode to be enabled.";
  } else if (!policy.dcaEntryEnabled) {
    reason = "Automatic DCA entry is disabled by policy.";
  } else if (!priceCheckPassed) {
    reason = "BTC price is unavailable or invalid.";
  } else if (dailyLimitReached) {
    reason = "DCA is blocked by the daily accumulation limit.";
  } else if (totalLimitReached) {
    reason = "DCA is blocked by the maximum accumulation count.";
  } else if (copySignal.present && !copySignal.eligible && !jevSignalEligible) {
    reason = copySignal.reason;
  } else if (!signalEligible) {
    reason = "No eligible Jev or copy-trader LONG signal.";
  } else if (position.side === "LONG" && accumulation.monthlyExitRequired) {
    reason =
      "DCA is blocked because monthly accumulation exit is required.";
  } else if (position.side === "LONG" && !distancePassed) {
    reason =
      "DCA price-distance requirement has not been met.";
  } else if (!sizePassed) {
    reason =
      "DCA has no remaining position capacity or valid add size.";
  }

  return {
    enabled,
    symbol,
    targetSymbol: policy.dcaSymbol,
    longOnly: policy.dcaLongOnly,
    entryMode: policy.dcaEntryMode,
    entryEnabled: policy.dcaEntryEnabled,
    eligible:
      initialEntryEligible ||
      addEligible,
    entryEligible: initialEntryEligible,
    addEligible,
    signal: {
      jev: jevSignalEligible,
      copy: copySignal
    },
    currentPrice,
    lastAccumulationPrice,
    distanceBps,
    minDistanceBps: policy.minDcaDistanceBps,
    requestedNotional: requestedDcaNotional,
    calculatedNotional: calculatedDcaNotional,
    proposedNotional,
    maxDcaNotional: policy.maxDcaNotional,
    remainingPositionCapacity,
    priceCheckPassed,
    dailyLimitReached,
    totalLimitReached,
    reason
  };
}
4. Fix the manual-exit protection call
The current V3.2 call is missing state and policy.
Replace:
const selected =
    applyAccumulationRules(
      selectedBase,
      accumulation,
      position
    );
with:
const selected =
    applyAccumulationRules(
      selectedBase,
      accumulation,
      position,
      normalizedState,
      policy
    );
This is important because BTC accumulation must remain manual-exit only.
5. Add automatic initial DCA entry
Inside buildIntent(), immediately before the existing:
if (
    decision === "WAIT" ||
    decision === "HOLD"
  ) {
insert:
if (
    dca?.entryEligible &&
    position.side === "FLAT"
  ) {
    return {
      action: "DCA_ENTRY",
      side: "LONG",
      notional: dca.proposedNotional,
      reduceOnly: false,
      price,
      reason:
        dca.signal.copy
          ? `BTC DCA initial entry approved from copy signal: ${dca.signal.copy.source}.`
          : "BTC DCA initial entry approved by Jev."
    };
  }
6. Make DCA_ENTRY subject to cooldown
In applyHardSafety(), change:
intent.action === "OPEN_OR_ADD" ||
      intent.action === "DCA_ADD"
to:
intent.action === "OPEN_OR_ADD" ||
      intent.action === "DCA_ENTRY" ||
      intent.action === "DCA_ADD"
7. Make DCA_ENTRY subject to exposure/risk
Replace:
const proposedNotional =
    intent.action === "DCA_ADD"
      ? intent.notional
      : null;
with:
const proposedNotional =
    (
      intent.action === "DCA_ENTRY" ||
      intent.action === "DCA_ADD"
    )
      ? intent.notional
      : null;
8. Count DCA_ENTRY in accumulation runtime
Where V3.2 has:
finalIntent.action === "OPEN_OR_ADD" ||
    finalIntent.action === "DCA_ADD"
add DCA_ENTRY:
finalIntent.action === "OPEN_OR_ADD" ||
    finalIntent.action === "DCA_ENTRY" ||
    finalIntent.action === "DCA_ADD"
Then change the accumulation counter condition so DCA_ENTRY is also counted:
(
        finalIntent.action === "DCA_ENTRY" ||
        (
          finalIntent.action === "DCA_ADD" &&
          position.side !== "FLAT" &&
          finalIntent.side === position.side
        )
      ) &&
      accumulation.enabled
9. Add the new policy fields to getTraderStatus()
After:
minDcaDistanceBps:
        DEFAULT_POLICY.minDcaDistanceBps,
add:
dcaEntryEnabled:
        DEFAULT_POLICY.dcaEntryEnabled,

      dcaEntryMode:
        DEFAULT_POLICY.dcaEntryMode,

      dcaInitialNotional:
        DEFAULT_POLICY.dcaInitialNotional,

      dcaCopySignalEnabled:
        DEFAULT_POLICY.dcaCopySignalEnabled,

      dcaCopySignalMaxAgeSeconds:
        DEFAULT_POLICY.dcaCopySignalMaxAgeSeconds,

      dcaCopyMinConfidence:
        DEFAULT_POLICY.dcaCopyMinConfidence,

      dcaPriceCheckRequired:
        DEFAULT_POLICY.dcaPriceCheckRequired,
10. Change the version
At the top:
// V3.2.0
becomes:
// V3.3.0
and:
const ENGINE_VERSION = "3.2.0";
becomes:
const ENGINE_VERSION = "3.3.0";
Copy-signal format
When a copy-trader/bot source is connected later, the market state can contain:
"copySignal": {
  "approved": true,
  "source": "ExampleTraderBot",
  "symbol": "BTCUSDT",
  "side": "LONG",
  "confidence": 0.82,
  "timestamp": "2026-09-18T16:45:00Z"
}
V3.3 will reject it if it is:
not explicitly approved;
not BTCUSDT;
not LONG;
below the confidence threshold;
older than the configured freshness window.
This means we are not blindly copying a trader.
Resulting BTC behavior
BTCUSDT
                       │
                       ▼
              Current market price
                       │
             ┌─────────┴─────────┐
             │                   │
         Jev LONG          Approved copy signal
             │                   │
             └─────────┬─────────┘
                       ▼
                 DCA decision
                       │
              ┌────────┴────────┐
              │                 │
            ENTER             WAIT
              │
              ▼
        BTC LONG accumulation
              │
              ▼
       Price drops ≥ 1%
              │
              ▼
        DCA ADD evaluation
              │
              ▼
         Hard risk checks
              │
              ▼
        PAPER execution
Exit remains manual. Jev does not automatically close or reduce this long-term BTC accumulation position.
