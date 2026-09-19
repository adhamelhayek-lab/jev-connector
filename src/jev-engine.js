// ============================================================
// JEV ENGINE V5.1.0
// ============================================================
//
// Purpose:
// - Market evaluation
// - Trade evaluation
// - Jev Decisions API
// - OpenRouter integration
// - Timeout + retry protection
// - Structured results
// - Paper-trading only
// - NEVER executes trades
//
// IMPORTANT:
// Jev 1.13 uses the Decisions API:
//
// https://openrouter.ai/api/alpha/decisions
//
// DO NOT use /api/v1/chat/completions.
//
// Score criteria MUST be an array.
// Choice criteria MUST be an object.
// ============================================================


// ============================================================
// CONFIGURATION
// ============================================================

const OPENROUTER_URL =
  "https://openrouter.ai/api/alpha/decisions";

const JEV_MODEL =
  process.env.JEV_MODEL ||
  "typesafe/jev-1.13";

const OPENROUTER_API_KEY =
  process.env.OPENROUTER_API_KEY ||
  "";

const TIMEOUT_MS =
  Number(process.env.JEV_TIMEOUT_MS) > 0
    ? Number(process.env.JEV_TIMEOUT_MS)
    : 30000;

const MAX_RETRIES =
  Number(process.env.JEV_MAX_RETRIES) >= 0
    ? Math.min(
        Number(process.env.JEV_MAX_RETRIES),
        2
      )
    : 1;


// ============================================================
// SAFETY
// ============================================================

const SAFETY_POLICY = Object.freeze({

  executionAllowed:
    false,

  paperTrading:
    true,

  liveTrading:
    false,

  executorEnabled:
    false,

  walletAccess:
    false,

  privateKeys:
    false,

  withdrawals:
    false,

  reason:
    "Jev is evaluation-only. No trade execution is permitted."

});


// ============================================================
// UTILITIES
// ============================================================

function isObject(value) {

  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );

}


function isNonEmptyObject(value) {

  return (
    isObject(value) &&
    Object.keys(value).length > 0
  );

}


function clamp(
  value,
  min = 0,
  max = 1
) {

  const number =
    Number(value);

  if (
    !Number.isFinite(number)
  ) {
    return min;
  }

  return Math.min(
    max,
    Math.max(min, number)
  );

}


function createRequestId() {

  if (
    globalThis.crypto &&
    typeof globalThis.crypto.randomUUID ===
      "function"
  ) {

    return globalThis.crypto.randomUUID();

  }

  return [
    Date.now().toString(36),
    Math.random().toString(36).slice(2),
    Math.random().toString(36).slice(2)
  ].join("-");

}


function sleep(ms) {

  return new Promise(
    resolve =>
      setTimeout(resolve, ms)
  );

}


function isRetryableStatus(status) {

  return (
    status === 408 ||
    status === 429 ||
    status >= 500
  );

}


// ============================================================
// MARKET QUESTIONS
// ============================================================

function getMarketQuestions() {

  return {

    // --------------------------------------------------------
    // CHOICE
    // criteria is an OBJECT
    // --------------------------------------------------------

    market_direction: {

      type:
        "choice",

      instructions:
        "Determine the dominant market direction using only the supplied market state.",

      criteria: {

        bullish:
          "Evidence favors upward market pressure.",

        bearish:
          "Evidence favors downward market pressure.",

        sideways:
          "Evidence does not establish a clear direction."

      }

    },


    // --------------------------------------------------------
    // SCORE
    // criteria is an ARRAY
    // --------------------------------------------------------

    market_quality: {

      type:
        "score",

      instructions:
        "Evaluate the quality and clarity of the supplied market conditions.",

      criteria: [

        "Extremely poor or unusable conditions.",

        "Weak conditions and substantial uncertainty.",

        "Mixed or neutral conditions.",

        "Good conditions with reasonable clarity.",

        "Very clear and high-quality conditions."

      ]

    },


    // --------------------------------------------------------
    // SCORE
    // --------------------------------------------------------

    trade_risk: {

      type:
        "score",

      instructions:
        "Evaluate the apparent risk of taking a directional trade from the supplied market state.",

      criteria: [

        "Very low apparent risk.",

        "Low apparent risk.",

        "Moderate risk.",

        "High risk.",

        "Very high risk."

      ]

    },


    // --------------------------------------------------------
    // SCORE
    // --------------------------------------------------------

    trade_opportunity: {

      type:
        "score",

      instructions:
        "Evaluate the quality of the potential trading opportunity.",

      criteria: [

        "No meaningful opportunity.",

        "Weak opportunity.",

        "Moderate opportunity.",

        "Good opportunity.",

        "Very strong opportunity."

      ]

    },


    // --------------------------------------------------------
    // NOUL
    // --------------------------------------------------------

    should_consider_trade: {

      type:
        "noul",

      instructions:
        "Determine whether the supplied market state provides sufficient evidence to consider a trade."

    }

  };

}


// ============================================================
// TRADE QUESTIONS
// ============================================================

function getTradeQuestions() {

  return {

    // --------------------------------------------------------
    // CHOICE
    // --------------------------------------------------------

    trade_direction: {

      type:
        "choice",

      instructions:
        "Determine the direction best supported by the supplied trade state.",

      criteria: {

        long:
          "Evidence supports a long or buy direction.",

        short:
          "Evidence supports a short or sell direction.",

        flat:
          "Evidence does not justify a directional trade."

      }

    },


    // --------------------------------------------------------
    // SCORE
    // --------------------------------------------------------

    setup_quality: {

      type:
        "score",

      instructions:
        "Evaluate the quality of the proposed trade setup.",

      criteria: [

        "Invalid or unusable setup.",

        "Weak setup.",

        "Average setup.",

        "Good setup.",

        "Very strong setup."

      ]

    },


    // --------------------------------------------------------
    // SCORE
    // --------------------------------------------------------

    risk_level: {

      type:
        "score",

      instructions:
        "Evaluate the risk of the proposed trade.",

      criteria: [

        "Very low apparent risk.",

        "Low risk.",

        "Moderate risk.",

        "High risk.",

        "Very high risk."

      ]

    },


    // --------------------------------------------------------
    // NOUL
    // --------------------------------------------------------

    approve_trade: {

      type:
        "noul",

      instructions:
        "Determine whether the proposed trade has enough support to be considered for paper-trading evaluation."

    }

  };

}


// ============================================================
// OPENROUTER / JEV REQUEST
// ============================================================

async function requestJev(
  state,
  questions,
  requestId
) {

  if (!OPENROUTER_API_KEY) {

    throw new Error(
      "OPENROUTER_API_KEY is not configured"
    );

  }


  let lastError =
    null;


  for (
    let attempt = 0;
    attempt <= MAX_RETRIES;
    attempt++
  ) {

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

            method:
              "POST",

            headers: {

              "Authorization":
                `Bearer ${OPENROUTER_API_KEY}`,

              "Content-Type":
                "application/json",

              "HTTP-Referer":
                "https://jev-connector.onrender.com",

              "X-Title":
                "Jev Connector",

              "X-Request-ID":
                requestId

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


      const raw =
        await response.text();


      let data =
        {};


      if (raw) {

        try {

          data =
            JSON.parse(raw);

        } catch {

          throw new Error(
            `OpenRouter returned invalid JSON: ${raw.slice(0, 500)}`
          );

        }

      }


      if (!response.ok) {

        const message =
          data?.error?.message ||
          data?.message ||
          `HTTP ${response.status}`;


        const error =
          new Error(
            `OpenRouter ${response.status}: ${message}`
          );


        if (
          isRetryableStatus(
            response.status
          ) &&
          attempt < MAX_RETRIES
        ) {

          lastError =
            error;

          await sleep(
            500 *
            (attempt + 1)
          );

          continue;

        }


        throw error;

      }


      if (!isObject(data)) {

        throw new Error(
          "OpenRouter returned an invalid response object"
        );

      }


      if (!isObject(data.answers)) {

        throw new Error(
          "Jev response is missing the answers object"
        );

      }


      return data;

    } catch (error) {

      lastError =
        error;


      if (
        error?.name ===
        "AbortError"
      ) {

        if (
          attempt < MAX_RETRIES
        ) {

          await sleep(
            500 *
            (attempt + 1)
          );

          continue;

        }


        throw new Error(
          `Jev request timed out after ${TIMEOUT_MS}ms`
        );

      }


      if (
        attempt >= MAX_RETRIES
      ) {

        throw error;

      }


      await sleep(
        500 *
        (attempt + 1)
      );

    } finally {

      clearTimeout(
        timeout
      );

    }

  }


  throw (
    lastError ||
    new Error(
      "Jev request failed"
    )
  );

}


// ============================================================
// ANSWER NORMALIZATION
// ============================================================

function normalizeAnswer(answer) {

  if (
    !isObject(answer)
  ) {

    return {
      raw:
        answer
    };

  }


  const normalized =
    {};


  if (
    answer.type !== undefined
  ) {

    normalized.type =
      answer.type;

  }


  if (
    answer.choice !== undefined
  ) {

    normalized.choice =
      answer.choice;

  }


  if (
    answer.score !== undefined
  ) {

    normalized.score =
      Number(answer.score);

  }


  if (
    answer.noul !== undefined
  ) {

    normalized.noul =
      clamp(answer.noul);

  }


  if (
    answer.probabilities !== undefined
  ) {

    normalized.probabilities =
      answer.probabilities;

  }


  if (
    answer.confidence !== undefined
  ) {

    normalized.confidence =
      answer.confidence;

  }


  if (
    answer.legend !== undefined
  ) {

    normalized.legend =
      answer.legend;

  }


  return normalized;

}


function normalizeAnswers(
  answers
) {

  const output =
    {};


  for (
    const [
      key,
      value
    ] of Object.entries(
      answers
    )
  ) {

    output[key] =
      normalizeAnswer(
        value
      );

  }


  return output;

}


// ============================================================
// MARKET RESULT
// ============================================================

function buildMarketResult(
  providerResult
) {

  const answers =
    normalizeAnswers(
      providerResult.answers
    );


  return {

    direction:
      answers
        .market_direction
        ?.choice ||
      "unknown",


    marketQuality:
      answers
        .market_quality
        ?.score ??
      null,


    risk:
      answers
        .trade_risk
        ?.score ??
      null,


    opportunity:
      answers
        .trade_opportunity
        ?.score ??
      null,


    tradeConsiderationProbability:
      answers
        .should_consider_trade
        ?.noul ??
      null,


    answers,


    model:
      providerResult.model ||
      JEV_MODEL,


    provider:
      providerResult.provider ||
      null,


    usage:
      providerResult.usage ||
      null

  };

}


// ============================================================
// TRADE RESULT
// ============================================================

function buildTradeResult(
  providerResult
) {

  const answers =
    normalizeAnswers(
      providerResult.answers
    );


  return {

    direction:
      answers
        .trade_direction
        ?.choice ||
      "flat",


    setupQuality:
      answers
        .setup_quality
        ?.score ??
      null,


    risk:
      answers
        .risk_level
        ?.score ??
      null,


    approvalProbability:
      answers
        .approve_trade
        ?.noul ??
      null,


    answers,


    model:
      providerResult.model ||
      JEV_MODEL,


    provider:
      providerResult.provider ||
      null,


    usage:
      providerResult.usage ||
      null

  };

}


// ============================================================
// MARKET EVALUATION
// ============================================================

export async function evaluateMarketState(
  marketData
) {

  if (
    !isNonEmptyObject(
      marketData
    )
  ) {

    throw new Error(
      "Invalid market data: expected a non-empty object"
    );

  }


  const requestId =
    createRequestId();


  const providerResult =
    await requestJev(
      marketData,
      getMarketQuestions(),
      requestId
    );


  return {

    ok:
      true,

    operation:
      "market-evaluation",

    requestId,

    result:
      buildMarketResult(
        providerResult
      ),

    safety:
      SAFETY_POLICY

  };

}


// ============================================================
// TRADE EVALUATION
// ============================================================

export async function evaluateTrade(
  state,
  options = {}
) {

  if (
    !isNonEmptyObject(
      state
    )
  ) {

    throw new Error(
      "Invalid trade state: expected a non-empty object"
    );

  }


  if (
    !isObject(
      options
    )
  ) {

    throw new Error(
      "Invalid trade options: expected an object"
    );

  }


  const requestId =
    createRequestId();


  const combinedState = {

    state,

    options

  };


  const providerResult =
    await requestJev(
      combinedState,
      getTradeQuestions(),
      requestId
    );


  return {

    ok:
      true,

    operation:
      "trade-evaluation",

    requestId,

    result:
      buildTradeResult(
        providerResult
      ),

    safety:
      SAFETY_POLICY

  };

}


// ============================================================
// ENGINE STATUS
// ============================================================

export function getEngineStatus() {

  return {

    ok:
      true,

    engine:
      "Jev Engine",

    version:
      "5.1.0",

    provider:
      "OpenRouter",

    model:
      JEV_MODEL,

    endpoint:
      OPENROUTER_URL,

    mode:
      "evaluation-only",

    configured:
      Boolean(
        OPENROUTER_API_KEY
      ),

    timeoutMs:
      TIMEOUT_MS,

    maxRetries:
      MAX_RETRIES,

    safety:
      SAFETY_POLICY

  };

}


// ============================================================
// EXPORT
// ============================================================

export default {

  evaluateMarketState,

  evaluateTrade,

  getEngineStatus

};
