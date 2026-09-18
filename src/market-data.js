// Jev Trader
// Market Data Engine V2.0.0
//
// PURPOSE:
// - Real-time crypto market data
// - REST + WebSocket architecture
// - Price / candles
// - Order-book depth
// - Bid/ask spread
// - Order-book imbalance
// - Trade flow
// - Volume
// - Volatility
// - Funding
// - Mark price
// - Index price
// - Open interest
// - Long/short positioning
// - Taker buy/sell flow
// - Market regime
// - Data freshness
// - Abnormal-market detection
//
// IMPORTANT:
// This module ONLY supplies market data.
//
// It does NOT:
// - place trades
// - access wallets
// - access private keys
// - withdraw funds
// - decide trades
//
// Jev decides.
// Trader Engine applies risk.
// Execution Adapter eventually sends orders.
//
// MARKET:
// Binance USD-M Futures public market data.
//
// V2 is intentionally designed for LONG/SHORT trading.

const MODULE_NAME = "Jev Market Data";
const MODULE_VERSION = "2.0.0";

const REST_BASE_URL =
  process.env.MARKET_DATA_BASE_URL ||
  "https://fapi.binance.com";

const WS_BASE_URL =
  process.env.MARKET_DATA_WS_URL ||
  "wss://fstream.binance.com/stream";

const REQUEST_TIMEOUT_MS = 10_000;

const DEFAULT_CANDLE_LIMIT = 200;
const DEFAULT_DEPTH_LIMIT = 20;
const MAX_CANDLE_LIMIT = 1000;

const VALID_INTERVALS = new Set([
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

const memory = new Map();

const websocketState = {
  socket: null,
  connected: false,
  connecting: false,
  reconnectTimer: null,
  reconnectAttempts: 0,
  streams: new Set(),
  lastMessageAt: 0,
  lastError: null
};

/* =========================================================
   BASIC HELPERS
   ========================================================= */

function numberOrNull(value) {
  const number = Number(value);

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
  return new Date(
    timestamp
  ).toISOString();
}

/* =========================================================
   HTTP
   ========================================================= */

async function fetchJson(
  url,
  timeoutMs = REQUEST_TIMEOUT_MS
) {
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
            accept:
              "application/json"
          },
          signal:
            controller.signal
        }
      );

    if (
      !response.ok
    ) {
      throw new Error(
        `Market data request failed with HTTP ${response.status}.`
      );
    }

    return await response.json();
  } catch (error) {
    if (
      error?.name ===
      "AbortError"
    ) {
      throw new Error(
        "Market data request timed out."
      );
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function rest(
  path,
  params = {}
) {
  const url =
    new URL(
      `${REST_BASE_URL}${path}`
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

  return fetchJson(
    url.toString()
  );
}

/* =========================================================
   24H TICKER
   ========================================================= */

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

    source:
      "binance-usdm-futures"
  };
}

/* =========================================================
   CANDLES
   ========================================================= */

export async function getCandles(
  symbol,
  interval = "1m",
  limit = DEFAULT_CANDLE_LIMIT
) {
  const normalized =
    normalizeSymbol(symbol);

  if (
    !VALID_INTERVALS.has(
      interval
    )
  ) {
    throw new Error(
      `Unsupported candle interval: ${interval}`
    );
  }

  const safeLimit =
    Math.min(
      Math.max(
        Number(limit) || DEFAULT_CANDLE_LIMIT,
        1
      ),
      MAX_CANDLE_LIMIT
    );

  const data =
    await rest(
      "/fapi/v1/klines",
      {
        symbol:
          normalized,

        interval,

        limit:
          safeLimit
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
        Number(candle[0]),

      openTimeISO:
        iso(
          Number(candle[0])
        ),

      open:
        positiveNumberOrNull(
          candle[1]
        ),

      high:
        positiveNumberOrNull(
          candle[2]
        ),

      low:
        positiveNumberOrNull(
          candle[3]
        ),

      close:
        positiveNumberOrNull(
          candle[4]
        ),

      volume:
        positiveNumberOrNull(
          candle[5]
        ),

      closeTime:
        Number(candle[6]),

      closeTimeISO:
        iso(
          Number(candle[6])
        ),

      quoteVolume:
        positiveNumberOrNull(
          candle[7]
        ),

      trades:
        numberOrNull(
          candle[8]
        ),

      takerBuyBaseVolume:
        positiveNumberOrNull(
          candle[9]
        ),

      takerBuyQuoteVolume:
        positiveNumberOrNull(
          candle[10]
        )
    })
  );
}

/* =========================================================
   ORDER BOOK
   ========================================================= */

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

  const safeLimit =
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
          safeLimit
      }
    );

  const bids =
    Array.isArray(data.bids)
      ? data.bids.map(
          row => ({
            price:
              positiveNumberOrNull(
                row[0]
              ),

            quantity:
              positiveNumberOrNull(
                row[1]
              )
          })
        )
      : [];

  const asks =
    Array.isArray(data.asks)
      ? data.asks.map(
          row => ({
            price:
              positiveNumberOrNull(
                row[0]
              ),

            quantity:
              positiveNumberOrNull(
                row[1]
              )
          })
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
      iso()
  };
}

/* =========================================================
   BOOK METRICS
   ========================================================= */

export function calculateOrderBookMetrics(
  orderBook
) {
  const bids =
    Array.isArray(
      orderBook?.bids
    )
      ? orderBook.bids
      : [];

  const asks =
    Array.isArray(
      orderBook?.asks
    )
      ? orderBook.asks
      : [];

  const bestBid =
    bids[0]?.price ??
    null;

  const bestAsk =
    asks[0]?.price ??
    null;

  const bidQuantity =
    bids.reduce(
      (total, level) =>
        total +
        (level.quantity ?? 0),
      0
    );

  const askQuantity =
    asks.reduce(
      (total, level) =>
        total +
        (level.quantity ?? 0),
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
      ? bestAsk - bestBid
      : null;

  const spreadBps =
    midPrice &&
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
    imbalance
  };
}

/* =========================================================
   BOOK TICKER
   ========================================================= */

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
      iso()
  };
}

/* =========================================================
   TRADES
   ========================================================= */

export async function getRecentTrades(
  symbol,
  limit = 100
) {
  const normalized =
    normalizeSymbol(symbol);

  const safeLimit =
    Math.min(
      Math.max(
        Number(limit) || 100,
        1
      ),
      1000
    );

  const data =
    await rest(
      "/fapi/v1/trades",
      {
        symbol:
          normalized,

        limit:
          safeLimit
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
        trade.id,

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
        Number(trade.time),

      timestampISO:
        iso(
          Number(trade.time)
        ),

      buyerMaker:
        Boolean(
          trade.isBuyerMaker
        )
    })
  );
}

/* =========================================================
   TRADE FLOW
   ========================================================= */

export function calculateTradeFlow(
  trades
) {
  if (
    !Array.isArray(trades) ||
    trades.length === 0
  ) {
    return {
      sufficientData: false
    };
  }

  let buyVolume = 0;
  let sellVolume = 0;

  for (
    const trade of trades
  ) {
    const quantity =
      trade.quantity ?? 0;

    if (
      trade.buyerMaker
    ) {
      sellVolume += quantity;
    } else {
      buyVolume += quantity;
    }
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
    sufficientData: true,

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

/* =========================================================
   FUTURES PREMIUM / FUNDING
   ========================================================= */

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

    timestamp:
      numberOrNull(
        data.time
      )
  };
}

/* =========================================================
   OPEN INTEREST
   ========================================================= */

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
      )
  };
}

/* =========================================================
   LONG / SHORT RATIO
   ========================================================= */

export async function getLongShortRatio(
  symbol,
  period = "5m",
  limit = 30
) {
  const normalized =
    normalizeSymbol(symbol);

  const pair =
    normalized.endsWith(
      "USDT"
    )
      ? normalized.slice(
          0,
          -4
        )
      : normalized;

  const safeLimit =
    Math.min(
      Math.max(
        Number(limit) || 30,
        1
      ),
      500
    );

  const data =
    await rest(
      "/futures/data/globalLongShortAccountRatio",
      {
        pair,

        period,

        limit:
          safeLimit
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
        row.timestamp
          ? iso(
              Number(
                row.timestamp
              )
            )
          : null
    })
  );
}

/* =========================================================
   OPEN INTEREST HISTORY
   ========================================================= */

export async function getOpenInterestHistory(
  symbol,
  period = "5m",
  limit = 30
) {
  const normalized =
    normalizeSymbol(symbol);

  const pair =
    normalized.endsWith(
      "USDT"
    )
      ? normalized.slice(
          0,
          -4
        )
      : normalized;

  const safeLimit =
    Math.min(
      Math.max(
        Number(limit) || 30,
        1
      ),
      500
    );

  const data =
    await rest(
      "/futures/data/openInterestHist",
      {
        pair,

        contractType:
          "PERPETUAL",

        period,

        limit:
          safeLimit
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
        row.timestamp
          ? iso(
              Number(
                row.timestamp
              )
            )
          : null
    })
  );
}

/* =========================================================
   TAKER BUY / SELL VOLUME
   ========================================================= */

export async function getTakerVolume(
  symbol,
  period = "5m",
  limit = 30
) {
  const normalized =
    normalizeSymbol(symbol);

  const pair =
    normalized.endsWith(
      "USDT"
    )
      ? normalized.slice(
          0,
          -4
        )
      : normalized;

  const safeLimit =
    Math.min(
      Math.max(
        Number(limit) || 30,
        1
      ),
      500
    );

  const data =
    await rest(
      "/futures/data/takerlongshortRatio",
      {
        symbol:
          normalized,

        period,

        limit:
          safeLimit
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
        row.timestamp
          ? iso(
              Number(
                row.timestamp
              )
            )
          : null
    })
  );
}

/* =========================================================
   VOLATILITY
   ========================================================= */

export function calculateVolatility(
  candles
) {
  if (
    !Array.isArray(candles) ||
    candles.length < 3
  ) {
    return {
      sufficientData: false
    };
  }

  const closes =
    candles
      .map(
        candle =>
          numberOrNull(
            candle.close
          )
      )
      .filter(
        value =>
          value !== null &&
          value > 0
      );

  if (
    closes.length < 3
  ) {
    return {
      sufficientData: false
    };
  }

  const returns = [];

  for (
    let i = 1;
    i < closes.length;
    i++
  ) {
    returns.push(
      (
        closes[i] -
        closes[i - 1]
      ) /
      closes[i - 1]
    );
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
      variance
    );

  return {
    sufficientData: true,

    meanReturn:
      mean,

    standardDeviation,

    percentageVolatility:
      standardDeviation *
      100
  };
}

/* =========================================================
   TREND / MARKET REGIME
   ========================================================= */

export function calculateMarketRegime(
  candles
) {
  if (
    !Array.isArray(candles) ||
    candles.length < 20
  ) {
    return {
      sufficientData: false,
      regime: "UNKNOWN"
    };
  }

  const closes =
    candles
      .map(
        candle =>
          numberOrNull(
            candle.close
          )
      )
      .filter(
        value =>
          value !== null
      );

  if (
    closes.length < 20
  ) {
    return {
      sufficientData: false,
      regime: "UNKNOWN"
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

  let regime =
    "RANGE";

  if (
    shortAverage >
      longAverage &&
    change > 0
  ) {
    regime = "BULLISH";
  }

  if (
    shortAverage <
      longAverage &&
    change < 0
  ) {
    regime = "BEARISH";
  }

  return {
    sufficientData: true,

    regime,

    shortAverage,

    longAverage,

    percentageChange:
      change
  };
}

/* =========================================================
   ABNORMAL MARKET DETECTION
   ========================================================= */

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
      "High short-term volatility."
    );
  }

  return {
    abnormal:
      warnings.length > 0,

    warnings
  };
}

/* =========================================================
   COMPLETE MARKET STATE
   ========================================================= */

export async function getMarketState(
  symbol,
  options = {}
) {
  const normalized =
    normalizeSymbol(symbol);

  const interval =
    options.interval ??
    "5m";

  const limit =
    options.limit ??
    DEFAULT_CANDLE_LIMIT;

  const [
    ticker,
    candles,
    orderBook,
    bookTicker,
    trades,
    premium,
    openInterest,
    longShort
  ] = await Promise.all([
    getTicker(
      normalized
    ),

    getCandles(
      normalized,
      interval,
      limit
    ),

    getOrderBook(
      normalized,
      DEFAULT_DEPTH_LIMIT
    ),

    getBookTicker(
      normalized
    ),

    getRecentTrades(
      normalized,
      100
    ),

    getPremiumIndex(
      normalized
    ),

    getOpenInterest(
      normalized
    ),

    getLongShortRatio(
      normalized,
      "5m",
      30
    )
  ]);

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

  const regime =
    calculateMarketRegime(
      candles
    );

  const marketState = {
    symbol:
      normalized,

    timestamp:
      iso(),

    ticker,

    candles,

    orderBook: {
      ...orderBook,

      metrics:
        orderBookMetrics
    },

    bookTicker,

    trades,

    tradeFlow,

    futures: {
      premium,

      openInterest,

      longShort
    },

    volatility,

    regime
  };

  const abnormal =
    detectAbnormalMarket(
      marketState
    );

  marketState.abnormalMarket =
    abnormal;

  memory.set(
    normalized,
    marketState
  );

  return marketState;
}

/* =========================================================
   CACHED STATE
   ========================================================= */

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

/* =========================================================
   WEBSOCKET
   ========================================================= */

function buildStreams(
  symbols
) {
  const streams = [];

  for (
    const symbol of symbols
  ) {
    const s =
      streamSymbol(symbol);

    streams.push(
      `${s}@aggTrade`
    );

    streams.push(
      `${s}@depth20@100ms`
    );

    streams.push(
      `${s}@markPrice@1s`
    );

    streams.push(
      `${s}@bookTicker`
    );

    streams.push(
      `${s}@kline_1m`
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

    return module.WebSocket;
  } catch {
    throw new Error(
      "WebSocket support is unavailable. Install the 'ws' package."
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

  const WebSocketClass =
    await getWebSocketClass();

  const streams =
    buildStreams(
      symbols
    );

  websocketState.streams =
    new Set(
      streams
    );

  if (
    websocketState.socket
  ) {
    try {
      websocketState.socket.close();
    } catch {
      // Ignore close errors.
    }
  }

  const url =
    `${WS_BASE_URL}?streams=${streams.join("/")}`;

  websocketState.connecting =
    true;

  const socket =
    new WebSocketClass(
      url
    );

  websocketState.socket =
    socket;

  socket.onopen =
    () => {
      websocketState.connected =
        true;

      websocketState.connecting =
        false;

      websocketState.reconnectAttempts =
        0;

      websocketState.lastError =
        null;

      websocketState.lastMessageAt =
        now();
    };

  socket.onmessage =
    event => {
      websocketState.lastMessageAt =
        now();

      handleWebSocketMessage(
        event.data
      );
    };

  socket.onerror =
    error => {
      websocketState.lastError =
        "WebSocket error";
    };

  socket.onclose =
    () => {
      websocketState.connected =
        false;

      websocketState.connecting =
        false;

      scheduleReconnect(
        symbols
      );
    };

  return {
    connected:
      websocketState.connected,

    streams:
      [...websocketState.streams]
  };
}

function handleWebSocketMessage(
  raw
) {
  try {
    const parsed =
      typeof raw === "string"
        ? JSON.parse(raw)
        : JSON.parse(
            Buffer.from(raw)
              .toString("utf8")
          );

    const payload =
      parsed?.data ??
      parsed;

    if (
      !payload
    ) {
      return;
    }

    const eventType =
      payload.e;

    const symbol =
      payload.s ??
      payload.ps;

    if (
      !symbol
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
          normalized
      };

    existing.realtime =
      existing.realtime ??
      {};

    existing.realtime.lastEventAt =
      now();

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
          payload.U,

        finalUpdateId:
          payload.u,

        bids:
          Array.isArray(
            payload.b
          )
            ? payload.b
            : [],

        asks:
          Array.isArray(
            payload.a
          )
            ? payload.a
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

            timestamp:
              numberOrNull(
                kline.T
              )
          };
      }
    }

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
    websocketState.reconnectTimer
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
          attempt
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
            error.message;

          scheduleReconnect(
            symbols
          );
        }
      },
      delay
    );
}

/* =========================================================
   WEBSOCKET STATUS
   ========================================================= */

export function getMarketStreamStatus() {
  const ageSeconds =
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

    streams:
      [...websocketState.streams],

    lastMessageAt:
      websocketState.lastMessageAt
        ? iso(
            websocketState.lastMessageAt
          )
        : null,

    messageAgeSeconds:
      ageSeconds,

    lastError:
      websocketState.lastError
  };
}

/* =========================================================
   MODULE STATUS
   ========================================================= */

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

    longShortRatio:
      true,

    volatility:
      true,

    marketRegime:
      true,

    abnormalMarketDetection:
      true,

    privateKeys:
      false,

    walletAccess:
      false,

    trading:
      false,

    withdrawals:
      false,

    status:
      "Advanced market-data engine ready."
  };
}
