// Jev Connector
// Server V2.0.0
//
// PURPOSE
// - AI Hub gateway for Jev
// - Market evaluation
// - Trade-intent evaluation
// - Shared memory
// - Health and diagnostics
//
// IMPORTANT
// - No runTrader dependency
// - No trader-engine status dependency
// - Paper trading by default
// - Live trading requires explicit environment configuration
// - Secrets are never returned
//

import express from "express";
import cors from "cors";
import crypto from "node:crypto";

import { evaluateMarketState } from "./jev-engine.js";
import { evaluateTrade } from "./trader-engine.js";

import {
  getSharedMemory,
  saveSharedMemory,
  searchSharedMemory,
  getRecentMemories,
  getSharedMemoryStats,
  buildJevMemoryContext,
  getJevMemorySnapshot,
  checkSharedMemoryConnection,
  getSharedMemoryStatus,
} from "./shared-memory.js";


// ==================================================
// SERVER CONFIG
// ==================================================

const app = express();

const PORT = Number(process.env.PORT || 3000);

const SERVICE = "Jev Connector";
const VERSION = "2.0.0";


// ==================================================
// SECURITY CONFIG
// ==================================================

const JEV_API_KEY = process.env.JEV_API_KEY || "";

const MAX_BODY_SIZE = "1mb";


// ==================================================
// TRADING SAFETY
// ==================================================

const PAPER_TRADING =
  String(process.env.PAPER_TRADING ?? "true").toLowerCase() === "true";

const LIVE_TRADING =
  String(process.env.LIVE_TRADING ?? "false").toLowerCase() === "true";


// Live trading is considered enabled only when BOTH
// flags explicitly allow it.

const LIVE_ENABLED =
  LIVE_TRADING === true &&
  PAPER_TRADING === false;


// ==================================================
// RATE LIMIT
// ==================================================

const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 120;

const requestCounts = new Map();


// ==================================================
// EXPRESS
// ==================================================

app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-JEV-API-Key",
    ],
  })
);

app.use(express.json({ limit: MAX_BODY_SIZE }));


// ==================================================
// REQUEST ID
// ==================================================

app.use((req, res, next) => {
  const requestId = crypto.randomUUID();

  req.requestId = requestId;

  res.setHeader("X-Request-ID", requestId);

  next();
});


// ==================================================
// RATE LIMITER
// ==================================================

function rateLimit(req, res, next) {
  const now = Date.now();

  const forwarded =
    req.headers["x-forwarded-for"];

  const ip =
    typeof forwarded === "string"
      ? forwarded.split(",")[0].trim()
      : req.socket.remoteAddress || "unknown";

  let record = requestCounts.get(ip);

  if (!record || now - record.start > RATE_WINDOW_MS) {
    record = {
      start: now,
      count: 0,
    };

    requestCounts.set(ip, record);
  }

  record.count++;

  if (record.count > RATE_LIMIT) {
    return res.status(429).json({
      ok: false,
      error: "Rate limit exceeded",
      requestId: req.requestId,
    });
  }

  next();
}

app.use(rateLimit);


// Periodically remove old rate-limit records.

setInterval(() => {
  const now = Date.now();

  for (const [ip, record] of requestCounts.entries()) {
    if (now - record.start > RATE_WINDOW_MS) {
      requestCounts.delete(ip);
    }
  }
}, RATE_WINDOW_MS).unref();


// ==================================================
// AUTHENTICATION
// ==================================================

function safeCompare(a, b) {
  if (!a || !b) {
    return false;
  }

  const aBuffer = Buffer.from(String(a));
  const bBuffer = Buffer.from(String(b));

  if (aBuffer.length !== bBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    aBuffer,
    bBuffer
  );
}


function authenticate(req, res, next) {

  // No configured key = development/open mode.
  // Render can be secured simply by adding JEV_API_KEY.

  if (!JEV_API_KEY) {
    return next();
  }

  const authorization =
    req.headers.authorization || "";

  const bearerKey =
    authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";

  const headerKey =
    req.headers["x-jev-api-key"] || "";

  const suppliedKey =
    bearerKey || headerKey;

  if (!safeCompare(suppliedKey, JEV_API_KEY)) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized",
      requestId: req.requestId,
    });
  }

  next();
}


// ==================================================
// BASIC SERVICE INFO
// ==================================================

function getExecutionStatus() {
  return {
    paper: PAPER_TRADING,
    live: LIVE_ENABLED,
  };
}


// ==================================================
// ROOT
// ==================================================

app.get("/", (req, res) => {
  res.json({
    ok: true,

    service: SERVICE,

    version: VERSION,

    status: "online",

    role: "evaluation-and-paper-trading",

    execution: getExecutionStatus(),

    walletAccess: false,

    privateKeys: false,

    withdrawals: false,

    authentication: {
      configured: Boolean(JEV_API_KEY),
    },

    requestId: req.requestId,
  });
});


// ==================================================
// HEALTH
// ==================================================

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,

    service: SERVICE,

    version: VERSION,

    status: "online",

    uptime: Math.floor(process.uptime()),

    execution: getExecutionStatus(),

    modules: {
      jevEngine: true,
      traderEngine: true,
      sharedMemory: true,
    },

    requestId: req.requestId,
  });
});


// ==================================================
// STATUS
// ==================================================

app.get("/api/status", authenticate, async (req, res) => {
  try {

    const memoryStatus =
      await getSharedMemoryStatus();

    const memoryConnected =
      Boolean(memoryStatus?.connected);

    const memoryConfigured =
      Boolean(memoryStatus?.configured);

    const status =
      memoryConfigured && !memoryConnected
        ? "degraded"
        : "online";

    res.status(200).json({
      ok: status === "online",

      service: SERVICE,

      version: VERSION,

      status,

      role: "evaluation-and-paper-trading",

      execution: getExecutionStatus(),

      walletAccess: false,

      privateKeys: false,

      withdrawals: false,

      authentication: {
        configured: Boolean(JEV_API_KEY),
      },

      sharedMemory: memoryStatus,

      modules: {
        jevEngine: true,
        traderEngine: true,
        sharedMemory: true,
      },

      requestId: req.requestId,
    });

  } catch (error) {

    console.error(
      "[JEV] Status error:",
      error.message
    );

    res.status(200).json({
      ok: true,

      service: SERVICE,

      version: VERSION,

      status: "online",

      execution: getExecutionStatus(),

      sharedMemory: {
        configured: false,
        connected: false,
      },

      requestId: req.requestId,
    });
  }
});


// ==================================================
// MARKET EVALUATION
// ==================================================

app.post(
  "/api/evaluate-market",
  authenticate,
  async (req, res) => {

    try {

      const marketData =
        req.body?.marketData ?? req.body;

      if (
        !marketData ||
        typeof marketData !== "object"
      ) {
        return res.status(400).json({
          ok: false,
          error: "Invalid market data",
          requestId: req.requestId,
        });
      }

      const result =
        await evaluateMarketState(
          marketData
        );

      return res.json({
        ok: true,

        service: SERVICE,

        operation: "market-evaluation",

        result,

        requestId: req.requestId,
      });

    } catch (error) {

      console.error(
        "[JEV] Market evaluation error:",
        error.message
      );

      return res.status(500).json({
        ok: false,
        error: "Market evaluation failed",
        requestId: req.requestId,
      });
    }
  }
);


// ==================================================
// TRADE EVALUATION
// ==================================================
//
// IMPORTANT:
// This creates a TRADE INTENT.
// It does not execute a trade.
//

app.post(
  "/api/evaluate-trade",
  authenticate,
  async (req, res) => {

    try {

      const state =
        req.body?.state ?? req.body;

      const options =
        req.body?.options ?? {};

      if (
        !state ||
        typeof state !== "object"
      ) {
        return res.status(400).json({
          ok: false,
          error: "Invalid trader state",
          requestId: req.requestId,
        });
      }

      const result =
        await evaluateTrade(
          state,
          options
        );

      return res.json({
        ok: true,

        service: SERVICE,

        operation: "trade-evaluation",

        execution: {
          paper: PAPER_TRADING,
          live: LIVE_ENABLED,
        },

        result,

        requestId: req.requestId,
      });

    } catch (error) {

      console.error(
        "[JEV] Trade evaluation error:",
        error.message
      );

      return res.status(500).json({
        ok: false,
        error: "Trade evaluation failed",
        requestId: req.requestId,
      });
    }
  }
);


// ==================================================
// SHARED MEMORY STATUS
// ==================================================

app.get(
  "/api/memory/status",
  authenticate,
  async (req, res) => {

    try {

      const result =
        await getSharedMemoryStatus();

      res.json({
        ok: true,

        sharedMemory: result,

        requestId: req.requestId,
      });

    } catch (error) {

      console.error(
        "[JEV] Memory status error:",
        error.message
      );

      res.status(500).json({
        ok: false,
        error: "Shared memory status failed",
        requestId: req.requestId,
      });
    }
  }
);


// ==================================================
// SHARED MEMORY CONNECTION CHECK
// ==================================================

app.get(
  "/api/memory/connection",
  authenticate,
  async (req, res) => {

    try {

      const result =
        await checkSharedMemoryConnection();

      res.json({
        ok: true,

        connection: result,

        requestId: req.requestId,
      });

    } catch (error) {

      console.error(
        "[JEV] Memory connection error:",
        error.message
      );

      res.status(500).json({
        ok: false,
        error: "Shared memory connection check failed",
        requestId: req.requestId,
      });
    }
  }
);


// ==================================================
// SHARED MEMORY STATS
// ==================================================

app.get(
  "/api/memory/stats",
  authenticate,
  async (req, res) => {

    try {

      const result =
        await getSharedMemoryStats();

      res.json({
        ok: true,

        stats: result,

        requestId: req.requestId,
      });

    } catch (error) {

      console.error(
        "[JEV] Memory stats error:",
        error.message
      );

      res.status(500).json({
        ok: false,
        error: "Shared memory statistics failed",
        requestId: req.requestId,
      });
    }
  }
);


// ==================================================
// RECENT MEMORIES
// ==================================================

app.get(
  "/api/memory/recent",
  authenticate,
  async (req, res) => {

    try {

      let limit =
        Number(req.query.limit || 20);

      if (!Number.isFinite(limit)) {
        limit = 20;
      }

      limit =
        Math.max(
          1,
          Math.min(
            Math.floor(limit),
            100
          )
        );

      const result =
        await getRecentMemories(limit);

      res.json({
        ok: true,

        memories: result,

        limit,

        requestId: req.requestId,
      });

    } catch (error) {

      console.error(
        "[JEV] Recent memory error:",
        error.message
      );

      res.status(500).json({
        ok: false,
        error: "Could not retrieve recent memories",
        requestId: req.requestId,
      });
    }
  }
);


// ==================================================
// MEMORY SEARCH
// ==================================================

app.post(
  "/api/memory/search",
  authenticate,
  async (req, res) => {

    try {

      const query =
        typeof req.body?.query === "string"
          ? req.body.query.trim()
          : "";

      if (!query) {
        return res.status(400).json({
          ok: false,
          error: "Search query is required",
          requestId: req.requestId,
        });
      }

      const result =
        await searchSharedMemory(query);

      res.json({
        ok: true,

        query,

        results: result,

        requestId: req.requestId,
      });

    } catch (error) {

      console.error(
        "[JEV] Memory search error:",
        error.message
      );

      res.status(500).json({
        ok: false,
        error: "Memory search failed",
        requestId: req.requestId,
      });
    }
  }
);


// ==================================================
// SAVE MEMORY
// ==================================================

app.post(
  "/api/memory",
  authenticate,
  async (req, res) => {

    try {

      if (
        !req.body ||
        typeof req.body !== "object"
      ) {
        return res.status(400).json({
          ok: false,
          error: "Memory payload is required",
          requestId: req.requestId,
        });
      }

      const result =
        await saveSharedMemory(
          req.body
        );

      res.json({
        ok: true,

        memory: result,

        requestId: req.requestId,
      });

    } catch (error) {

      console.error(
        "[JEV] Save memory error:",
        error.message
      );

      res.status(500).json({
        ok: false,
        error: "Could not save memory",
        requestId: req.requestId,
      });
    }
  }
);


// ==================================================
// JEV MEMORY CONTEXT
// ==================================================

app.post(
  "/api/memory/context",
  authenticate,
  async (req, res) => {

    try {

      const input =
        req.body?.input ??
        req.body?.query ??
        "";

      const result =
        await buildJevMemoryContext(
          input
        );

      res.json({
        ok: true,

        context: result,

        requestId: req.requestId,
      });

    } catch (error) {

      console.error(
        "[JEV] Memory context error:",
        error.message
      );

      res.status(500).json({
        ok: false,
        error: "Could not build Jev memory context",
        requestId: req.requestId,
      });
    }
  }
);


// ==================================================
// JEV MEMORY SNAPSHOT
// ==================================================

app.get(
  "/api/memory/snapshot",
  authenticate,
  async (req, res) => {

    try {

      const result =
        await getJevMemorySnapshot();

      res.json({
        ok: true,

        snapshot: result,

        requestId: req.requestId,
      });

    } catch (error) {

      console.error(
        "[JEV] Memory snapshot error:",
        error.message
      );

      res.status(500).json({
        ok: false,
        error: "Memory snapshot failed",
        requestId: req.requestId,
      });
    }
  }
);


// ==================================================
// 404
// ==================================================

app.use((req, res) => {

  res.status(404).json({
    ok: false,

    error: "Route not found",

    path: req.path,

    requestId: req.requestId,
  });

});


// ==================================================
// GLOBAL ERROR HANDLER
// ==================================================

app.use((error, req, res, next) => {

  console.error(
    "[JEV] Unhandled server error:",
    error.message
  );

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    ok: false,

    error: "Internal server error",

    requestId: req.requestId,
  });

});


// ==================================================
// GRACEFUL SHUTDOWN
// ==================================================

let server;

function shutdown(signal) {

  console.log(
    `[JEV] ${signal} received. Shutting down...`
  );

  if (!server) {
    process.exit(0);
  }

  server.close(() => {

    console.log(
      "[JEV] Server stopped."
    );

    process.exit(0);
  });

  setTimeout(() => {

    console.error(
      "[JEV] Forced shutdown."
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


// ==================================================
// START
// ==================================================

server = app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "========================================"
    );

    console.log(
      `${SERVICE} started`
    );

    console.log(
      `Version: ${VERSION}`
    );

    console.log(
      `Port: ${PORT}`
    );

    console.log(
      `Paper trading: ${PAPER_TRADING}`
    );

    console.log(
      `Live trading: ${LIVE_ENABLED}`
    );

    console.log(
      `Authentication: ${Boolean(JEV_API_KEY)}`
    );

    console.log(
      "========================================"
    );

  }
);
