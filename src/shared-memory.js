// Jev Connector
// Shared Memory Client V1.1
//
// Purpose:
// - Read relevant information from AI Hub Shared Memory
// - Provide controlled memory context to Jev
// - Keep Shared Memory access strictly read-only
// - Protect Jev from malformed/unbounded memory responses
// - Prepare the connector for future Trader integration
//
// SECURITY BOUNDARY
// -----------------
// This module can ONLY perform GET requests.
//
// It cannot:
// - create memories
// - update memories
// - archive memories
// - mark conflicts
// - request approvals
// - delete memories
// - access wallets
// - access private keys
// - execute trades
//
// Jev evaluates.
// Shared Memory stores.
// Risk controls authorize.
// Execution executes.
//
// Environment:
// MEMORY_API_URL
// MEMORY_API_KEY
//
// IMPORTANT:
// Never commit MEMORY_API_KEY to GitHub.


// ============================================================
// CONFIGURATION
// ============================================================

const MEMORY_API_URL =
  process.env.MEMORY_API_URL || "";

const MEMORY_API_KEY =
  process.env.MEMORY_API_KEY || "";

const CLIENT_ID =
  "jev-connector";

const REQUEST_TIMEOUT_MS =
  readPositiveInteger(
    process.env.MEMORY_REQUEST_TIMEOUT_MS,
    10000,
    1000,
    30000
  );

const MAX_RESULTS =
  50;

const MAX_QUERY_LENGTH =
  500;

const MAX_RESPONSE_BYTES =
  2 * 1024 * 1024;

const MAX_RETRIES =
  2;


// ============================================================
// INTEGER CONFIGURATION HELPER
// ============================================================

function readPositiveInteger(
  value,
  fallback,
  minimum,
  maximum
) {
  const parsed =
    Number(value);

  if (
    !Number.isFinite(parsed) ||
    parsed < minimum
  ) {
    return fallback;
  }

  return Math.min(
    maximum,
    Math.floor(parsed)
  );
}


// ============================================================
// CONFIGURATION STATUS
// ============================================================

export function isSharedMemoryConfigured() {
  return Boolean(
    MEMORY_API_URL &&
    MEMORY_API_KEY
  );
}


export function getSharedMemoryStatus() {
  return {
    configured:
      isSharedMemoryConfigured(),

    client:
      CLIENT_ID,

    readOnly:
      true,

    baseUrlConfigured:
      Boolean(MEMORY_API_URL),

    apiKeyConfigured:
      Boolean(MEMORY_API_KEY),

    maxResults:
      MAX_RESULTS,

    timeoutMs:
      REQUEST_TIMEOUT_MS,

    retries:
      MAX_RETRIES
  };
}


// ============================================================
// BASE URL
// ============================================================

function getBaseUrl() {
  if (!MEMORY_API_URL) {
    throw new Error(
      "MEMORY_API_URL is not configured"
    );
  }

  let url;

  try {
    url =
      new URL(
        MEMORY_API_URL
      );
  } catch {
    throw new Error(
      "MEMORY_API_URL is invalid"
    );
  }

  const isLocal =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1";

  if (
    url.protocol !== "https:" &&
    !isLocal
  ) {
    throw new Error(
      "MEMORY_API_URL must use HTTPS"
    );
  }

  return url.toString()
    .replace(/\/+$/, "");
}


// ============================================================
// INPUT VALIDATION
// ============================================================

function validateQuery(query) {
  if (
    typeof query !== "string"
  ) {
    throw new TypeError(
      "Shared Memory query must be a string"
    );
  }

  const cleaned =
    query.trim();

  if (!cleaned) {
    throw new Error(
      "Shared Memory query cannot be empty"
    );
  }

  if (
    cleaned.length >
    MAX_QUERY_LENGTH
  ) {
    throw new Error(
      `Shared Memory query exceeds ${MAX_QUERY_LENGTH} characters`
    );
  }

  return cleaned;
}


function validateId(id) {
  if (
    typeof id !== "string"
  ) {
    throw new TypeError(
      "Memory ID must be a string"
    );
  }

  const cleaned =
    id.trim();

  if (!cleaned) {
    throw new Error(
      "Memory ID cannot be empty"
    );
  }

  if (
    cleaned.length > 200
  ) {
    throw new Error(
      "Memory ID is too long"
    );
  }

  return cleaned;
}


// ============================================================
// LIMIT HELPER
// ============================================================

function normalizeLimit(
  value,
  fallback = 20
) {
  const parsed =
    Number(value);

  if (
    !Number.isFinite(parsed)
  ) {
    return fallback;
  }

  return Math.min(
    MAX_RESULTS,
    Math.max(
      1,
      Math.floor(parsed)
    )
  );
}


// ============================================================
// RESPONSE VALIDATION
// ============================================================

function validateResponseSize(
  contentLength
) {
  if (
    !contentLength
  ) {
    return;
  }

  const bytes =
    Number(contentLength);

  if (
    Number.isFinite(bytes) &&
    bytes > MAX_RESPONSE_BYTES
  ) {
    throw new Error(
      "Shared Memory response is too large"
    );
  }
}


// ============================================================
// RETRY POLICY
// ============================================================
//
// Only retry safe GET requests.
// Never retry mutations here because this client
// does not permit mutations in the first place.

function shouldRetry(
  status
) {
  return (
    status === 408 ||
    status === 429 ||
    status >= 500
  );
}


function retryDelay(
  attempt
) {
  /*
   * Small exponential backoff:
   * attempt 0 -> 250ms
   * attempt 1 -> 500ms
   */

  return (
    250 *
    Math.pow(
      2,
      attempt
    )
  );
}


async function sleep(
  milliseconds
) {
  await new Promise(
    resolve =>
      setTimeout(
        resolve,
        milliseconds
      )
  );
}


// ============================================================
// HTTP CLIENT
// ============================================================

async function memoryRequest(
  path
) {
  if (
    !isSharedMemoryConfigured()
  ) {
    throw new Error(
      "Shared Memory client is not configured"
    );
  }

  const baseUrl =
    getBaseUrl();

  const url =
    new URL(
      path,
      `${baseUrl}/`
    );


  /*
   * Hard read-only boundary.
   *
   * This function intentionally has no
   * method argument.
   *
   * Every request is GET.
   */

  for (
    let attempt = 0;
    attempt <= MAX_RETRIES;
    attempt += 1
  ) {

    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () => {
          controller.abort();
        },
        REQUEST_TIMEOUT_MS
      );


    try {

      const response =
        await fetch(
          url,
          {
            method: "GET",

            headers: {
              Accept:
                "application/json",

              Authorization:
                `Bearer ${MEMORY_API_KEY}`,

              "x-ai-client":
                CLIENT_ID
            },

            signal:
              controller.signal
          }
        );


      validateResponseSize(
        response.headers.get(
          "content-length"
        )
      );


      /*
       * Retry temporary server/rate-limit
       * responses.
       */

      if (
        !response.ok &&
        shouldRetry(
          response.status
        ) &&
        attempt < MAX_RETRIES
      ) {

        await sleep(
          retryDelay(
            attempt
          )
        );

        continue;
      }


      let body;

      try {
        body =
          await response.json();
      } catch {
        throw new Error(
          "Shared Memory returned invalid JSON"
        );
      }


      if (
        !response.ok
      ) {

        const message =
          typeof body?.error === "string"
            ? body.error
            : typeof body?.error?.message === "string"
              ? body.error.message
              : `Shared Memory request failed with HTTP ${response.status}`;

        throw new Error(
          message
        );
      }


      return body;

    } catch (error) {

      if (
        error?.name ===
        "AbortError"
      ) {

        if (
          attempt < MAX_RETRIES
        ) {
          await sleep(
            retryDelay(
              attempt
            )
          );

          continue;
        }

        throw new Error(
          "Shared Memory request timed out"
        );
      }


      /*
       * Network failures are safe to retry
       * because this client only performs GET.
       */

      if (
        attempt < MAX_RETRIES &&
        !error?.message?.includes(
          "returned invalid JSON"
        )
      ) {

        await sleep(
          retryDelay(
            attempt
          )
        );

        continue;
      }


      throw error;

    } finally {

      clearTimeout(
        timeout
      );
    }
  }


  throw new Error(
    "Shared Memory request failed"
  );
}


// ============================================================
// GET ONE MEMORY
// ============================================================

export async function getSharedMemory(
  id
) {
  const memoryId =
    validateId(id);

  const result =
    await memoryRequest(
      `/api/memories/${encodeURIComponent(memoryId)}`
    );

  if (
    !result ||
    typeof result !== "object"
  ) {
    return null;
  }

  return (
    result.memory ||
    null
  );
}


// ============================================================
// SEARCH MEMORY
// ============================================================

export async function searchSharedMemory(
  query,
  options = {}
) {
  const cleanedQuery =
    validateQuery(query);

  const params =
    new URLSearchParams();

  params.set(
    "q",
    cleanedQuery
  );


  /*
   * The Shared Memory server currently
   * defaults search to ACTIVE.
   *
   * We make that explicit for Jev.
   */

  params.set(
    "status",
    typeof options.status === "string" &&
    options.status.trim()
      ? options.status.trim()
      : "ACTIVE"
  );


  if (
    typeof options.category === "string" &&
    options.category.trim()
  ) {
    params.set(
      "category",
      options.category.trim()
    );
  }


  if (
    typeof options.source_ai === "string" &&
    options.source_ai.trim()
  ) {
    params.set(
      "source_ai",
      options.source_ai.trim()
    );
  }


  if (
    typeof options.related_project === "string" &&
    options.related_project.trim()
  ) {
    params.set(
      "related_project",
      options.related_project.trim()
    );
  }


  const limit =
    normalizeLimit(
      options.limit,
      20
    );

  params.set(
    "limit",
    String(limit)
  );


  const result =
    await memoryRequest(
      `/api/search?${params.toString()}`
    );


  if (
    !Array.isArray(
      result?.results
    )
  ) {
    return [];
  }


  /*
   * Enforce our own maximum even if the
   * upstream server changes its limits.
   */

  return result.results
    .slice(
      0,
      MAX_RESULTS
    );
}


// ============================================================
// GET RECENT MEMORIES
// ============================================================

export async function getRecentMemories(
  options = {}
) {
  const limit =
    normalizeLimit(
      options.limit,
      20
    );


  const params =
    new URLSearchParams();

  params.set(
    "limit",
    String(limit)
  );


  if (
    options.includeArchived === true
  ) {
    params.set(
      "includeArchived",
      "true"
    );
  }


  const result =
    await memoryRequest(
      `/api/memories?${params.toString()}`
    );


  if (
    !Array.isArray(
      result?.memories
    )
  ) {
    return [];
  }


  return result.memories
    .slice(
      0,
      MAX_RESULTS
    );
}


// ============================================================
// MEMORY STATISTICS
// ============================================================

export async function getSharedMemoryStats() {
  const result =
    await memoryRequest(
      "/api/stats"
    );


  return (
    result?.stats ||
    null
  );
}


// ============================================================
// BUILD JEV MEMORY CONTEXT
// ============================================================
//
// Searches several topics and removes duplicate
// memories before returning them.
//
// Important:
// This function only retrieves memory.
// It does NOT evaluate the memory.
//
// Jev remains responsible for evaluation.

export async function buildJevMemoryContext(
  queries = [],
  options = {}
) {
  if (
    !Array.isArray(queries)
  ) {
    throw new TypeError(
      "queries must be an array"
    );
  }


  const cleanedQueries =
    queries
      .filter(
        query =>
          typeof query === "string"
      )
      .map(
        query =>
          query.trim()
      )
      .filter(Boolean)
      .slice(0, 10);


  if (
    cleanedQueries.length === 0
  ) {
    return {
      memories: [],
      count: 0,
      queries: []
    };
  }


  const memoryMap =
    new Map();


  /*
   * Sequential search deliberately keeps
   * pressure on the Shared Memory service low.
   */

  for (
    const query of cleanedQueries
  ) {

    const results =
      await searchSharedMemory(
        query,
        {
          ...options,
          limit:
            options.limit || 10
        }
      );


    for (
      const memory of results
    ) {

      if (
        memory &&
        typeof memory.id === "string"
      ) {

        memoryMap.set(
          memory.id,
          memory
        );
      }
    }


    /*
     * Stop once we have enough unique
     * memories for this evaluation.
     */

    if (
      memoryMap.size >=
      MAX_RESULTS
    ) {
      break;
    }
  }


  const memories =
    [...memoryMap.values()]
      .slice(
        0,
        MAX_RESULTS
      );


  return {
    memories,
    count:
      memories.length,
    queries:
      cleanedQueries
  };
}


// ============================================================
// JEV MEMORY SNAPSHOT
// ============================================================
//
// Provides a clearly-labelled read-only snapshot.
//
// No secrets are included.
// No API metadata is forwarded.

export async function getJevMemorySnapshot(
  queries = [],
  options = {}
) {
  const context =
    await buildJevMemoryContext(
      queries,
      options
    );


  return {
    source:
      "AI Hub Shared Memory",

    consumer:
      "jev-connector",

    access:
      "read-only",

    count:
      context.count,

    queries:
      context.queries,

    memories:
      context.memories
  };
}


// ============================================================
// CONNECTION CHECK
// ============================================================
//
// Returns operational status without returning
// internal error messages or credentials.

export async function checkSharedMemoryConnection() {
  if (
    !isSharedMemoryConfigured()
  ) {
    return {
      ok: false,
      configured: false,
      connected: false,
      readOnly: true
    };
  }


  try {

    const stats =
      await getSharedMemoryStats();


    return {
      ok: true,

      configured:
        true,

      connected:
        true,

      readOnly:
        true,

      statsAvailable:
        stats !== null
    };

  } catch {

    /*
     * Do not expose internal connection
     * details through this health result.
     */

    return {
      ok: false,

      configured:
        true,

      connected:
        false,

      readOnly:
        true,

      statsAvailable:
        false
    };
  }
}


// ============================================================
// DEFAULT EXPORT
// ============================================================
//
// Explicitly exposes only read operations.
//
// There is intentionally NO write API.

export default {
  getSharedMemory,
  searchSharedMemory,
  getRecentMemories,
  getSharedMemoryStats,
  buildJevMemoryContext,
  getJevMemorySnapshot,
  checkSharedMemoryConnection,
  isSharedMemoryConfigured,
  getSharedMemoryStatus
};
