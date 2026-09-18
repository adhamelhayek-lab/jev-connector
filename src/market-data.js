// ============================================================
// JEV CONNECTOR
// MARKET DATA ENGINE V2.1.0
// ============================================================
//
// Provider:
//   Binance USD-M Futures public market data
//
// Purpose:
//   - REST + WebSocket market data
//   - Price / candles
//   - Order-book depth and metrics
//   - Bid/ask spread
//   - Trade flow
//   - Volume
//   - Volatility
//   - Funding / mark / index price
//   - Open interest
//   - Long/short positioning
//   - Taker buy/sell flow
//   - Market regime
//   - Data freshness
//   - Abnormal-market detection
//   - Partial-data protection
//
// SECURITY BOUNDARY
// -----------------
// This module ONLY supplies market data.
//
// It NEVER:
//   - places trades
//   - accesses wallets
//   - accesses private keys
//   - withdraws funds
//   - changes exchange permissions
//   - decides trades
//
// Jev evaluates.
// Trader Engine applies risk.
// Execution Adapter eventually sends orders.
//
// ============================================================


// ============================================================
// CONFIGURATION
// ============================================================

const MODULE_NAME =
  "Jev Market Data";

const MODULE_VERSION =
  "2.2.0";

const REST_BASE_URL =
  process.env.MARKET_DATA_BASE_URL ||
  "https://fapi.binance.com";

const WS_BASE_URL =
  process.env.MARKET_DATA_WS_URL ||
  "wss://fstream.binance.com/stream";

const REQUEST_TIMEOUT_MS =
  Number.isFinite(Number(process.env.MARKET_DATA_TIMEOUT_MS))
    ? Math.max(
        1_000,
        Math.min(
          60_000,
          Number(process.env.MARKET_DATA_TIMEOUT_MS)
        )
      )
    : 10_000;

const DEFAULT_CANDLE_LIMIT =
  200;

const DEFAULT_DEPTH_LIMIT =
  20;

const DEFAULT_TRADE_LIMIT =
  100;

const MAX_CANDLE_LIMIT =
  1000;

const MAX_RESPONSE_BYTES =
  5_000_000;

const DEFAULT_FRESHNESS_SECONDS =
  Number.isFinite(Number(process.env.MARKET_DATA_FRESHNESS_SECONDS))
    ? Math.max(
        1,
        Math.min(300, Number(process.env.MARKET_DATA_FRESHNESS_SECONDS))
      )
    : 30;

const MAX_WS_SYMBOLS =
  100;

const MAX_WS_STREAMS =
  500;

const MAX_HTTP_RETRIES =
  2;

const RETRY_BASE_DELAY_MS =
  350;

const VALID_INTERVALS =
  new Set([
    "1m",
    "3m",
    "5m",
    "15m",
    "30m",
    "1h",
    "2h",
    "4h",
    "6h",
    "8h",
    "12h",
    "1d"
  ]);

const VALID_RATIO_PERIODS =
  new Set([
    "5m",
    "15m",
    "30m",
    "1h",
    "2h",
    "4h"
  ]);

const memory =
  new Map();

const inFlightMarketStates =
  new Map();

const websocketState = {
  socket: null,
  connected: false,
  connecting: false,
  reconnectTimer: null,
  reconnectAttempts: 0,
  streams: new Set(),
  symbols: [],
  lastMessageAt: 0,
  lastError: null,
  lastConnectedAt: 0,
  manualDisconnect: false,
  lastHeartbeatAt: 0,
  lastReconnectAt: 0,
  socketGeneration: 0
};


// ============================================================
// BASIC HELPERS
// ============================================================

function numberOrNull(value) {
  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}


function positiveNumberOrNull(value) {
  const number =
    numberOrNull(value);

  if (
    number === null ||
    number < 0
  ) {
    return null;
  }

  return number;
}


function normalizeSymbol(symbol) {
  if (
    typeof symbol !== "string"
  ) {
    throw new Error(
      "Symbol must be a string."
    );
  }

  const normalized =
    symbol
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");

  if (
    normalized.length < 5 ||
    normalized.length > 20
  ) {
    throw new Error(
      "Invalid market symbol."
    );
  }

  return normalized;
}


function streamSymbol(symbol) {
  return normalizeSymbol(symbol)
    .toLowerCase();
}


function now() {
  return Date.now();
}


function iso(timestamp = now()) {
  const value =
    Number(timestamp);

  return Number.isFinite(value)
    ? new Date(value).toISOString()
    : null;
}


function byteLength(value) {
  try {
    return Buffer.byteLength(
      value,
      "utf8"
    );
  } catch {
    return new TextEncoder()
      .encode(value)
      .length;
  }
}


function clamp(
  value,
  minimum,
  maximum
) {
  const number =
    numberOrNull(value);

  if (number === null) {
    return null;
  }

  return Math.min(
    maximum,
    Math.max(
      minimum,
      number
    )
  );
}


function safeLimit(
  value,
  fallback,
  maximum
) {
  const number =
    Number(value);

  if (
    !Number.isFinite(number)
  ) {
    return fallback;
  }

  return Math.min(
    maximum,
    Math.max(
      1,
      Math.floor(number)
    )
  );
}


function safePeriod(period) {
  return VALID_RATIO_PERIODS.has(period)
    ? period
    : "5m";
}


function safeInterval(interval) {
  return VALID_INTERVALS.has(interval)
    ? interval
    : "5m";
}


function ageSeconds(timestamp) {
  const value =
    numberOrNull(timestamp);

  if (
    value === null ||
    value <= 0
  ) {
    return null;
  }

  return Math.max(
    0,
    (now() - value) / 1000
  );
}


// ============================================================
// HTTP
// ============================================================

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

function retryDelayMs(attempt, retryAfterHeader) {
  const retryAfter =
    Number(retryAfterHeader);

  if (Number.isFinite(retryAfter) && retryAfter >= 0) {
    return Math.min(10_000, retryAfter * 1_000);
  }

  return Math.min(
    5_000,
    RETRY_BASE_DELAY_MS * Math.pow(2, attempt)
  );
}

async function fetchJson(
  url,
  timeoutMs = REQUEST_TIMEOUT_MS
) {
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_HTTP_RETRIES; attempt++) {
    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () => controller.abort(),
        timeoutMs
      );

    try {
      const response =
        await fetch(
          url,
          {
            method: "GET",
            headers: {
              accept: "application/json",
              "user-agent": "Jev-Market-Data/2.2"
            },
            signal: controller.signal
          }
        );

      const text =
        await response.text();

      if (byteLength(text) > MAX_RESPONSE_BYTES) {
        throw new Error(
          "Market data response is too large."
        );
      }

      let data;

      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(
          `Market data returned invalid JSON (HTTP ${response.status}).`
        );
      }

      if (!response.ok) {
        const apiMessage =
          data?.msg ||
          data?.message ||
          data?.error ||
          `HTTP ${response.status}`;

        const error =
          new Error(
            `Market data request failed: ${apiMessage}`
          );

        error.status = response.status;
        error.rateLimit = response.headers.get("x-mbx-used-weight-1m");
        error.retryAfter = response.headers.get("retry-after");
        error.retryable =
          response.status === 429 ||
          response.status === 418 ||
          response.status >= 500;

        throw error;
      }

      return {
        data,
        status: response.status,
        rateLimitUsed: response.headers.get("x-mbx-used-weight-1m")
      };
    } catch (error) {
      if (error?.name === "AbortError") {
        lastError = new Error(
          `Market data request timed out after ${timeoutMs} ms.`
        );
        lastError.retryable = true;
      } else {
        lastError = error;
      }

      const retryable =
        lastError?.retryable === true ||
        lastError?.status === 429 ||
        lastError?.status === 418 ||
        lastError?.status >= 500;

      if (!retryable || attempt >= MAX_HTTP_RETRIES) {
        throw lastError;
      }

      await sleep(
        retryDelayMs(
          attempt,
          lastError?.retryAfter
        )
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error("Market data request failed.");
}

async function rest(
  path,
  params = {}
) {
  const base =
    REST_BASE_URL.endsWith("/")
      ? REST_BASE_URL
      : `${REST_BASE_URL}/`;

  const url =
    new URL(
      path.replace(/^\//, ""),
      base
    );

  for (
    const [key, value]
    of Object.entries(params)
  ) {
    if (
      value !== undefined &&
      value !== null
    ) {
      url.searchParams.set(
        key,
        String(value)
      );
    }
  }

  const result =
    await fetchJson(
      url.toString()
    );

  return result.data;
}


async function tryRest(
  name,
  fn
) {
  try {
    return {
      ok: true,
      data: await fn(),
      error: null
    };
  } catch (error) {
    return {
      ok: false,
      data: null,
      error: {
        source:
          name,

        message:
          error?.message ||
          "Unknown market-data error",

        status:
          error?.status ??
          null
      }
    };
  }
}


// ============================================================
// 24H TICKER
// ============================================================

export async function getTicker(
  symbol
) {
  const normalized =
    normalizeSymbol(symbol);

  const data =
    await rest(
      "/fapi/v1/ticker/24hr",
      {
        symbol:
          normalized
      }
    );

  return {
    symbol:
      data.symbol ??
      normalized,

    price:
      positiveNumberOrNull(
        data.lastPrice
      ),

    open:
      positiveNumberOrNull(
        data.openPrice
      ),

    high:
      positiveNumberOrNull(
        data.highPrice
      ),

    low:
      positiveNumberOrNull(
        data.lowPrice
      ),

    volume:
      positiveNumberOrNull(
        data.volume
      ),

    quoteVolume:
      positiveNumberOrNull(
        data.quoteVolume
      ),

    priceChange:
      numberOrNull(
        data.priceChange
      ),

    priceChangePercent:
      numberOrNull(
        data.priceChangePercent
      ),

    weightedAveragePrice:
      positiveNumberOrNull(
        data.weightedAvgPrice
      ),

    lastQuantity:
      positiveNumberOrNull(
        data.lastQty
      ),

    timestamp:
      iso(),

    timestampMs:
      now(),

    source:
      "binance-usdm-futures"
  };
}


// ============================================================
// CANDLES
// ============================================================

export async function getCandles(
  symbol,
  interval = "1m",
  limit = DEFAULT_CANDLE_LIMIT
) {
  const normalized =
    normalizeSymbol(symbol);

  const safeIntervalValue =
    safeInterval(interval);

  const safeLimitValue =
    Math.min(
      safeLimit(
        limit,
        DEFAULT_CANDLE_LIMIT,
        MAX_CANDLE_LIMIT
      ),
      MAX_CANDLE_LIMIT
    );

  const data =
    await rest(
      "/fapi/v1/klines",
      {
        symbol:
          normalized,

        interval:
          safeIntervalValue,

        limit:
          safeLimitValue
      }
    );

  if (
    !Array.isArray(data)
  ) {
    throw new Error(
      "Invalid candle response."
    );
  }

  return data.map(
    candle => ({
      openTime:
        numberOrNull(candle[0]),

      openTimeISO:
        iso(candle[0]),

      open:
        positiveNumberOrNull(candle[1]),

      high:
        positiveNumberOrNull(candle[2]),

      low:
        positiveNumberOrNull(candle[3]),

      close:
        positiveNumberOrNull(candle[4]),

      volume:
        positiveNumberOrNull(candle[5]),

      closeTime:
        numberOrNull(candle[6]),

      closeTimeISO:
        iso(candle[6]),

      quoteVolume:
        positiveNumberOrNull(candle[7]),

      trades:
        numberOrNull(candle[8]),

      takerBuyBaseVolume:
        positiveNumberOrNull(candle[9]),

      takerBuyQuoteVolume:
        positiveNumberOrNull(candle[10]),

      closed:
        numberOrNull(candle[6]) !== null
          ? Number(candle[6]) < now()
          : null
    })
  );
}


// ============================================================
// ORDER BOOK
// ============================================================

export async function getOrderBook(
  symbol,
  limit = DEFAULT_DEPTH_LIMIT
) {
  const normalized =
    normalizeSymbol(symbol);

  const allowedLimits =
    new Set([
      5,
      10,
      20,
      50,
      100,
      500,
      1000
    ]);

  const requested =
    Number(limit);

  const safeDepth =
    allowedLimits.has(
      requested
    )
      ? requested
      : DEFAULT_DEPTH_LIMIT;

  const data =
    await rest(
      "/fapi/v1/depth",
      {
        symbol:
          normalized,

        limit:
          safeDepth
      }
    );

  const bids =
    Array.isArray(data.bids)
      ? data.bids
          .map(row => ({
            price:
              positiveNumberOrNull(row[0]),

            quantity:
              positiveNumberOrNull(row[1])
          }))
          .filter(
            row =>
              row.price !== null &&
              row.quantity !== null
          )
      : [];

  const asks =
    Array.isArray(data.asks)
      ? data.asks
          .map(row => ({
            price:
              positiveNumberOrNull(row[0]),

            quantity:
              positiveNumberOrNull(row[1])
          }))
          .filter(
            row =>
              row.price !== null &&
              row.quantity !== null
          )
      : [];

  return {
    symbol:
      normalized,

    lastUpdateId:
      data.lastUpdateId ??
      null,

    bids,

    asks,

    timestamp:
      iso(),

    timestampMs:
      now()
  };
}


// ============================================================
// BOOK METRICS
// ============================================================

export function calculateOrderBookMetrics(
  orderBook
) {
  const bids =
    Array.isArray(orderBook?.bids)
      ? orderBook.bids
      : [];

  const asks =
    Array.isArray(orderBook?.asks)
      ? orderBook.asks
      : [];

  const validBids =
    bids.filter(
      level =>
        numberOrNull(level?.price) !== null &&
        numberOrNull(level?.quantity) !== null
    );

  const validAsks =
    asks.filter(
      level =>
        numberOrNull(level?.price) !== null &&
        numberOrNull(level?.quantity) !== null
    );

  const bestBid =
    validBids.length > 0
      ? Math.max(
          ...validBids.map(
            level =>
              Number(level.price)
          )
        )
      : null;

  const bestAsk =
    validAsks.length > 0
      ? Math.min(
          ...validAsks.map(
            level =>
              Number(level.price)
          )
        )
      : null;

  const bidQuantity =
    validBids.reduce(
      (total, level) =>
        total +
        Number(level.quantity),
      0
    );

  const askQuantity =
    validAsks.reduce(
      (total, level) =>
        total +
        Number(level.quantity),
      0
    );

  const totalDepth =
    bidQuantity +
    askQuantity;

  const imbalance =
    totalDepth > 0
      ? (
          bidQuantity -
          askQuantity
        ) /
        totalDepth
      : null;

  const midPrice =
    bestBid !== null &&
    bestAsk !== null
      ? (
          bestBid +
          bestAsk
        ) / 2
      : null;

  const spread =
    bestBid !== null &&
    bestAsk !== null
      ? Math.max(
          0,
          bestAsk -
          bestBid
        )
      : null;

  const spreadBps =
    midPrice !== null &&
    midPrice > 0 &&
    spread !== null
      ? (
          spread /
          midPrice
        ) * 10_000
      : null;

  return {
    bestBid,

    bestAsk,

    midPrice,

    spread,

    spreadBps,

    bidQuantity,

    askQuantity,

    totalDepth,

    imbalance,

    bidLevels:
      validBids.length,

    askLevels:
      validAsks.length
  };
}


// ============================================================
// BOOK TICKER
// ============================================================

export async function getBookTicker(
  symbol
) {
  const normalized =
    normalizeSymbol(symbol);

  const data =
    await rest(
      "/fapi/v1/ticker/bookTicker",
      {
        symbol:
          normalized
      }
    );

  return {
    symbol:
      data.symbol ??
      normalized,

    bidPrice:
      positiveNumberOrNull(
        data.bidPrice
      ),

    bidQuantity:
      positiveNumberOrNull(
        data.bidQty
      ),

    askPrice:
      positiveNumberOrNull(
        data.askPrice
      ),

    askQuantity:
      positiveNumberOrNull(
        data.askQty
      ),

    updateId:
      data.updateId ??
      null,

    timestamp:
      iso(),

    timestampMs:
      now()
  };
}


// ============================================================
// RECENT TRADES
// ============================================================

export async function getRecentTrades(
  symbol,
  limit = DEFAULT_TRADE_LIMIT
) {
  const normalized =
    normalizeSymbol(symbol);

  const safeTradeLimit =
    safeLimit(
      limit,
      DEFAULT_TRADE_LIMIT,
      1000
    );

  const data =
    await rest(
      "/fapi/v1/trades",
      {
        symbol:
          normalized,

        limit:
          safeTradeLimit
      }
    );

  if (
    !Array.isArray(data)
  ) {
    throw new Error(
      "Invalid trade response."
    );
  }

  return data.map(
    trade => ({
      id:
        trade.id ?? null,

      price:
        positiveNumberOrNull(
          trade.price
        ),

      quantity:
        positiveNumberOrNull(
          trade.qty
        ),

      quoteQuantity:
        positiveNumberOrNull(
          trade.quoteQty
        ),

      timestamp:
        numberOrNull(
          trade.time
        ),

      timestampISO:
        iso(trade.time),

      buyerMaker:
        Boolean(
          trade.isBuyerMaker
        )
    })
  );
}


// ============================================================
// TRADE FLOW
// ============================================================

export function calculateTradeFlow(
  trades
) {
  if (
    !Array.isArray(trades) ||
    trades.length === 0
  ) {
    return {
      sufficientData:
        false,

      reason:
        "No recent trades available."
    };
  }

  let buyVolume = 0;
  let sellVolume = 0;
  let validTrades = 0;

  for (
    const trade of trades
  ) {
    const quantity =
      positiveNumberOrNull(
        trade?.quantity
      );

    if (
      quantity === null
    ) {
      continue;
    }

    validTrades += 1;

    if (
      trade.buyerMaker
    ) {
      sellVolume += quantity;
    } else {
      buyVolume += quantity;
    }
  }

  if (
    validTrades === 0
  ) {
    return {
      sufficientData:
        false,

      reason:
        "Recent trades contained no valid quantities."
    };
  }

  const totalVolume =
    buyVolume +
    sellVolume;

  const buyRatio =
    totalVolume > 0
      ? buyVolume /
        totalVolume
      : null;

  const sellRatio =
    totalVolume > 0
      ? sellVolume /
        totalVolume
      : null;

  const delta =
    buyVolume -
    sellVolume;

  return {
    sufficientData:
      true,

    tradeCount:
      validTrades,

    buyVolume,

    sellVolume,

    totalVolume,

    delta,

    buyRatio,

    sellRatio,

    direction:
      delta > 0
        ? "BUY_PRESSURE"
        : delta < 0
          ? "SELL_PRESSURE"
          : "BALANCED"
  };
}


// ============================================================
// FUTURES PREMIUM / FUNDING
// ============================================================

export async function getPremiumIndex(
  symbol
) {
  const normalized =
    normalizeSymbol(symbol);

  const data =
    await rest(
      "/fapi/v1/premiumIndex",
      {
        symbol:
          normalized
      }
    );

  return {
    symbol:
      data.symbol ??
      normalized,

    markPrice:
      positiveNumberOrNull(
        data.markPrice
      ),

    indexPrice:
      positiveNumberOrNull(
        data.indexPrice
      ),

    lastFundingRate:
      numberOrNull(
        data.lastFundingRate
      ),

    nextFundingTime:
      numberOrNull(
        data.nextFundingTime
      ),

    nextFundingTimeISO:
      iso(
        data.nextFundingTime
      ),

    timestamp:
      numberOrNull(
        data.time
      ),

    timestampISO:
      iso(
        data.time
      )
  };
}


// ============================================================
// OPEN INTEREST
// ============================================================

export async function getOpenInterest(
  symbol
) {
  const normalized =
    normalizeSymbol(symbol);

  const data =
    await rest(
      "/fapi/v1/openInterest",
      {
        symbol:
          normalized
      }
    );

  return {
    symbol:
      data.symbol ??
      normalized,

    openInterest:
      positiveNumberOrNull(
        data.openInterest
      ),

    timestamp:
      numberOrNull(
        data.time
      ),

    timestampISO:
      iso(
        data.time
      )
  };
}


// ============================================================
// LONG / SHORT RATIO
// ============================================================

export async function getLongShortRatio(
  symbol,
  period = "5m",
  limit = 30
) {
  const normalized =
    normalizeSymbol(symbol);

  const pair =
    normalized.endsWith("USDT")
      ? normalized.slice(0, -4)
      : normalized;

  const safeLimitValue =
    safeLimit(
      limit,
      30,
      500
    );

  const safePeriodValue =
    safePeriod(period);

  const data =
    await rest(
      "/futures/data/globalLongShortAccountRatio",
      {
        pair,

        period:
          safePeriodValue,

        limit:
          safeLimitValue
      }
    );

  if (
    !Array.isArray(data)
  ) {
    throw new Error(
      "Invalid long/short ratio response."
    );
  }

  return data.map(
    row => ({
      pair,

      longShortRatio:
        numberOrNull(
          row.longShortRatio
        ),

      longAccount:
        numberOrNull(
          row.longAccount
        ),

      shortAccount:
        numberOrNull(
          row.shortAccount
        ),

      timestamp:
        numberOrNull(
          row.timestamp
        ),

      timestampISO:
        iso(
          row.timestamp
        )
    })
  );
}


// ============================================================
// OPEN INTEREST HISTORY
// ============================================================

export async function getOpenInterestHistory(
  symbol,
  period = "5m",
  limit = 30
) {
  const normalized =
    normalizeSymbol(symbol);

  const pair =
    normalized.endsWith("USDT")
      ? normalized.slice(0, -4)
      : normalized;

  const safeLimitValue =
    safeLimit(
      limit,
      30,
      500
    );

  const safePeriodValue =
    safePeriod(period);

  const data =
    await rest(
      "/futures/data/openInterestHist",
      {
        pair,

        contractType:
          "PERPETUAL",

        period:
          safePeriodValue,

        limit:
          safeLimitValue
      }
    );

  if (
    !Array.isArray(data)
  ) {
    throw new Error(
      "Invalid open-interest history response."
    );
  }

  return data.map(
    row => ({
      pair,

      openInterest:
        numberOrNull(
          row.sumOpenInterest
        ),

      openInterestValue:
        numberOrNull(
          row.sumOpenInterestValue
        ),

      timestamp:
        numberOrNull(
          row.timestamp
        ),

      timestampISO:
        iso(
          row.timestamp
        )
    })
  );
}


// ============================================================
// TAKER BUY / SELL VOLUME
// ============================================================

export async function getTakerVolume(
  symbol,
  period = "5m",
  limit = 30
) {
  const normalized =
    normalizeSymbol(symbol);

  const pair =
    normalized.endsWith("USDT")
      ? normalized.slice(0, -4)
      : normalized;

  const safeLimitValue =
    safeLimit(
      limit,
      30,
      500
    );

  const safePeriodValue =
    safePeriod(period);

  const data =
    await rest(
      "/futures/data/takerlongshortRatio",
      {
        symbol:
          normalized,

        period:
          safePeriodValue,

        limit:
          safeLimitValue
      }
    );

  if (
    !Array.isArray(data)
  ) {
    return [];
  }

  return data.map(
    row => ({
      pair,

      symbol:
        normalized,

      buySellRatio:
        numberOrNull(
          row.buySellRatio
        ),

      buyVol:
        numberOrNull(
          row.buyVol
        ),

      sellVol:
        numberOrNull(
          row.sellVol
        ),

      timestamp:
        numberOrNull(
          row.timestamp
        ),

      timestampISO:
        iso(
          row.timestamp
        )
    })
  );
}


// ============================================================
// VOLATILITY
// ============================================================

export function calculateVolatility(
  candles
) {
  if (
    !Array.isArray(candles) ||
    candles.length < 3
  ) {
    return {
      sufficientData:
        false,

      reason:
        "At least 3 candles are required."
    };
  }

  const valid =
    candles.filter(
      candle =>
        numberOrNull(candle?.close) !== null &&
        Number(candle.close) > 0
    );

  if (
    valid.length < 3
  ) {
    return {
      sufficientData:
        false,

      reason:
        "Not enough valid closing prices."
    };
  }

  const closes =
    valid.map(
      candle =>
        Number(candle.close)
    );

  const returns = [];

  for (
    let i = 1;
    i < closes.length;
    i++
  ) {
    if (
      closes[i - 1] > 0
    ) {
      returns.push(
        (
          closes[i] -
          closes[i - 1]
        ) /
        closes[i - 1]
      );
    }
  }

  if (
    returns.length < 2
  ) {
    return {
      sufficientData:
        false,

      reason:
        "Not enough valid returns."
    };
  }

  const mean =
    returns.reduce(
      (a, b) => a + b,
      0
    ) /
    returns.length;

  const variance =
    returns.reduce(
      (sum, value) =>
        sum +
        Math.pow(
          value - mean,
          2
        ),
      0
    ) /
    returns.length;

  const standardDeviation =
    Math.sqrt(
      Math.max(
        0,
        variance
      )
    );

  const latestReturn =
    returns[
      returns.length - 1
    ];

  return {
    sufficientData:
      true,

    sampleCount:
      returns.length,

    meanReturn:
      mean,

    standardDeviation,

    percentageVolatility:
      standardDeviation * 100,

    latestReturn,

    latestReturnPercent:
      latestReturn * 100
  };
}


// ============================================================
// ATR / RANGE METRICS
// ============================================================

export function calculateRangeMetrics(
  candles
) {
  if (
    !Array.isArray(candles) ||
    candles.length < 2
  ) {
    return {
      sufficientData:
        false
    };
  }

  const valid =
    candles.filter(
      candle =>
        numberOrNull(candle?.high) !== null &&
        numberOrNull(candle?.low) !== null &&
        numberOrNull(candle?.close) !== null
    );

  if (
    valid.length < 2
  ) {
    return {
      sufficientData:
        false
    };
  }

  const trueRanges = [];

  for (
    let i = 1;
    i < valid.length;
    i++
  ) {
    const high =
      Number(valid[i].high);

    const low =
      Number(valid[i].low);

    const previousClose =
      Number(valid[i - 1].close);

    trueRanges.push(
      Math.max(
        high - low,
        Math.abs(
          high -
          previousClose
        ),
        Math.abs(
          low -
          previousClose
        )
      )
    );
  }

  const latestClose =
    Number(
      valid[valid.length - 1].close
    );

  const atr =
    trueRanges.length > 0
      ? trueRanges.reduce(
          (a, b) => a + b,
          0
        ) /
        trueRanges.length
      : null;

  return {
    sufficientData:
      atr !== null,

    averageTrueRange:
      atr,

    atrPercent:
      atr !== null &&
      latestClose > 0
        ? (
            atr /
            latestClose
          ) * 100
        : null,

    latestRange:
      trueRanges[
        trueRanges.length - 1
      ] ?? null
  };
}


// ============================================================
// TREND / MARKET REGIME
// ============================================================

export function calculateMarketRegime(
  candles
) {
  if (
    !Array.isArray(candles) ||
    candles.length < 20
  ) {
    return {
      sufficientData:
        false,

      regime:
        "UNKNOWN",

      reason:
        "At least 20 candles are required."
    };
  }

  const closes =
    candles
      .map(
        candle =>
          numberOrNull(
            candle?.close
          )
      )
      .filter(
        value =>
          value !== null &&
          value > 0
      );

  if (
    closes.length < 20
  ) {
    return {
      sufficientData:
        false,

      regime:
        "UNKNOWN"
    };
  }

  const shortWindow =
    closes.slice(-10);

  const longWindow =
    closes.slice(-20);

  const shortAverage =
    shortWindow.reduce(
      (a, b) => a + b,
      0
    ) /
    shortWindow.length;

  const longAverage =
    longWindow.reduce(
      (a, b) => a + b,
      0
    ) /
    longWindow.length;

  const first =
    closes[0];

  const last =
    closes[
      closes.length - 1
    ];

  const change =
    first > 0
      ? (
          (last - first) /
          first
        ) * 100
      : 0;

  const averageGapPercent =
    longAverage > 0
      ? (
          (
            shortAverage -
            longAverage
          ) /
          longAverage
        ) * 100
      : 0;

  let regime =
    "RANGE";

  if (
    averageGapPercent > 0 &&
    change > 0
  ) {
    regime =
      "BULLISH";
  } else if (
    averageGapPercent < 0 &&
    change < 0
  ) {
    regime =
      "BEARISH";
  }

  return {
    sufficientData:
      true,

    regime,

    shortAverage,

    longAverage,

    averageGapPercent,

    percentageChange:
      change
  };
}


// ============================================================
// ABNORMAL MARKET DETECTION
// ============================================================

export function detectAbnormalMarket(
  marketState
) {
  const warnings = [];

  const priceChange =
    numberOrNull(
      marketState
        ?.ticker
        ?.priceChangePercent
    );

  const spreadBps =
    numberOrNull(
      marketState
        ?.orderBook
        ?.metrics
        ?.spreadBps
    );

  const volatility =
    numberOrNull(
      marketState
        ?.volatility
        ?.percentageVolatility
    );

  const atrPercent =
    numberOrNull(
      marketState
        ?.range
        ?.atrPercent
    );

  if (
    priceChange !== null &&
    Math.abs(priceChange) >= 15
  ) {
    warnings.push(
      "Extreme 24-hour price movement."
    );
  }

  if (
    spreadBps !== null &&
    spreadBps >= 50
  ) {
    warnings.push(
      "Abnormally wide bid/ask spread."
    );
  }

  if (
    volatility !== null &&
    volatility >= 5
  ) {
    warnings.push(
      "High short-term return volatility."
    );
  }

  if (
    atrPercent !== null &&
    atrPercent >= 5
  ) {
    warnings.push(
      "High average candle range relative to price."
    );
  }

  const realtimeAge =
    ageSeconds(
      marketState
        ?.realtime
        ?.lastEventAt
    );

  if (
    realtimeAge !== null &&
    realtimeAge >
      DEFAULT_FRESHNESS_SECONDS
  ) {
    warnings.push(
      "WebSocket market data is stale."
    );
  }

  return {
    abnormal:
      warnings.length > 0,

    warningCount:
      warnings.length,

    warnings
  };
}


// ============================================================
// DATA QUALITY / FRESHNESS
// ============================================================

function assessMarketDataQuality(
  marketState,
  sourceResults
) {
  const unavailable = [];
  const stale = [];

  for (const [name, result] of Object.entries(sourceResults)) {
    if (result && result.ok === false) {
      unavailable.push({
        source: name,
        error: result.error
      });
    }
  }

  const timestampChecks = [
    ["ticker", marketState?.ticker?.timestampMs],
    ["orderBook", marketState?.orderBook?.timestampMs],
    ["bookTicker", marketState?.bookTicker?.timestampMs],
    ["premium", marketState?.futures?.premium?.timestampMs],
    ["openInterest", marketState?.futures?.openInterest?.timestampMs]
  ];

  for (const [name, timestamp] of timestampChecks) {
    const age = ageSeconds(timestamp);

    if (age !== null && age > DEFAULT_FRESHNESS_SECONDS) {
      stale.push({
        source: name,
        ageSeconds: age
      });
    }
  }

  const availableCount =
    Object.values(sourceResults)
      .filter(result => result?.ok === true)
      .length;

  const totalSources =
    Object.keys(sourceResults).length;

  const completeness =
    totalSources > 0
      ? availableCount / totalSources
      : 0;

  const criticalSources = [
    "ticker",
    "candles",
    "orderBook",
    "bookTicker"
  ];

  const unavailableCritical =
    criticalSources.filter(
      name => sourceResults[name]?.ok !== true
    );

  const staleCritical =
    stale
      .filter(item => criticalSources.includes(item.source))
      .map(item => item.source);

  const usable =
    completeness >= 0.6 &&
    unavailableCritical.length === 0 &&
    staleCritical.length === 0;

  return {
    sufficientData: usable,
    usable,
    completeness,
    availableSources: availableCount,
    totalSources,
    unavailable,
    stale,
    staleSources: stale.map(item => item.source),
    criticalSources,
    unavailableCritical,
    staleCritical,
    freshnessSeconds: DEFAULT_FRESHNESS_SECONDS,
    evaluatedAt: iso()
  };
}

// ============================================================
// COMPLETE MARKET STATE
// ============================================================

async function buildMarketState(
  symbol,
  options = {}
) {
  const normalized =
    normalizeSymbol(symbol);

  const interval =
    safeInterval(
      options.interval ??
      "5m"
    );

  const limit =
    Math.min(
      safeLimit(
        options.limit,
        DEFAULT_CANDLE_LIMIT,
        MAX_CANDLE_LIMIT
      ),
      MAX_CANDLE_LIMIT
    );

  const depthLimit =
    options.depthLimit ??
    DEFAULT_DEPTH_LIMIT;

  const tradeLimit =
    options.tradeLimit ??
    DEFAULT_TRADE_LIMIT;

  // ----------------------------------------------------------
  // Partial failure is intentional.
  // One unavailable public endpoint should not erase all
  // other market information. Missing data is reported to Jev.
  // ----------------------------------------------------------

  const [
    tickerResult,
    candlesResult,
    orderBookResult,
    bookTickerResult,
    tradesResult,
    premiumResult,
    openInterestResult,
    longShortResult,
    openInterestHistoryResult,
    takerVolumeResult
  ] = await Promise.all([
    tryRest(
      "ticker",
      () =>
        getTicker(normalized)
    ),

    tryRest(
      "candles",
      () =>
        getCandles(
          normalized,
          interval,
          limit
        )
    ),

    tryRest(
      "orderBook",
      () =>
        getOrderBook(
          normalized,
          depthLimit
        )
    ),

    tryRest(
      "bookTicker",
      () =>
        getBookTicker(normalized)
    ),

    tryRest(
      "trades",
      () =>
        getRecentTrades(
          normalized,
          tradeLimit
        )
    ),

    tryRest(
      "premium",
      () =>
        getPremiumIndex(normalized)
    ),

    tryRest(
      "openInterest",
      () =>
        getOpenInterest(normalized)
    ),

    tryRest(
      "longShort",
      () =>
        getLongShortRatio(
          normalized,
          options.ratioPeriod ??
            "5m",
          options.ratioLimit ??
            30
        )
    ),

    tryRest(
      "openInterestHistory",
      () =>
        getOpenInterestHistory(
          normalized,
          options.openInterestPeriod ??
            "5m",
          options.openInterestLimit ??
            30
        )
    ),

    tryRest(
      "takerVolume",
      () =>
        getTakerVolume(
          normalized,
          options.takerPeriod ??
            "5m",
          options.takerLimit ??
            30
        )
    )
  ]);

  const ticker =
    tickerResult.data;

  const candles =
    candlesResult.data ??
    [];

  const orderBook =
    orderBookResult.data;

  const bookTicker =
    bookTickerResult.data;

  const trades =
    tradesResult.data ??
    [];

  const premium =
    premiumResult.data;

  const openInterest =
    openInterestResult.data;

  const longShort =
    longShortResult.data ??
    [];

  const openInterestHistory =
    openInterestHistoryResult.data ??
    [];

  const takerVolume =
    takerVolumeResult.data ??
    [];

  const orderBookMetrics =
    calculateOrderBookMetrics(
      orderBook
    );

  const tradeFlow =
    calculateTradeFlow(
      trades
    );

  const volatility =
    calculateVolatility(
      candles
    );

  const range =
    calculateRangeMetrics(
      candles
    );

  const regime =
    calculateMarketRegime(
      candles
    );

  const marketState = {
    symbol:
      normalized,

    timestamp:
      iso(),

    timestampMs:
      now(),

    interval,

    ticker,

    candles,

    orderBook:
      orderBook
        ? {
            ...orderBook,

            metrics:
              orderBookMetrics
          }
        : {
            symbol:
              normalized,

            bids: [],

            asks: [],

            metrics:
              orderBookMetrics
          },

    bookTicker,

    trades,

    tradeFlow,

    futures: {
      premium,

      openInterest,

      longShort,

      openInterestHistory,

      takerVolume
    },

    volatility,

    range,

    regime
  };

  const sourceResults = {
    ticker:
      tickerResult,

    candles:
      candlesResult,

    orderBook:
      orderBookResult,

    bookTicker:
      bookTickerResult,

    trades:
      tradesResult,

    premium:
      premiumResult,

    openInterest:
      openInterestResult,

    longShort:
      longShortResult,

    openInterestHistory:
      openInterestHistoryResult,

    takerVolume:
      takerVolumeResult
  };

  const quality =
    assessMarketDataQuality(
      marketState,
      sourceResults
    );

  const abnormal =
    detectAbnormalMarket(
      marketState
    );

  marketState.dataQuality =
    quality;

  marketState.abnormalMarket =
    abnormal;

  marketState.sources =
    Object.fromEntries(
      Object.entries(
        sourceResults
      ).map(
        ([name, result]) => [
          name,
          {
            available:
              result.ok,

            error:
              result.ok
                ? null
                : result.error
          }
        ]
      )
    );

  memory.set(
    normalized,
    marketState
  );

  return marketState;
}


export async function getMarketState(
  symbol,
  options = {}
) {
  const normalized = normalizeSymbol(symbol);

  const interval = safeInterval(options.interval ?? "5m");
  const limit = safeLimit(
    options.limit,
    DEFAULT_CANDLE_LIMIT,
    MAX_CANDLE_LIMIT
  );
  const key = JSON.stringify({
    symbol: normalized,
    interval,
    limit,
    depthLimit: options.depthLimit ?? DEFAULT_DEPTH_LIMIT,
    tradeLimit: options.tradeLimit ?? DEFAULT_TRADE_LIMIT,
    ratioPeriod: safePeriod(options.ratioPeriod ?? "5m"),
    ratioLimit: safeLimit(options.ratioLimit, 30, 500),
    openInterestPeriod: safePeriod(options.openInterestPeriod ?? "5m"),
    openInterestLimit: safeLimit(options.openInterestLimit, 30, 500),
    takerPeriod: safePeriod(options.takerPeriod ?? "5m"),
    takerLimit: safeLimit(options.takerLimit, 30, 500)
  });

  const existing = inFlightMarketStates.get(key);
  if (existing) {
    return existing;
  }

  const promise = buildMarketState(normalized, options)
    .finally(() => {
      if (inFlightMarketStates.get(key) === promise) {
        inFlightMarketStates.delete(key);
      }
    });

  inFlightMarketStates.set(key, promise);
  return promise;
}


// ============================================================
// CACHED STATE
// ============================================================

export function getCachedMarketState(
  symbol
) {
  const normalized =
    normalizeSymbol(symbol);

  return (
    memory.get(
      normalized
    ) ??
    null
  );
}


export function clearCachedMarketState(
  symbol
) {
  if (
    symbol === undefined
  ) {
    memory.clear();
    return true;
  }

  return memory.delete(
    normalizeSymbol(symbol)
  );
}


// ============================================================
// WEBSOCKET
// ============================================================

function buildStreams(
  symbols
) {
  const normalizedSymbols = [
    ...new Set(symbols.map(normalizeSymbol))
  ];

  if (normalizedSymbols.length > MAX_WS_SYMBOLS) {
    throw new Error(
      `Too many WebSocket symbols. Maximum is ${MAX_WS_SYMBOLS}.`
    );
  }

  const streams = [];

  for (const symbol of normalizedSymbols) {
    const s = streamSymbol(symbol);

    streams.push(`${s}@aggTrade`);
    streams.push(`${s}@depth20@100ms`);
    streams.push(`${s}@markPrice@1s`);
    streams.push(`${s}@bookTicker`);
    streams.push(`${s}@kline_1m`);
  }

  if (streams.length > MAX_WS_STREAMS) {
    throw new Error(
      `Too many WebSocket streams. Maximum is ${MAX_WS_STREAMS}.`
    );
  }

  return streams;
}

async function getWebSocketClass() {
  if (
    typeof WebSocket !==
    "undefined"
  ) {
    return WebSocket;
  }

  try {
    const module =
      await import("ws");

    return (
      module.WebSocket ??
      module.default
    );
  } catch {
    throw new Error(
      "WebSocket support is unavailable. Install the 'ws' package."
    );
  }
}


function attachSocketHandler(
  socket,
  event,
  handler
) {
  // WHATWG WebSocket
  if (
    typeof socket.addEventListener ===
    "function"
  ) {
    socket.addEventListener(
      event,
      handler
    );

    return;
  }

  // ws package EventEmitter API
  if (
    typeof socket.on ===
    "function"
  ) {
    socket.on(
      event,
      handler
    );
  }
}


export async function connectMarketStream(
  symbols
) {
  if (
    !Array.isArray(symbols) ||
    symbols.length === 0
  ) {
    throw new Error(
      "At least one symbol is required."
    );
  }

  const normalizedSymbols =
    [
      ...new Set(
        symbols.map(
          normalizeSymbol
        )
      )
    ];

  const WebSocketClass =
    await getWebSocketClass();

  const streams =
    buildStreams(
      normalizedSymbols
    );

  websocketState.manualDisconnect =
    false;

  const generation =
    websocketState.socketGeneration + 1;

  websocketState.socketGeneration =
    generation;

  websocketState.streams =
    new Set(streams);

  websocketState.symbols =
    normalizedSymbols;

  if (
    websocketState.reconnectTimer
  ) {
    clearTimeout(
      websocketState.reconnectTimer
    );

    websocketState.reconnectTimer =
      null;
  }

  if (
    websocketState.socket
  ) {
    try {
      websocketState.socket.close();
    } catch {
      // Ignore close errors.
    }
  }

  const separator =
    WS_BASE_URL.includes("?")
      ? "&"
      : "?";

  const url =
    `${WS_BASE_URL}${separator}streams=${streams.join("/")}`;

  websocketState.connecting =
    true;

  const socket =
    new WebSocketClass(
      url
    );

  websocketState.socket =
    socket;

  attachSocketHandler(
    socket,
    "open",
    () => {
      if (generation !== websocketState.socketGeneration) return;

      websocketState.connected =
        true;

      websocketState.connecting =
        false;

      websocketState.reconnectAttempts =
        0;

      websocketState.lastError =
        null;

      websocketState.lastConnectedAt =
        now();

      websocketState.lastHeartbeatAt =
        now();

      websocketState.lastMessageAt =
        now();
    }
  );

  attachSocketHandler(
    socket,
    "message",
    event => {
      if (generation !== websocketState.socketGeneration) return;

      websocketState.lastMessageAt =
        now();

      websocketState.lastHeartbeatAt =
        now();

      const data =
        event?.data ??
        event;

      handleWebSocketMessage(
        data
      );
    }
  );

  attachSocketHandler(
    socket,
    "error",
    error => {
      if (generation !== websocketState.socketGeneration) return;

      websocketState.lastError =
        error?.message ||
        "WebSocket error";
    }
  );

  attachSocketHandler(
    socket,
    "close",
    () => {
      if (generation !== websocketState.socketGeneration) return;

      websocketState.connected =
        false;

      websocketState.connecting =
        false;

      if (
        !websocketState.manualDisconnect
      ) {
        scheduleReconnect(
          normalizedSymbols
        );
      }
    }
  );

  return {
    connected:
      websocketState.connected,

    connecting:
      websocketState.connecting,

    streams:
      [...websocketState.streams],

    symbols:
      [...websocketState.symbols]
  };
}


function handleWebSocketMessage(
  raw
) {
  try {
    let parsed;

    if (
      typeof raw === "string"
    ) {
      parsed =
        JSON.parse(raw);
    } else if (
      raw instanceof ArrayBuffer
    ) {
      parsed =
        JSON.parse(
          new TextDecoder()
            .decode(raw)
        );
    } else if (
      typeof Buffer !== "undefined" &&
      Buffer.isBuffer(raw)
    ) {
      parsed =
        JSON.parse(
          raw.toString("utf8")
        );
    } else if (
      raw?.data
    ) {
      parsed =
        JSON.parse(
          String(raw.data)
        );
    } else {
      return;
    }

    const payload =
      parsed?.data ??
      parsed;

    if (
      !payload ||
      typeof payload !==
        "object"
    ) {
      return;
    }

    const eventType =
      payload.e;

    const symbol =
      payload.s ??
      payload.ps;

    if (
      typeof symbol !==
      "string"
    ) {
      return;
    }

    const normalized =
      normalizeSymbol(
        symbol
      );

    const existing =
      memory.get(
        normalized
      ) ?? {
        symbol:
          normalized,

        timestamp:
          iso(),

        timestampMs:
          now()
      };

    existing.realtime =
      existing.realtime ??
      {};

    existing.realtime.lastEventAt =
      now();

    existing.realtime.lastEventAtISO =
      iso();

    existing.realtime.lastEventType =
      eventType;

    if (
      eventType ===
      "aggTrade"
    ) {
      existing.realtime.trade = {
        price:
          positiveNumberOrNull(
            payload.p
          ),

        quantity:
          positiveNumberOrNull(
            payload.q
          ),

        timestamp:
          numberOrNull(
            payload.T
          ),

        timestampISO:
          iso(payload.T),

        buyerMaker:
          Boolean(
            payload.m
          )
      };
    }

    if (
      eventType ===
      "depthUpdate"
    ) {
      existing.realtime.depth = {
        firstUpdateId:
          numberOrNull(
            payload.U
          ),

        finalUpdateId:
          numberOrNull(
            payload.u
          ),

        bids:
          Array.isArray(payload.b)
            ? payload.b
                .map(
                  row => [
                    positiveNumberOrNull(row[0]),
                    positiveNumberOrNull(row[1])
                  ]
                )
            : [],

        asks:
          Array.isArray(payload.a)
            ? payload.a
                .map(
                  row => [
                    positiveNumberOrNull(row[0]),
                    positiveNumberOrNull(row[1])
                  ]
                )
            : []
      };
    }

    if (
      eventType ===
      "markPriceUpdate"
    ) {
      existing.realtime.markPrice =
        {
          markPrice:
            positiveNumberOrNull(
              payload.p
            ),

          indexPrice:
            positiveNumberOrNull(
              payload.i
            ),

          fundingRate:
            numberOrNull(
              payload.r
            ),

          nextFundingTime:
            numberOrNull(
              payload.T
            ),

          eventTime:
            numberOrNull(
              payload.E
            )
        };
    }

    if (
      eventType ===
      "bookTicker"
    ) {
      existing.realtime.bookTicker =
        {
          bidPrice:
            positiveNumberOrNull(
              payload.b
            ),

          bidQuantity:
            positiveNumberOrNull(
              payload.B
            ),

          askPrice:
            positiveNumberOrNull(
              payload.a
            ),

          askQuantity:
            positiveNumberOrNull(
              payload.A
            ),

          eventTime:
            numberOrNull(
              payload.E
            )
        };
    }

    if (
      eventType ===
      "kline"
    ) {
      const kline =
        payload.k;

      if (
        kline
      ) {
        existing.realtime.kline =
          {
            interval:
              kline.i,

            open:
              positiveNumberOrNull(
                kline.o
              ),

            high:
              positiveNumberOrNull(
                kline.h
              ),

            low:
              positiveNumberOrNull(
                kline.l
              ),

            close:
              positiveNumberOrNull(
                kline.c
              ),

            volume:
              positiveNumberOrNull(
                kline.v
              ),

            closed:
              Boolean(
                kline.x
              ),

            startTime:
              numberOrNull(
                kline.t
              ),

            endTime:
              numberOrNull(
                kline.T
              ),

            timestamp:
              numberOrNull(
                kline.T
              )
          };
      }
    }

    existing.timestamp =
      iso();

    existing.timestampMs =
      now();

    memory.set(
      normalized,
      existing
    );
  } catch {
    // Invalid WebSocket messages are ignored.
  }
}


function scheduleReconnect(
  symbols
) {
  if (
    websocketState.manualDisconnect ||
    websocketState.reconnectTimer ||
    !Array.isArray(symbols) ||
    symbols.length === 0
  ) {
    return;
  }

  const attempt =
    websocketState.reconnectAttempts;

  const delay =
    Math.min(
      30_000,
      1_000 *
        Math.pow(
          2,
          Math.min(
            attempt,
            5
          )
        )
    );

  websocketState.reconnectAttempts =
    Math.min(
      attempt + 1,
      10
    );

  websocketState.reconnectTimer =
    setTimeout(
      async () => {
        websocketState.reconnectTimer =
          null;

        try {
          await connectMarketStream(
            symbols
          );
        } catch (error) {
          websocketState.lastError =
            error?.message ||
            "WebSocket reconnect failed";

          scheduleReconnect(
            symbols
          );
        }
      },
      delay
    );
}


// ============================================================
// WEBSOCKET CONTROL
// ============================================================

export function disconnectMarketStream() {
  websocketState.socketGeneration += 1;

  websocketState.manualDisconnect =
    true;

  if (
    websocketState.reconnectTimer
  ) {
    clearTimeout(
      websocketState.reconnectTimer
    );

    websocketState.reconnectTimer =
      null;
  }

  if (
    websocketState.socket
  ) {
    try {
      websocketState.socket.close();
    } catch {
      // Ignore close errors.
    }
  }

  websocketState.socket =
    null;

  websocketState.connected =
    false;

  websocketState.connecting =
    false;

  return true;
}


// ============================================================
// WEBSOCKET STATUS
// ============================================================

export function getMarketStreamStatus() {
  const age =
    websocketState.lastMessageAt > 0
      ? (
          now() -
          websocketState.lastMessageAt
        ) / 1000
      : null;

  return {
    connected:
      websocketState.connected,

    connecting:
      websocketState.connecting,

    reconnectAttempts:
      websocketState.reconnectAttempts,

    streams:
      [...websocketState.streams],

    symbols:
      [...websocketState.symbols],

    lastConnectedAt:
      websocketState.lastConnectedAt
        ? iso(
            websocketState.lastConnectedAt
          )
        : null,

    lastMessageAt:
      websocketState.lastMessageAt
        ? iso(
            websocketState.lastMessageAt
          )
        : null,

    messageAgeSeconds:
      age,

    stale:
      age !== null
        ? age >
          DEFAULT_FRESHNESS_SECONDS
        : true,

    lastError:
      websocketState.lastError
  };
}


// ============================================================
// MODULE STATUS
// ============================================================

export function getMarketDataStatus() {
  return {
    module:
      MODULE_NAME,

    version:
      MODULE_VERSION,

    provider:
      "Binance USD-M Futures public market data",

    rest:
      true,

    websocket:
      true,

    price:
      true,

    candles:
      true,

    orderBook:
      true,

    tradeFlow:
      true,

    funding:
      true,

    markPrice:
      true,

    indexPrice:
      true,

    openInterest:
      true,

    openInterestHistory:
      true,

    longShortRatio:
      true,

    takerVolume:
      true,

    volatility:
      true,

    rangeMetrics:
      true,

    marketRegime:
      true,

    abnormalMarketDetection:
      true,

    freshnessTracking:
      true,

    partialFailureProtection:
      true,

    privateKeys:
      false,

    walletAccess:
      false,

    trading:
      false,

    withdrawals:
      false,

    retryPolicy:
      {
        maxRetries:
          MAX_HTTP_RETRIES,

        baseDelayMs:
          RETRY_BASE_DELAY_MS
      },

    websocketLimits:
      {
        maxSymbols:
          MAX_WS_SYMBOLS,

        maxStreams:
          MAX_WS_STREAMS
      },

    status:
      "Advanced market-data engine ready."
  };
}


// ============================================================
// ENGINE HEALTH
// ============================================================

export function getMarketDataHealth() {
  const streamAge =
    ageSeconds(websocketState.lastMessageAt);

  const cachedSymbols =
    [...memory.keys()];

  return {
    module: MODULE_NAME,
    version: MODULE_VERSION,
    timestamp: iso(),
    cache: {
      symbols: cachedSymbols,
      size: cachedSymbols.length
    },
    websocket: {
      connected: websocketState.connected,
      connecting: websocketState.connecting,
      stale:
        streamAge !== null &&
        streamAge > DEFAULT_FRESHNESS_SECONDS,
      messageAgeSeconds: streamAge,
      lastError: websocketState.lastError
    },
    inFlightMarketStates:
      inFlightMarketStates.size,
    security: {
      trading: false,
      walletAccess: false,
      privateKeys: false,
      withdrawals: false
    }
  };
}


// ============================================================
// DEFAULT EXPORT
// ============================================================

export default {
  getTicker,
  getCandles,
  getOrderBook,
  calculateOrderBookMetrics,
  getBookTicker,
  getRecentTrades,
  calculateTradeFlow,
  getPremiumIndex,
  getOpenInterest,
  getLongShortRatio,
  getOpenInterestHistory,
  getTakerVolume,
  calculateVolatility,
  calculateRangeMetrics,
  calculateMarketRegime,
  detectAbnormalMarket,
  getMarketState,
  getCachedMarketState,
  clearCachedMarketState,
  connectMarketStream,
  disconnectMarketStream,
  getMarketStreamStatus,
  getMarketDataStatus,
  getMarketDataHealth
};
