// Jev Connector
// HTTP API Server V1.4.0
//
// Purpose:
// - Protected Jev evaluation API
// - Read-only Shared Memory access
// - Trader Engine integration
// - Paper-trading API
// - Strict validation
// - Rate limiting
// - Safe logging
// - Consistent request IDs across the security layer and API
//
// SAFETY:
// - PAPER trading only through this API
// - Live trading is blocked
// - No wallet access
// - No private keys
// - No withdrawals
// - No exchange permission changes

import express from "express";
import cors from "cors";

import {
  attachRequestId,
  requireJevAuth,
  getAuthStatus
} from "./security.js";

import {
  evaluateMarketState
} from "./jev-engine.js";

import {
  runTrader,
  getTraderStatus
} from "./trader-engine.js";

import {
  getSharedMemory,
  searchSharedMemory,
  getRecentMemories,
  getSharedMemoryStats,
  buildJevMemoryContext,
  getJevMemorySnapshot,
  checkSharedMemoryConnection,
  getSharedMemoryStatus
} from "./shared-memory.js";

// ============================================================
// CONFIGURATION
// ============================================================

const app = express();

const PORT = Number(process.env.PORT || 3000);

const SERVICE_NAME = "Jev Connector";
const SERVICE_VERSION = "1.4.0";

const JSON_LIMIT = "1mb";

const MAX_MEMORY_QUERIES = 10;
const MAX_MEMORY_QUERY_LENGTH = 500;

const MAX_EVALUATIONS_PER_MINUTE = 30;
const MAX_TRADER_REQUESTS_PER_MINUTE = 20;

const RATE_WINDOW_MS = 60 * 1000;

// ============================================================
// HARDENING
// ============================================================

app.disable("x-powered-by");
app.set("trust proxy", 1);

// ============================================================
// REQUEST ID
// ============================================================
//
// security.js owns the canonical request ID.
// Keeping one request ID prevents mismatched IDs in:
// - security responses
// - HTTP logs
// - API responses
//

app.use(attachRequestId);

// ============================================================
// CORS
// ============================================================

const configuredOrigins = String(process.env.CORS_ORIGIN || "")
  .split(",")
  .map(value => value.trim())
  .filter(Boolean);

const corsOptions = {
  origin(origin, callback) {
    if (!origin) {
      return callback(null, true);
    }

    if (configuredOrigins.length === 0) {
      return callback(new Error("Browser CORS is not configured"));
    }

    if (configuredOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error("CORS origin not allowed"));
  },

  methods: ["GET", "POST", "OPTIONS"],

  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "x-ai-client",
    "x-request-id"
  ],

  maxAge: 600
};

app.use(cors(corsOptions));

// ============================================================
// JSON
// ============================================================

app.use(
  express.json({
    limit: JSON_LIMIT,
    strict: true
  })
);

// ============================================================
// SAFE LOGGING
// ============================================================

app.use((req, res, next) => {
  const started = Date.now();

  res.on("finish", () => {
    const duration = Date.now() - started;

    const client =
      req.jevAuth?.client ||
      "unauthenticated";

    console.log(
      `[HTTP] ${req.method} ${req.path} ` +
      `${res.statusCode} ${duration}ms ` +
      `client=${client} ` +
      `request=${req.requestId}`
    );
  });

  next();
});

// ============================================================
// RATE LIMITING
// ============================================================

const evaluationRateMap = new Map();
const traderRateMap = new Map();

function cleanupRateMap(map) {
  const now = Date.now();

  for (const [key, entry] of map) {
    if (
      now - entry.startedAt >=
      RATE_WINDOW_MS
    ) {
      map.delete(key);
    }
  }
}

setInterval(() => {
  cleanupRateMap(evaluationRateMap);
  cleanupRateMap(traderRateMap);
}, RATE_WINDOW_MS).unref();

function checkRateLimit(req, map, maximum) {
  const client =
    req.jevAuth?.client ||
    "unknown";

  const ip =
    req.ip ||
    "unknown";

  const key = `${client}:${ip}`;
  const now = Date.now();

  let entry = map.get(key);

  if (
    !entry ||
    now - entry.startedAt >= RATE_WINDOW_MS
  ) {
    entry = {
      startedAt: now,
      count: 0
    };

    map.set(key, entry);
  }

  entry.count += 1;

  if (entry.count > maximum) {
    return {
      allowed: false,
      retryAfter: Math.ceil(
        (
          RATE_WINDOW_MS -
          (now - entry.startedAt)
        ) / 1000
      )
    };
  }

  return {
    allowed: true,
    retryAfter: 0
  };
}

// ============================================================
// VALIDATION HELPERS
// ============================================================

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function validateMemoryQueries(queries) {
  if (!Array.isArray(queries)) {
    return "queries must be an array";
  }

  if (queries.length > MAX_MEMORY_QUERIES) {
    return (
      `queries cannot contain more than ` +
      `${MAX_MEMORY_QUERIES} items`
    );
  }

  for (const query of queries) {
    if (
      typeof query !== "string" ||
      query.trim().length === 0 ||
      query.length > MAX_MEMORY_QUERY_LENGTH
    ) {
      return "Invalid memory query";
    }
  }

  return null;
}

function parseMemoryLimit(value, fallback = 10) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(
    Math.max(Math.floor(parsed), 1),
    10
  );
}

// ============================================================
// PUBLIC ROOT
// ============================================================

app.get("/", (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  res.json({
    ok: true,
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    status: "online",

    role: "evaluation-and-paper-trading",

    execution: {
      live: false,
      paper: true
    },

    walletAccess: false,
    privateKeys: false,
    withdrawals: false
  });
});

// ============================================================
// PUBLIC HEALTH
// ============================================================

app.get("/health", async (req, res) => {
  let memory;

  try {
    memory = await checkSharedMemoryConnection();
  } catch {
    memory = {
      ok: false,
      configured: false,
      connected: false,
      readOnly: true
    };
  }

  const healthy =
    memory.configured
      ? memory.connected
      : true;

  res.setHeader("Cache-Control", "no-store");

  res.status(healthy ? 200 : 503).json({
    ok: healthy,

    service: SERVICE_NAME,
    version: SERVICE_VERSION,

    status:
      healthy
        ? "online"
        : "degraded",

    execution: {
      live: false,
      paper: true
    },

    walletAccess: false,
    privateKeys: false,
    withdrawals: false,

    authentication: {
      configured:
        getAuthStatus().configured
    },

    sharedMemory: {
      configured:
        memory.configured,

      connected:
        memory.connected,

      readOnly: true
    },

    requestId:
      req.requestId
  });
});

// ============================================================
// AUTHENTICATION
// ============================================================

app.use("/api", requireJevAuth);

// ============================================================
// API SECURITY HEADERS
// ============================================================

app.use("/api", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-DNS-Prefetch-Control", "off");

  next();
});

// ============================================================
// API ROOT
// ============================================================

app.get("/api", (req, res) => {
  res.json({
    ok: true,

    service: SERVICE_NAME,
    version: SERVICE_VERSION,

    authenticated: true,

    role: "evaluation-and-paper-trading",

    endpoints: {
      status: "GET /api/status",
      evaluate: "POST /api/evaluate",

      traderStatus:
        "GET /api/trader/status",

      traderPaper:
        "POST /api/trader/paper",

      memory:
        "GET /api/memory/:id",

      memorySearch:
        "GET /api/memory/search",

      memoryRecent:
        "GET /api/memory/recent",

      memoryStats:
        "GET /api/memory/stats",

      memoryContext:
        "POST /api/memory/context",

      memorySnapshot:
        "POST /api/memory/snapshot",

      memoryHealth:
        "GET /api/memory/health"
    },

    requestId:
      req.requestId
  });
});

// ============================================================
// STATUS
// ============================================================

app.get("/api/status", (req, res) => {
  let trader;

  try {
    trader = getTraderStatus();
  } catch (error) {
    trader = {
      available: false,
      error:
        error?.message ||
        "Trader status unavailable"
    };
  }

  res.json({
    ok: true,

    service: SERVICE_NAME,
    version: SERVICE_VERSION,

    authenticated: true,

    role: "evaluation-and-paper-trading",

    execution: {
      enabled: false,
      live: false,
      paper: true,

      walletAccess: false,
      privateKeys: false,
      withdrawals: false,

      exchangePermissionChanges: false
    },

    authentication: {
      configured:
        getAuthStatus().configured
    },

    trader,

    sharedMemory:
      getSharedMemoryStatus(),

    limits: {
      maxEvaluationsPerMinute:
        MAX_EVALUATIONS_PER_MINUTE,

      maxTraderRequestsPerMinute:
        MAX_TRADER_REQUESTS_PER_MINUTE,

      maxMemoryQueries:
        MAX_MEMORY_QUERIES,

      maxMemoryQueryLength:
        MAX_MEMORY_QUERY_LENGTH
    },

    requestId:
      req.requestId
  });
});

// ============================================================
// TRADER STATUS
// ============================================================

app.get("/api/trader/status", (req, res) => {
  try {
    const trader = getTraderStatus();

    return res.json({
      ok: true,
      requestId: req.requestId,
      trader
    });
  } catch {
    return res.status(500).json({
      ok: false,
      error: "Unable to read Trader status",
      requestId: req.requestId
    });
  }
});

// ============================================================
// PAPER TRADER
// ============================================================
//
// PAPER ONLY.
// No exchange order is submitted by this endpoint.
// Live trading is explicitly refused.
//

app.post("/api/trader/paper", async (req, res) => {
  const rate = checkRateLimit(
    req,
    traderRateMap,
    MAX_TRADER_REQUESTS_PER_MINUTE
  );

  if (!rate.allowed) {
    res.setHeader(
      "Retry-After",
      String(rate.retryAfter)
    );

    return res.status(429).json({
      ok: false,
      error: "Trader rate limit exceeded",
      retryAfterSeconds: rate.retryAfter,
      requestId: req.requestId
    });
  }

  try {
    const body = req.body;

    if (!isPlainObject(body)) {
      return res.status(400).json({
        ok: false,
        error: "Request body must be an object",
        requestId: req.requestId
      });
    }

    if (
      body.state === undefined ||
      body.state === null
    ) {
      return res.status(400).json({
        ok: false,
        error: "state is required",
        requestId: req.requestId
      });
    }

    if (
      process.env.TRADING_MODE
        ?.trim()
        .toUpperCase() === "LIVE"
    ) {
      return res.status(403).json({
        ok: false,
        error:
          "Paper endpoint is disabled while TRADING_MODE=LIVE",
        requestId: req.requestId
      });
    }

    const policy =
      isPlainObject(body.policy)
        ? body.policy
        : {};

    const result = await runTrader(
      body.state,
      { policy }
    );

    return res.json({
      ok: true,
      requestId: req.requestId,
      mode: "PAPER",
      liveTrading: false,
      executionAllowed: false,
      result
    });
  } catch (error) {
    console.error(
      `[TRADER] Paper request failed ` +
      `request=${req.requestId}:`,
      error?.message || "unknown error"
    );

    return res.status(502).json({
      ok: false,
      error: "Paper trader evaluation failed",
      requestId: req.requestId
    });
  }
});

// ============================================================
// JEV EVALUATION
// ============================================================

app.post("/api/evaluate", async (req, res) => {
  const rate = checkRateLimit(
    req,
    evaluationRateMap,
    MAX_EVALUATIONS_PER_MINUTE
  );

  if (!rate.allowed) {
    res.setHeader(
      "Retry-After",
      String(rate.retryAfter)
    );

    return res.status(429).json({
      ok: false,
      error: "Evaluation rate limit exceeded",
      retryAfterSeconds: rate.retryAfter,
      requestId: req.requestId
    });
  }

  try {
    const body = req.body;

    if (!isPlainObject(body)) {
      return res.status(400).json({
        ok: false,
        error: "Request body must be an object",
        requestId: req.requestId
      });
    }

    const state = body.state;

    if (
      state === undefined ||
      state === null
    ) {
      return res.status(400).json({
        ok: false,
        error: "state is required",
        requestId: req.requestId
      });
    }

    let evaluationState = state;

    if (body.memoryQueries !== undefined) {
      const validationError =
        validateMemoryQueries(
          body.memoryQueries
        );

      if (validationError) {
        return res.status(400).json({
          ok: false,
          error: validationError,
          requestId: req.requestId
        });
      }

      try {
        const snapshot =
          await getJevMemorySnapshot(
            body.memoryQueries,
            {
              limit: 10,
              status: "ACTIVE"
            }
          );

        if (
          isPlainObject(evaluationState)
        ) {
          evaluationState = {
            ...evaluationState,

            sharedMemory: snapshot,

            sharedMemoryPolicy: {
              role: "reference-data",
              executable: false,
              instructionsAllowed: false
            }
          };
        } else {
          evaluationState = {
            marketState: evaluationState,

            sharedMemory: snapshot,

            sharedMemoryPolicy: {
              role: "reference-data",
              executable: false,
              instructionsAllowed: false
            }
          };
        }
      } catch (error) {
        console.error(
          `[JEV] Shared Memory context failed ` +
          `request=${req.requestId}:`,
          error?.message || "unknown error"
        );

        return res.status(502).json({
          ok: false,
          error:
            "Unable to retrieve requested Shared Memory context",
          requestId: req.requestId
        });
      }
    }

    const result =
      await evaluateMarketState(
        evaluationState
      );

    return res.json({
      ok: true,
      requestId: req.requestId,
      result
    });
  } catch (error) {
    console.error(
      `[JEV] Evaluation failed ` +
      `request=${req.requestId}:`,
      error?.message || "unknown error"
    );

    return res.status(502).json({
      ok: false,
      error: "Jev evaluation failed",
      requestId: req.requestId
    });
  }
});

// ============================================================
// MEMORY: GET ONE
// ============================================================

app.get("/api/memory/:id", async (req, res) => {
  try {
    const id = req.params.id;

    if (
      typeof id !== "string" ||
      id.length === 0 ||
      id.length > 200
    ) {
      return res.status(400).json({
        ok: false,
        error: "Invalid memory id",
        requestId: req.requestId
      });
    }

    const memory =
      await getSharedMemory(id);

    if (!memory) {
      return res.status(404).json({
        ok: false,
        error: "Memory not found",
        requestId: req.requestId
      });
    }

    return res.json({
      ok: true,
      requestId: req.requestId,
      readOnly: true,
      memory
    });
  } catch (error) {
    console.error(
      `[MEMORY] Read failed ` +
      `request=${req.requestId}:`,
      error?.message || "unknown error"
    );

    return res.status(502).json({
      ok: false,
      error: "Unable to read Shared Memory",
      requestId: req.requestId
    });
  }
});

// ============================================================
// MEMORY: SEARCH
// ============================================================

app.get("/api/memory/search", async (req, res) => {
  try {
    const query = req.query.q;

    if (
      typeof query !== "string" ||
      !query.trim()
    ) {
      return res.status(400).json({
        ok: false,
        error: "q query parameter is required",
        requestId: req.requestId
      });
    }

    if (
      query.length >
      MAX_MEMORY_QUERY_LENGTH
    ) {
      return res.status(400).json({
        ok: false,
        error: "Search query is too long",
        requestId: req.requestId
      });
    }

    const results =
      await searchSharedMemory(
        query,
        {
          limit:
            parseMemoryLimit(
              req.query.limit
            ),

          category:
            req.query.category,

          source_ai:
            req.query.source_ai,

          related_project:
            req.query.related_project,

          status:
            req.query.status
        }
      );

    return res.json({
      ok: true,
      requestId: req.requestId,
      readOnly: true,
      count: results.length,
      results
    });
  } catch (error) {
    console.error(
      `[MEMORY] Search failed ` +
      `request=${req.requestId}:`,
      error?.message || "unknown error"
    );

    return res.status(502).json({
      ok: false,
      error: "Shared Memory search failed",
      requestId: req.requestId
    });
  }
});

// ============================================================
// MEMORY: RECENT
// ============================================================

app.get("/api/memory/recent", async (req, res) => {
  try {
    const memories =
      await getRecentMemories({
        limit:
          parseMemoryLimit(
            req.query.limit
          ),

        includeArchived:
          req.query.includeArchived === "true"
      });

    return res.json({
      ok: true,
      requestId: req.requestId,
      readOnly: true,
      count: memories.length,
      memories
    });
  } catch (error) {
    console.error(
      `[MEMORY] Recent memory failed ` +
      `request=${req.requestId}:`,
      error?.message || "unknown error"
    );

    return res.status(502).json({
      ok: false,
      error:
        "Unable to read recent Shared Memory",
      requestId: req.requestId
    });
  }
});

// ============================================================
// MEMORY: STATS
// ============================================================

app.get("/api/memory/stats", async (req, res) => {
  try {
    const stats =
      await getSharedMemoryStats();

    return res.json({
      ok: true,
      requestId: req.requestId,
      readOnly: true,
      stats
    });
  } catch (error) {
    console.error(
      `[MEMORY] Stats failed ` +
      `request=${req.requestId}:`,
      error?.message || "unknown error"
    );

    return res.status(502).json({
      ok: false,
      error:
        "Unable to read Shared Memory statistics",
      requestId: req.requestId
    });
  }
});

// ============================================================
// MEMORY: CONTEXT
// ============================================================

app.post("/api/memory/context", async (req, res) => {
  try {
    const body = req.body;

    if (!isPlainObject(body)) {
      return res.status(400).json({
        ok: false,
        error: "Request body must be an object",
        requestId: req.requestId
      });
    }

    const validationError =
      validateMemoryQueries(body.queries);

    if (validationError) {
      return res.status(400).json({
        ok: false,
        error: validationError,
        requestId: req.requestId
      });
    }

    const context =
      await buildJevMemoryContext(
        body.queries,
        {
          limit:
            parseMemoryLimit(
              body.limit
            ),

          category:
            body.category,

          source_ai:
            body.source_ai,

          related_project:
            body.related_project,

          status:
            body.status ||
            "ACTIVE"
        }
      );

    return res.json({
      ok: true,
      requestId: req.requestId,
      readOnly: true,
      context
    });
  } catch (error) {
    console.error(
      `[MEMORY] Context failed ` +
      `request=${req.requestId}:`,
      error?.message || "unknown error"
    );

    return res.status(502).json({
      ok: false,
      error:
        "Unable to build Jev memory context",
      requestId: req.requestId
    });
  }
});

// ============================================================
// MEMORY: SNAPSHOT
// ============================================================

app.post("/api/memory/snapshot", async (req, res) => {
  try {
    const body = req.body;

    if (!isPlainObject(body)) {
      return res.status(400).json({
        ok: false,
        error: "Request body must be an object",
        requestId: req.requestId
      });
    }

    const queries =
      body.queries === undefined
        ? []
        : body.queries;

    const validationError =
      validateMemoryQueries(queries);

    if (validationError) {
      return res.status(400).json({
        ok: false,
        error: validationError,
        requestId: req.requestId
      });
    }

    const snapshot =
      await getJevMemorySnapshot(
        queries,
        {
          limit: 10,
          status: "ACTIVE"
        }
      );

    return res.json({
      ok: true,
      requestId: req.requestId,
      readOnly: true,
      snapshot
    });
  } catch (error) {
    console.error(
      `[MEMORY] Snapshot failed ` +
      `request=${req.requestId}:`,
      error?.message || "unknown error"
    );

    return res.status(502).json({
      ok: false,
      error:
        "Unable to build memory snapshot",
      requestId: req.requestId
    });
  }
});

// ============================================================
// MEMORY: HEALTH
// ============================================================

app.get("/api/memory/health", async (req, res) => {
  try {
    const result =
      await checkSharedMemoryConnection();

    return res.status(
      result.ok ? 200 : 503
    ).json({
      ok: result.ok,
      requestId: req.requestId,
      sharedMemory: result
    });
  } catch {
    return res.status(503).json({
      ok: false,
      requestId: req.requestId,

      sharedMemory: {
        ok: false,
        configured: false,
        connected: false,
        readOnly: true
      }
    });
  }
});

// ============================================================
// UNKNOWN API ROUTES
// ============================================================

app.use("/api", (req, res) => {
  res.status(404).json({
    ok: false,
    error: "API endpoint not found",
    requestId: req.requestId
  });
});

// ============================================================
// REQUEST ERROR HANDLER
// ============================================================

app.use((error, req, res, next) => {
  if (
    error?.type === "entity.too.large"
  ) {
    return res.status(413).json({
      ok: false,
      error: "Request body is too large",
      requestId: req.requestId
    });
  }

  if (
    error instanceof SyntaxError &&
    error.status === 400 &&
    "body" in error
  ) {
    return res.status(400).json({
      ok: false,
      error: "Invalid JSON",
      requestId: req.requestId
    });
  }

  return next(error);
});

// ============================================================
// GLOBAL ERROR HANDLER
// ============================================================

app.use((error, req, res, next) => {
  console.error(
    `[SERVER] Unhandled error ` +
    `request=${req.requestId}:`,
    error?.message || "unknown error"
  );

  if (res.headersSent) {
    return next(error);
  }

  return res.status(500).json({
    ok: false,
    error: "Internal server error",
    requestId: req.requestId
  });
});

// ============================================================
// START SERVER
// ============================================================

const server = app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `${SERVICE_NAME} ${SERVICE_VERSION} ` +
      `listening on port ${PORT}`
    );

    console.log(
      `[SECURITY] Authentication configured: ` +
      `${getAuthStatus().configured}`
    );

    console.log(
      "[SECURITY] Jev evaluation: true"
    );

    console.log(
      "[SECURITY] Paper trading: true"
    );

    console.log(
      "[SECURITY] Live trading: false"
    );

    console.log(
      "[SECURITY] Wallet access: false"
    );

    console.log(
      "[SECURITY] Withdrawal access: false"
    );

    console.log(
      "[SECURITY] Private-key access: false"
    );
  }
);

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log(
    `[SERVER] ${signal} received.`
  );

  server.close(() => {
    console.log(
      "[SERVER] Shutdown complete."
    );

    process.exit(0);
  });

  setTimeout(() => {
    console.error(
      "[SERVER] Forced shutdown."
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
