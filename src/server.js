// ============================================================
// JEV CONNECTOR
// Server V3.0.0
//
// ROLE
// - AI Hub gateway for Jev
// - Market evaluation
// - Trade-intent evaluation
// - Shared memory
// - Health and diagnostics
//
// SAFETY
// - Paper trading by default
// - This server does NOT execute trades
// - No runTrader
// - No getTraderStatus
// - No getEngineStatus
// - API authentication for protected operations
// - Public diagnostics for easy monitoring
// - Secrets are never returned
// ============================================================

import express from "express";
import cors from "cors";
import crypto from "node:crypto";

import {
  evaluateMarketState,
} from "./jev-engine.js";

import {
  evaluateTrade,
} from "./trader-engine.js";

import {
  saveSharedMemory,
  searchSharedMemory,
  getRecentMemories,
  getSharedMemoryStats,
  buildJevMemoryContext,
  getJevMemorySnapshot,
  checkSharedMemoryConnection,
  getSharedMemoryStatus,
} from "./shared-memory.js";


// ============================================================
// CONFIGURATION
// ============================================================

const app = express();

const PORT =
  Number(process.env.PORT) || 3000;

const SERVICE =
  "Jev Connector";

const VERSION =
  "3.0.0";


// ============================================================
// SECURITY
// ============================================================

const JEV_API_KEY =
  process.env.JEV_API_KEY || "";


// ============================================================
// TRADING SAFETY
// ============================================================

const PAPER_TRADING =
  String(
    process.env.PAPER_TRADING ?? "true"
  ).toLowerCase() === "true";

const LIVE_TRADING =
  String(
    process.env.LIVE_TRADING ?? "false"
  ).toLowerCase() === "true";


// The connector itself never executes trades.
//
// This flag is informational only and does not
// activate an exchange executor.

const LIVE_MODE =
  LIVE_TRADING === true &&
  PAPER_TRADING === false;


// ============================================================
// EXPRESS CONFIGURATION
// ============================================================

app.disable("x-powered-by");

app.use(
  cors({
    origin: true,
    methods: [
      "GET",
      "POST",
      "OPTIONS",
    ],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-JEV-API-Key",
      "X-Request-ID",
    ],
  })
);

app.use(
  express.json({
    limit: "1mb",
    strict: true,
  })
);


// ============================================================
// REQUEST ID
// ============================================================

app.use((req, res, next) => {

  const incoming =
    req.headers["x-request-id"];

  const requestId =
    typeof incoming === "string" &&
    incoming.length <= 100
      ? incoming
      : crypto.randomUUID();

  req.requestId =
    requestId;

  res.setHeader(
    "X-Request-ID",
    requestId
  );

  next();

});


// ============================================================
// SIMPLE RATE LIMITER
// ============================================================

const RATE_WINDOW =
  60 * 1000;

const RATE_LIMIT =
  120;

const rateStore =
  new Map();


function getClientAddress(req) {

  const forwarded =
    req.headers["x-forwarded-for"];

  if (
    typeof forwarded === "string"
  ) {
    return forwarded
      .split(",")[0]
      .trim();
  }

  return (
    req.socket?.remoteAddress ||
    "unknown"
  );

}


function rateLimit(req, res, next) {

  const now =
    Date.now();

  const address =
    getClientAddress(req);

  let record =
    rateStore.get(address);

  if (
    !record ||
    now - record.startedAt >
      RATE_WINDOW
  ) {

    record = {
      startedAt: now,
      count: 0,
    };

    rateStore.set(
      address,
      record
    );

  }

  record.count++;

  if (
    record.count >
    RATE_LIMIT
  ) {

    return res.status(429).json({

      ok: false,

      error:
        "Rate limit exceeded",

      requestId:
        req.requestId,

    });

  }

  next();

}


app.use(rateLimit);


// Periodically clean old entries.

setInterval(() => {

  const now =
    Date.now();

  for (
    const [
      address,
      record
    ] of rateStore
  ) {

    if (
      now - record.startedAt >
      RATE_WINDOW
    ) {

      rateStore.delete(
        address
      );

    }

  }

}, RATE_WINDOW).unref();


// ============================================================
// AUTHENTICATION
// ============================================================

function secureCompare(
  first,
  second
) {

  if (
    typeof first !== "string" ||
    typeof second !== "string"
  ) {
    return false;
  }

  const a =
    Buffer.from(first);

  const b =
    Buffer.from(second);

  if (
    a.length !==
    b.length
  ) {
    return false;
  }

  return crypto.timingSafeEqual(
    a,
    b
  );

}


function authenticate(
  req,
  res,
  next
) {

  // Development/open mode if no key
  // is configured.

  if (!JEV_API_KEY) {
    return next();
  }

  const authorization =
    req.headers.authorization || "";

  let suppliedKey = "";

  if (
    authorization.startsWith(
      "Bearer "
    )
  ) {

    suppliedKey =
      authorization.slice(7);

  }

  if (!suppliedKey) {

    const headerKey =
      req.headers[
        "x-jev-api-key"
      ];

    if (
      typeof headerKey === "string"
    ) {
      suppliedKey =
        headerKey;
    }

  }

  if (
    !secureCompare(
      suppliedKey,
      JEV_API_KEY
    )
  ) {

    return res.status(401).json({

      ok: false,

      error:
        "Unauthorized",

      requestId:
        req.requestId,

    });

  }

  next();

}


// ============================================================
// HELPERS
// ============================================================

function executionInfo() {

  return {

    paper:
      PAPER_TRADING,

    live:
      LIVE_MODE,

    executor:
      false,

  };

}


function validObject(value) {

  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );

}


function cleanLimit(value) {

  let limit =
    Number(value);

  if (
    !Number.isFinite(limit)
  ) {
    limit = 20;
  }

  return Math.max(
    1,
    Math.min(
      100,
      Math.floor(limit)
    )
  );

}


// ============================================================
// ROOT
// ============================================================

app.get(
  "/",
  (req, res) => {

    res.status(200).json({

      ok: true,

      service:
        SERVICE,

      version:
        VERSION,

      status:
        "online",

      role:
        "evaluation-and-paper-trading",

      execution:
        executionInfo(),

      walletAccess:
        false,

      privateKeys:
        false,

      withdrawals:
        false,

      authentication: {

        configured:
          Boolean(JEV_API_KEY),

      },

      requestId:
        req.requestId,

    });

  }
);


// ============================================================
// HEALTH
// ============================================================

app.get(
  "/health",
  (req, res) => {

    res.status(200).json({

      ok: true,

      service:
        SERVICE,

      version:
        VERSION,

      status:
        "online",

      uptime:
        Math.floor(
          process.uptime()
        ),

      execution:
        executionInfo(),

      modules: {

        jevEngine:
          typeof evaluateMarketState ===
          "function",

        traderEngine:
          typeof evaluateTrade ===
          "function",

        sharedMemory:
          typeof getSharedMemoryStatus ===
          "function",

      },

      requestId:
        req.requestId,

    });

  }
);


// ============================================================
// PUBLIC CAPABILITIES
// ============================================================

app.get(
  "/api/capabilities",
  (req, res) => {

    res.status(200).json({

      ok: true,

      service:
        SERVICE,

      version:
        VERSION,

      capabilities: {

        marketEvaluation:
          true,

        tradeEvaluation:
          true,

        tradeExecution:
          false,

        sharedMemory:
          true,

        paperTrading:
          PAPER_TRADING,

        liveTrading:
          LIVE_MODE,

      },

      endpoints: {

        health:
          "GET /health",

        status:
          "GET /api/status",

        memoryStatus:
          "GET /api/memory/status",

        memoryConnection:
          "GET /api/memory/connection",

        marketEvaluation:
          "POST /api/evaluate-market",

        tradeEvaluation:
          "POST /api/evaluate-trade",

      },

      requestId:
        req.requestId,

    });

  }
);


// ============================================================
// PUBLIC STATUS
// ============================================================

app.get(
  "/api/status",
  async (req, res) => {

    let memory = {

      configured:
        false,

      connected:
        false,

    };

    try {

      memory =
        await getSharedMemoryStatus();

    } catch (error) {

      console.error(
        "[JEV] Status check:",
        error.message
      );

    }

    const degraded =
      memory?.configured === true &&
      memory?.connected !== true;

    res.status(200).json({

      ok:
        !degraded,

      service:
        SERVICE,

      version:
        VERSION,

      status:
        degraded
          ? "degraded"
          : "online",

      role:
        "evaluation-and-paper-trading",

      execution:
        executionInfo(),

      walletAccess:
        false,

      privateKeys:
        false,

      withdrawals:
        false,

      authentication: {

        configured:
          Boolean(JEV_API_KEY),

      },

      modules: {

        jevEngine:
          true,

        traderEngine:
          true,

        sharedMemory:
          true,

      },

      sharedMemory:
        memory,

      requestId:
        req.requestId,

    });

  }
);


// ============================================================
// PUBLIC MEMORY STATUS
// ============================================================

app.get(
  "/api/memory/status",
  async (req, res) => {

    try {

      const result =
        await getSharedMemoryStatus();

      res.status(200).json({

        ok: true,

        service:
          SERVICE,

        sharedMemory:
          result,

        requestId:
          req.requestId,

      });

    } catch (error) {

      console.error(
        "[JEV] Memory status:",
        error.message
      );

      res.status(200).json({

        ok: false,

        service:
          SERVICE,

        sharedMemory: {

          configured:
            false,

          connected:
            false,

          error:
            "Unable to check shared memory",

        },

        requestId:
          req.requestId,

      });

    }

  }
);


// ============================================================
// PUBLIC MEMORY CONNECTION TEST
// ============================================================

app.get(
  "/api/memory/connection",
  async (req, res) => {

    try {

      const result =
        await checkSharedMemoryConnection();

      res.status(200).json({

        ok: true,

        service:
          SERVICE,

        connection:
          result,

        requestId:
          req.requestId,

      });

    } catch (error) {

      console.error(
        "[JEV] Memory connection:",
        error.message
      );

      res.status(200).json({

        ok: false,

        service:
          SERVICE,

        connection: {

          connected:
            false,

          error:
            "Connection check failed",

        },

        requestId:
          req.requestId,

      });

    }

  }
);


// ============================================================
// MARKET EVALUATION
// ============================================================
//
// Protected endpoint.
//
// This evaluates market state.
// It does NOT place an order.
//

app.post(
  "/api/evaluate-market",
  authenticate,
  async (req, res) => {

    try {

      const marketData =
        req.body?.marketData ??
        req.body;

      if (
        !validObject(
          marketData
        )
      ) {

        return res.status(400).json({

          ok: false,

          error:
            "Invalid market data",

          requestId:
            req.requestId,

        });

      }

      const result =
        await evaluateMarketState(
          marketData
        );

      return res.status(200).json({

        ok: true,

        service:
          SERVICE,

        operation:
          "market-evaluation",

        result,

        requestId:
          req.requestId,

      });

    } catch (error) {

      console.error(
        "[JEV] Market evaluation:",
        error.message
      );

      return res.status(500).json({

        ok: false,

        error:
          "Market evaluation failed",

        requestId:
          req.requestId,

      });

    }

  }
);


// ============================================================
// TRADE EVALUATION
// ============================================================
//
// Protected endpoint.
//
// IMPORTANT:
// evaluateTrade creates/evaluates a trade intent.
// This connector does NOT execute that intent.
//

app.post(
  "/api/evaluate-trade",
  authenticate,
  async (req, res) => {

    try {

      const state =
        req.body?.state ??
        req.body;

      const options =
        req.body?.options ??
        {};

      if (
        !validObject(state)
      ) {

        return res.status(400).json({

          ok: false,

          error:
            "Invalid trader state",

          requestId:
            req.requestId,

        });

      }

      if (
        !validObject(options)
      ) {

        return res.status(400).json({

          ok: false,

          error:
            "Invalid evaluation options",

          requestId:
            req.requestId,

        });

      }

      const result =
        await evaluateTrade(
          state,
          options
        );

      return res.status(200).json({

        ok: true,

        service:
          SERVICE,

        operation:
          "trade-evaluation",

        execution:
          executionInfo(),

        executed:
          false,

        result,

        requestId:
          req.requestId,

      });

    } catch (error) {

      console.error(
        "[JEV] Trade evaluation:",
        error.message
      );

      return res.status(500).json({

        ok: false,

        error:
          "Trade evaluation failed",

        executed:
          false,

        requestId:
          req.requestId,

      });

    }

  }
);


// ============================================================
// MEMORY STATS
// ============================================================

app.get(
  "/api/memory/stats",
  authenticate,
  async (req, res) => {

    try {

      const result =
        await getSharedMemoryStats();

      res.status(200).json({

        ok: true,

        stats:
          result,

        requestId:
          req.requestId,

      });

    } catch (error) {

      console.error(
        "[JEV] Memory stats:",
        error.message
      );

      res.status(500).json({

        ok: false,

        error:
          "Memory statistics failed",

        requestId:
          req.requestId,

      });

    }

  }
);


// ============================================================
// RECENT MEMORIES
// ============================================================

app.get(
  "/api/memory/recent",
  authenticate,
  async (req, res) => {

    try {

      const limit =
        cleanLimit(
          req.query.limit
        );

      const result =
        await getRecentMemories(
          limit
        );

      res.status(200).json({

        ok: true,

        memories:
          result,

        limit,

        requestId:
          req.requestId,

      });

    } catch (error) {

      console.error(
        "[JEV] Recent memories:",
        error.message
      );

      res.status(500).json({

        ok: false,

        error:
          "Could not retrieve recent memories",

        requestId:
          req.requestId,

      });

    }

  }
);


// ============================================================
// MEMORY SEARCH
// ============================================================

app.post(
  "/api/memory/search",
  authenticate,
  async (req, res) => {

    try {

      const query =
        typeof req.body?.query ===
        "string"
          ? req.body.query.trim()
          : "";

      if (!query) {

        return res.status(400).json({

          ok: false,

          error:
            "Search query is required",

          requestId:
            req.requestId,

        });

      }

      if (query.length > 500) {

        return res.status(400).json({

          ok: false,

          error:
            "Search query is too long",

          requestId:
            req.requestId,

        });

      }

      const result =
        await searchSharedMemory(
          query
        );

      res.status(200).json({

        ok: true,

        query,

        results:
          result,

        requestId:
          req.requestId,

      });

    } catch (error) {

      console.error(
        "[JEV] Memory search:",
        error.message
      );

      res.status(500).json({

        ok: false,

        error:
          "Memory search failed",

        requestId:
          req.requestId,

      });

    }

  }
);


// ============================================================
// SAVE MEMORY
// ============================================================

app.post(
  "/api/memory",
  authenticate,
  async (req, res) => {

    try {

      if (
        !validObject(
          req.body
        )
      ) {

        return res.status(400).json({

          ok: false,

          error:
            "Memory object is required",

          requestId:
            req.requestId,

        });

      }

      const result =
        await saveSharedMemory(
          req.body
        );

      res.status(200).json({

        ok: true,

        memory:
          result,

        requestId:
          req.requestId,

      });

    } catch (error) {

      console.error(
        "[JEV] Save memory:",
        error.message
      );

      res.status(500).json({

        ok: false,

        error:
          "Could not save memory",

        requestId:
          req.requestId,

      });

    }

  }
);


// ============================================================
// MEMORY CONTEXT
// ============================================================

app.post(
  "/api/memory/context",
  authenticate,
  async (req, res) => {

    try {

      const input =
        req.body?.input ??
        req.body?.query ??
        "";

      if (
        typeof input !==
          "string"
      ) {

        return res.status(400).json({

          ok: false,

          error:
            "Memory context input must be text",

          requestId:
            req.requestId,

        });

      }

      const result =
        await buildJevMemoryContext(
          input
        );

      res.status(200).json({

        ok: true,

        context:
          result,

        requestId:
          req.requestId,

      });

    } catch (error) {

      console.error(
        "[JEV] Memory context:",
        error.message
      );

      res.status(500).json({

        ok: false,

        error:
          "Could not build memory context",

        requestId:
          req.requestId,

      });

    }

  }
);


// ============================================================
// MEMORY SNAPSHOT
// ============================================================

app.get(
  "/api/memory/snapshot",
  authenticate,
  async (req, res) => {

    try {

      const result =
        await getJevMemorySnapshot();

      res.status(200).json({

        ok: true,

        snapshot:
          result,

        requestId:
          req.requestId,

      });

    } catch (error) {

      console.error(
        "[JEV] Memory snapshot:",
        error.message
      );

      res.status(500).json({

        ok: false,

        error:
          "Memory snapshot failed",

        requestId:
          req.requestId,

      });

    }

  }
);


// ============================================================
// 404
// ============================================================

app.use(
  (req, res) => {

    res.status(404).json({

      ok: false,

      error:
        "Route not found",

      path:
        req.path,

      requestId:
        req.requestId,

    });

  }
);


// ============================================================
// GLOBAL ERROR HANDLER
// ============================================================

app.use(
  (error, req, res, next) => {

    console.error(
      "[JEV] Unhandled error:",
      error.message
    );

    if (
      res.headersSent
    ) {

      return next(error);

    }

    res.status(500).json({

      ok: false,

      error:
        "Internal server error",

      requestId:
        req.requestId,

    });

  }
);


// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

let server = null;


function shutdown(signal) {

  console.log(
    `[JEV] ${signal} received`
  );

  if (!server) {

    process.exit(0);

  }

  server.close(() => {

    console.log(
      "[JEV] Server stopped"
    );

    process.exit(0);

  });

  setTimeout(() => {

    console.error(
      "[JEV] Forced shutdown"
    );

    process.exit(1);

  }, 10000).unref();

}


process.on(
  "SIGTERM",
  () => shutdown("SIGTERM")
);

process.on(
  "SIGINT",
  () => shutdown("SIGINT")
);


// ============================================================
// START SERVER
// ============================================================

server =
  app.listen(
    PORT,
    "0.0.0.0",
    () => {

      console.log(
        "=========================================="
      );

      console.log(
        `${SERVICE} V${VERSION}`
      );

      console.log(
        "Status: ONLINE"
      );

      console.log(
        `Port: ${PORT}`
      );

      console.log(
        `Paper trading: ${PAPER_TRADING}`
      );

      console.log(
        `Live mode: ${LIVE_MODE}`
      );

      console.log(
        `Authentication: ${Boolean(JEV_API_KEY)}`
      );

      console.log(
        "Trade execution: DISABLED"
      );

      console.log(
        "=========================================="
      );

    }
  );
