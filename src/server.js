// Jev Connector
// HTTP API Server V1.2
//
// Purpose:
// - Protected Jev evaluation API
// - Read-only Shared Memory access
// - Strict request validation
// - Basic abuse/cost protection
// - Safe operational logging
// - Clear separation from trading execution
//
// Jev CAN:
// - evaluate supplied market state
// - read Shared Memory
//
// Jev CANNOT:
// - place trades
// - access wallets
// - access private keys
// - withdraw funds
// - modify exchange permissions
// - execute transactions
//
// Architecture:
//
// Market / Scanner / Social / Liquidity data
//                    |
//                    v
//              Shared Memory
//                    |
//                    v
//                  Jev
//                    |
//                    v
//           Structured Evaluation
//                    |
//                    v
//               Risk Engine
//                    |
//                    v
//            Execution Engine
//                    |
//                    v
//                 Exchange
//
// IMPORTANT:
// Jev stops at structured evaluation.
// Execution is a separate security boundary.

import express from "express";
import cors from "cors";
import crypto from "node:crypto";

import {
  requireJevAuth,
  getAuthStatus
} from "./security.js";

import {
  evaluateMarketState
} from "./jev-engine.js";

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

const PORT =
  Number(process.env.PORT || 3000);

const SERVICE_NAME =
  "Jev Connector";

const SERVICE_VERSION =
  "1.2.0";

const JSON_LIMIT =
  "1mb";

const MAX_REQUEST_ID_LENGTH =
  128;

const MAX_MEMORY_QUERIES =
  10;

const MAX_MEMORY_QUERY_LENGTH =
  500;

const MAX_EVALUATIONS_PER_MINUTE =
  30;

const RATE_WINDOW_MS =
  60 * 1000;


// ============================================================
// BASIC HARDENING
// ============================================================

app.disable("x-powered-by");

app.set(
  "trust proxy",
  1
);


// ============================================================
// CORS
// ============================================================
//
// Server-to-server requests do not need an Origin.
//
// If browser access is required, configure:
//
// CORS_ORIGIN=https://your-approved-site.example
//
// Multiple origins:
//
// CORS_ORIGIN=https://site1.example,https://site2.example

const configuredOrigins =
  String(
    process.env.CORS_ORIGIN || ""
  )
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);


const corsOptions = {

  origin(origin, callback) {

    // Server-to-server request.
    if (!origin) {
      return callback(null, true);
    }

    // If browser origins have not been configured,
    // do not permit browser cross-origin access.
    if (
      configuredOrigins.length === 0
    ) {
      return callback(
        new Error("Browser CORS is not configured")
      );
    }

    if (
      configuredOrigins.includes(origin)
    ) {
      return callback(null, true);
    }

    return callback(
      new Error("CORS origin not allowed")
    );
  },

  methods: [
    "GET",
    "POST",
    "OPTIONS"
  ],

  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "x-ai-client",
    "x-request-id"
  ],

  maxAge: 600
};


app.use(
  cors(corsOptions)
);


// ============================================================
// JSON BODY PARSER
// ============================================================

app.use(
  express.json({
    limit: JSON_LIMIT,
    strict: true
  })
);


// ============================================================
// REQUEST ID
// ============================================================

function createRequestId() {

  return crypto.randomUUID();
}


app.use(
  (req, res, next) => {

    const supplied =
      req.get("x-request-id");

    const requestId =
      supplied &&
      supplied.length <= MAX_REQUEST_ID_LENGTH &&
      /^[a-zA-Z0-9._:-]+$/.test(supplied)
        ? supplied
        : createRequestId();

    req.requestId =
      requestId;

    res.setHeader(
      "x-request-id",
      requestId
    );

    next();
  }
);


// ============================================================
// SAFE REQUEST LOGGING
// ============================================================
//
// NEVER log:
// - Authorization headers
// - API keys
// - private keys
// - request bodies
// - complete market payloads
// - credentials

app.use(
  (req, res, next) => {

    const started =
      Date.now();

    res.on(
      "finish",
      () => {

        const duration =
          Date.now() -
          started;

        const client =
          req.jevAuth?.client ||
          "unauthenticated";

        console.log(
          `[HTTP] ${req.method} ${req.path} ` +
          `${res.statusCode} ${duration}ms ` +
          `client=${client} ` +
          `request=${req.requestId}`
        );
      }
    );

    next();
  }
);


// ============================================================
// SIMPLE IN-MEMORY RATE LIMITER
// ============================================================
//
// This is deliberately lightweight.
//
// It protects the single Jev service instance from accidental
// request floods and unexpected evaluation cost.
//
// A distributed limiter can replace this later if Jev scales
// across multiple instances.

const evaluationRateMap =
  new Map();


function cleanupRateLimits() {

  const now =
    Date.now();

  for (
    const [key, entry]
    of evaluationRateMap
  ) {

    if (
      now - entry.startedAt >=
      RATE_WINDOW_MS
    ) {
      evaluationRateMap.delete(key);
    }
  }
}


setInterval(
  cleanupRateLimits,
  RATE_WINDOW_MS
).unref();


function checkEvaluationRateLimit(
  req
) {

  const client =
    req.jevAuth?.client ||
    "unknown";

  const ip =
    req.ip ||
    "unknown";

  const key =
    `${client}:${ip}`;

  const now =
    Date.now();

  let entry =
    evaluationRateMap.get(key);

  if (
    !entry ||
    now - entry.startedAt >=
      RATE_WINDOW_MS
  ) {

    entry = {
      startedAt: now,
      count: 0
    };

    evaluationRateMap.set(
      key,
      entry
    );
  }

  entry.count += 1;

  if (
    entry.count >
    MAX_EVALUATIONS_PER_MINUTE
  ) {

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
// PUBLIC ROOT
// ============================================================

app.get(
  "/",
  (req, res) => {

    res.setHeader(
      "Cache-Control",
      "no-store"
    );

    res.json({

      ok: true,

      service:
        SERVICE_NAME,

      version:
        SERVICE_VERSION,

      status:
        "online",

      role:
        "evaluation-only",

      execution:
        false,

      walletAccess:
        false,

      withdrawals:
        false
    });
  }
);


// ============================================================
// PUBLIC HEALTH
// ============================================================

app.get(
  "/health",
  async (req, res) => {

    let memory;

    try {

      memory =
        await checkSharedMemoryConnection();

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


    res.setHeader(
      "Cache-Control",
      "no-store"
    );


    res.status(
      healthy ? 200 : 503
    ).json({

      ok:
        healthy,

      service:
        SERVICE_NAME,

      version:
        SERVICE_VERSION,

      status:
        healthy
          ? "online"
          : "degraded",

      execution:
        false,

      walletAccess:
        false,

      privateKeys:
        false,

      withdrawals:
        false,

      authentication: {
        configured:
          getAuthStatus().configured
      },

      sharedMemory: {
        configured:
          memory.configured,

        connected:
          memory.connected,

        readOnly:
          true
      }
    });
  }
);


// ============================================================
// AUTHENTICATION BOUNDARY
// ============================================================
//
// Every /api endpoint requires Bearer authentication.

app.use(
  "/api",
  requireJevAuth
);


// ============================================================
// API RESPONSE HEADERS
// ============================================================

app.use(
  "/api",
  (req, res, next) => {

    res.setHeader(
      "Cache-Control",
      "no-store"
    );

    res.setHeader(
      "X-Content-Type-Options",
      "nosniff"
    );

    res.setHeader(
      "X-Frame-Options",
      "DENY"
    );

    next();
  }
);


// ============================================================
// API ROOT
// ============================================================

app.get(
  "/api",
  (req, res) => {

    res.json({

      ok: true,

      service:
        SERVICE_NAME,

      version:
        SERVICE_VERSION,

      authenticated:
        true,

      role:
        "evaluation-only",

      execution:
        false,

      endpoints: {

        status:
          "GET /api/status",

        evaluate:
          "POST /api/evaluate",

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
      }
    });
  }
);


// ============================================================
// STATUS
// ============================================================

app.get(
  "/api/status",
  (req, res) => {

    res.json({

      ok: true,

      service:
        SERVICE_NAME,

      version:
        SERVICE_VERSION,

      authenticated:
        true,

      role:
        "evaluation-only",

      execution: {

        enabled:
          false,

        walletAccess:
          false,

        privateKeys:
          false,

        withdrawals:
          false,

        exchangePermissionChanges:
          false
      },

      authentication: {

        configured:
          getAuthStatus().configured
      },

      sharedMemory:
        getSharedMemoryStatus(),

      limits: {

        maxEvaluationsPerMinute:
          MAX_EVALUATIONS_PER_MINUTE,

        maxMemoryQueries:
          MAX_MEMORY_QUERIES,

        maxMemoryQueryLength:
          MAX_MEMORY_QUERY_LENGTH
      }
    });
  }
);


// ============================================================
// EVALUATE MARKET STATE
// ============================================================

app.post(
  "/api/evaluate",
  async (req, res) => {

    const rate =
      checkEvaluationRateLimit(req);


    if (!rate.allowed) {

      res.setHeader(
        "Retry-After",
        String(rate.retryAfter)
      );

      return res.status(429).json({

        ok: false,

        error:
          "Evaluation rate limit exceeded",

        retryAfterSeconds:
          rate.retryAfter,

        requestId:
          req.requestId
      });
    }


    try {

      const body =
        req.body;


      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body)
      ) {

        return res.status(400).json({

          ok: false,

          error:
            "Request body must be an object",

          requestId:
            req.requestId
        });
      }


      const state =
        body.state;


      if (
        state === undefined ||
        state === null
      ) {

        return res.status(400).json({

          ok: false,

          error:
            "state is required",

          requestId:
            req.requestId
        });
      }


      /*
       * Optional Shared Memory context.
       *
       * The client can provide a small list of queries.
       * Jev remains read-only.
       */

      let evaluationState =
        state;

      if (
        body.memoryQueries !== undefined
      ) {

        if (
          !Array.isArray(
            body.memoryQueries
          )
        ) {

          return res.status(400).json({

            ok: false,

            error:
              "memoryQueries must be an array",

            requestId:
              req.requestId
          });
        }


        if (
          body.memoryQueries.length >
          MAX_MEMORY_QUERIES
        ) {

          return res.status(400).json({

            ok: false,

            error:
              `memoryQueries cannot contain more than ` +
              `${MAX_MEMORY_QUERIES} queries`,

            requestId:
              req.requestId
          });
        }


        for (
          const query
          of body.memoryQueries
        ) {

          if (
            typeof query !== "string" ||
            query.trim().length === 0 ||
            query.length >
              MAX_MEMORY_QUERY_LENGTH
          ) {

            return res.status(400).json({

              ok: false,

              error:
                "Invalid memory query",

              requestId:
                req.requestId
            });
          }
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


          /*
           * Shared Memory is reference data.
           *
           * It must never be interpreted as executable
           * instructions by Jev.
           */

          if (
            evaluationState &&
            typeof evaluationState ===
              "object" &&
            !Array.isArray(
              evaluationState
            )
          ) {

            evaluationState = {

              ...evaluationState,

              sharedMemory:
                snapshot,

              sharedMemoryPolicy: {

                role:
                  "reference-data",

                executable:
                  false,

                instructionsAllowed:
                  false
              }
            };

          } else {

            evaluationState = {

              marketState:
                evaluationState,

              sharedMemory:
                snapshot,

              sharedMemoryPolicy: {

                role:
                  "reference-data",

                executable:
                  false,

                instructionsAllowed:
                  false
              }
            };
          }

        } catch (error) {

          console.error(
            `[JEV] Shared Memory context failed ` +
            `request=${req.requestId}:`,
            error?.message ||
              "unknown error"
          );


          return res.status(502).json({

            ok: false,

            error:
              "Unable to retrieve requested Shared Memory context",

            requestId:
              req.requestId
          });
        }
      }


      const result =
        await evaluateMarketState(
          evaluationState
        );


      return res.json({

        ok: true,

        requestId:
          req.requestId,

        result
      });

    } catch (error) {

      console.error(
        `[JEV] Evaluation failed ` +
        `request=${req.requestId}:`,
        error?.message ||
          "unknown error"
      );


      return res.status(502).json({

        ok: false,

        error:
          "Jev evaluation failed",

        requestId:
          req.requestId
      });
    }
  }
);


// ============================================================
// GET ONE MEMORY
// ============================================================

app.get(
  "/api/memory/:id",
  async (req, res) => {

    try {

      const memory =
        await getSharedMemory(
          req.params.id
        );


      if (!memory) {

        return res.status(404).json({

          ok: false,

          error:
            "Memory not found",

          requestId:
            req.requestId
        });
      }


      return res.json({

        ok: true,

        requestId:
          req.requestId,

        readOnly:
          true,

        memory
      });

    } catch (error) {

      console.error(
        `[MEMORY] Read failed ` +
        `request=${req.requestId}:`,
        error?.message ||
          "unknown error"
      );


      return res.status(502).json({

        ok: false,

        error:
          "Unable to read Shared Memory",

        requestId:
          req.requestId
      });
    }
  }
);


// ============================================================
// SEARCH MEMORY
// ============================================================

app.get(
  "/api/memory/search",
  async (req, res) => {

    try {

      const query =
        req.query.q;


      if (
        typeof query !== "string" ||
        !query.trim()
      ) {

        return res.status(400).json({

          ok: false,

          error:
            "q query parameter is required",

          requestId:
            req.requestId
        });
      }


      if (
        query.length >
        MAX_MEMORY_QUERY_LENGTH
      ) {

        return res.status(400).json({

          ok: false,

          error:
            "Search query is too long",

          requestId:
            req.requestId
        });
      }


      const results =
        await searchSharedMemory(
          query,
          {
            limit:
              req.query.limit,

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

        requestId:
          req.requestId,

        readOnly:
          true,

        count:
          results.length,

        results
      });

    } catch (error) {

      console.error(
        `[MEMORY] Search failed ` +
        `request=${req.requestId}:`,
        error?.message ||
          "unknown error"
      );


      return res.status(502).json({

        ok: false,

        error:
          "Shared Memory search failed",

        requestId:
          req.requestId
      });
    }
  }
);


// ============================================================
// RECENT MEMORY
// ============================================================

app.get(
  "/api/memory/recent",
  async (req, res) => {

    try {

      const memories =
        await getRecentMemories({
          limit:
            req.query.limit,

          includeArchived:
            req.query.includeArchived ===
            "true"
        });


      return res.json({

        ok: true,

        requestId:
          req.requestId,

        readOnly:
          true,

        count:
          memories.length,

        memories
      });

    } catch (error) {

      console.error(
        `[MEMORY] Recent memory failed ` +
        `request=${req.requestId}:`,
        error?.message ||
          "unknown error"
      );


      return res.status(502).json({

        ok: false,

        error:
          "Unable to read recent Shared Memory",

        requestId:
          req.requestId
      });
    }
  }
);


// ============================================================
// MEMORY STATISTICS
// ============================================================

app.get(
  "/api/memory/stats",
  async (req, res) => {

    try {

      const stats =
        await getSharedMemoryStats();


      return res.json({

        ok: true,

        requestId:
          req.requestId,

        readOnly:
          true,

        stats
      });

    } catch (error) {

      console.error(
        `[MEMORY] Stats failed ` +
        `request=${req.requestId}:`,
        error?.message ||
          "unknown error"
      );


      return res.status(502).json({

        ok: false,

        error:
          "Unable to read Shared Memory statistics",

        requestId:
          req.requestId
      });
    }
  }
);


// ============================================================
// BUILD MEMORY CONTEXT
// ============================================================

app.post(
  "/api/memory/context",
  async (req, res) => {

    try {

      const body =
        req.body;


      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body)
      ) {

        return res.status(400).json({

          ok: false,

          error:
            "Request body must be an object",

          requestId:
            req.requestId
        });
      }


      if (
        !Array.isArray(
          body.queries
        )
      ) {

        return res.status(400).json({

          ok: false,

          error:
            "queries must be an array",

          requestId:
            req.requestId
        });
      }


      if (
        body.queries.length >
        MAX_MEMORY_QUERIES
      ) {

        return res.status(400).json({

          ok: false,

          error:
            `queries cannot contain more than ` +
            `${MAX_MEMORY_QUERIES} items`,

          requestId:
            req.requestId
        });
      }


      const context =
        await buildJevMemoryContext(
          body.queries,
          {
            limit:
              Math.min(
                Number(body.limit) || 10,
                10
              ),

            category:
              body.category,

            source_ai:
              body.source_ai,

            related_project:
              body.related_project,

            status:
              body.status || "ACTIVE"
          }
        );


      return res.json({

        ok: true,

        requestId:
          req.requestId,

        readOnly:
          true,

        context
      });

    } catch (error) {

      console.error(
        `[MEMORY] Context failed ` +
        `request=${req.requestId}:`,
        error?.message ||
          "unknown error"
      );


      return res.status(502).json({

        ok: false,

        error:
          "Unable to build Jev memory context",

        requestId:
          req.requestId
      });
    }
  }
);


// ============================================================
// MEMORY SNAPSHOT
// ============================================================

app.post(
  "/api/memory/snapshot",
  async (req, res) => {

    try {

      const body =
        req.body || {};


      const queries =
        Array.isArray(
          body.queries
        )
          ? body.queries
          : [];


      if (
        queries.length >
        MAX_MEMORY_QUERIES
      ) {

        return res.status(400).json({

          ok: false,

          error:
            `Too many memory queries`,

          requestId:
            req.requestId
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

        requestId:
          req.requestId,

        readOnly:
          true,

        snapshot
      });

    } catch (error) {

      console.error(
        `[MEMORY] Snapshot failed ` +
        `request=${req.requestId}:`,
        error?.message ||
          "unknown error"
      );


      return res.status(502).json({

        ok: false,

        error:
          "Unable to build memory snapshot",

        requestId:
          req.requestId
      });
    }
  }
);


// ============================================================
// MEMORY CONNECTION HEALTH
// ============================================================

app.get(
  "/api/memory/health",
  async (req, res) => {

    try {

      const result =
        await checkSharedMemoryConnection();


      return res.status(
        result.ok ? 200 : 503
      ).json({

        ok:
          result.ok,

        requestId:
          req.requestId,

        sharedMemory:
          result
      });

    } catch {

      return res.status(503).json({

        ok: false,

        requestId:
          req.requestId,

        sharedMemory: {

          ok:
            false,

          configured:
            false,

          connected:
            false,

          readOnly:
            true
        }
      });
    }
  }
);


// ============================================================
// BLOCK UNKNOWN API ROUTES
// ============================================================

app.use(
  "/api",
  (req, res) => {

    res.status(404).json({

      ok: false,

      error:
        "API endpoint not found",

      requestId:
        req.requestId
    });
  }
);


// ============================================================
// JSON / REQUEST ERROR HANDLER
// ============================================================

app.use(
  (error, req, res, next) => {

    if (
      error?.type ===
      "entity.too.large"
    ) {

      return res.status(413).json({

        ok: false,

        error:
          "Request body is too large",

        requestId:
          req.requestId
      });
    }


    if (
      error instanceof SyntaxError &&
      error.status === 400 &&
      "body" in error
    ) {

      return res.status(400).json({

        ok: false,

        error:
          "Invalid JSON",

        requestId:
          req.requestId
      });
    }


    return next(error);
  }
);


// ============================================================
// GLOBAL ERROR HANDLER
// ============================================================

app.use(
  (error, req, res, next) => {

    console.error(
      `[SERVER] Unhandled error ` +
      `request=${req.requestId}:`,
      error?.message ||
        "unknown error"
    );


    if (
      res.headersSent
    ) {
      return next(error);
    }


    return res.status(500).json({

      ok: false,

      error:
        "Internal server error",

      requestId:
        req.requestId
    });
  }
);


// ============================================================
// START SERVER
// ============================================================

const server =
  app.listen(
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
        "[SECURITY] Evaluation enabled: true"
      );

      console.log(
        "[SECURITY] Trade execution: false"
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

let shuttingDown =
  false;


function shutdown(
  signal
) {

  if (
    shuttingDown
  ) {
    return;
  }

  shuttingDown =
    true;


  console.log(
    `[SERVER] ${signal} received.`
  );


  server.close(
    () => {

      console.log(
        "[SERVER] Shutdown complete."
      );

      process.exit(0);
    }
  );


  setTimeout(
    () => {

      console.error(
        "[SERVER] Forced shutdown."
      );

      process.exit(1);

    },
    10000
  ).unref();
}


process.on(
  "SIGTERM",
  () =>
    shutdown("SIGTERM")
);

process.on(
  "SIGINT",
  () =>
    shutdown("SIGINT")
);
