// shared-memory.js
// Jev Shared Memory Layer
// V2.0.0
//
// Purpose:
// - Shared memory for Jev
// - Safe local fallback
// - Optional remote Shared Memory Hub
// - Search memories
// - Recent memories
// - Jev memory context
// - Connection/status diagnostics
// - Never expose secrets
//
// IMPORTANT:
// This module does NOT contain exchange credentials.
// It does NOT execute trades.

const MEMORY_SERVICE_URL =
  typeof process.env.SHARED_MEMORY_URL === "string"
    ? process.env.SHARED_MEMORY_URL.trim().replace(/\/+$/, "")
    : "";

const MEMORY_API_KEY =
  typeof process.env.SHARED_MEMORY_API_KEY === "string"
    ? process.env.SHARED_MEMORY_API_KEY.trim()
    : "";

const MAX_MEMORIES = 1000;

const memoryStore = [];

const runtime = {
  configured: Boolean(MEMORY_SERVICE_URL),
  connected: false,
  lastConnectionCheck: null,
  lastError: null,
  lastWriteAt: null,
  totalReads: 0,
  totalWrites: 0,
  remoteReads: 0,
  remoteWrites: 0
};

/* =========================================================
   HELPERS
   ========================================================= */

function safeString(value, fallback = "") {
  return typeof value === "string"
    ? value.trim()
    : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function createMemoryId() {
  return `jev-mem-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function normalizeMemory(input = {}) {
  const source =
    input &&
    typeof input === "object" &&
    !Array.isArray(input)
      ? input
      : {};

  return {
    id:
      safeString(source.id) ||
      createMemoryId(),

    timestamp:
      safeString(source.timestamp) ||
      nowIso(),

    source:
      safeString(source.source, "jev"),

    type:
      safeString(source.type, "observation"),

    symbol:
      safeString(source.symbol).toUpperCase() ||
      null,

    importance:
      Number.isFinite(Number(source.importance))
        ? Math.max(
            0,
            Math.min(
              1,
              Number(source.importance)
            )
          )
        : 0.5,

    content:
      safeString(source.content),

    metadata:
      source.metadata &&
      typeof source.metadata === "object" &&
      !Array.isArray(source.metadata)
        ? source.metadata
        : {}
  };
}

function trimStore() {
  while (
    memoryStore.length >
    MAX_MEMORIES
  ) {
    memoryStore.shift();
  }
}

function headers() {
  const result = {
    "Content-Type": "application/json"
  };

  if (MEMORY_API_KEY) {
    result.Authorization =
      `Bearer ${MEMORY_API_KEY}`;
  }

  return result;
}

/* =========================================================
   LOCAL MEMORY
   ========================================================= */

function saveLocalMemory(memory) {
  const normalized =
    normalizeMemory(memory);

  if (!normalized.content) {
    return null;
  }

  memoryStore.push(normalized);
  trimStore();

  runtime.totalWrites += 1;
  runtime.lastWriteAt = nowIso();

  return normalized;
}

function searchLocalMemories(
  query,
  options = {}
) {
  const text =
    safeString(query).toLowerCase();

  const limit =
    Number.isFinite(Number(options.limit))
      ? Math.max(
          1,
          Math.min(
            100,
            Number(options.limit)
          )
        )
      : 20;

  if (!text) {
    return memoryStore
      .slice(-limit)
      .reverse();
  }

  const terms =
    text
      .split(/\s+/)
      .filter(Boolean);

  return memoryStore
    .map((memory) => {
      const haystack =
        `${memory.content} ${
          memory.symbol || ""
        } ${
          memory.type || ""
        }`.toLowerCase();

      let score = 0;

      for (const term of terms) {
        if (haystack.includes(term)) {
          score += 1;
        }
      }

      score +=
        memory.importance * 0.5;

      return {
        memory,
        score
      };
    })
    .filter((item) => item.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score
    )
    .slice(0, limit)
    .map((item) => item.memory);
}

/* =========================================================
   REMOTE MEMORY
   ========================================================= */

async function remoteRequest(
  path,
  options = {}
) {
  if (!MEMORY_SERVICE_URL) {
    return null;
  }

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      5000
    );

  try {
    const response =
      await fetch(
        `${MEMORY_SERVICE_URL}${path}`,
        {
          ...options,
          headers: {
            ...headers(),
            ...(options.headers || {})
          },
          signal:
            controller.signal
        }
      );

    if (!response.ok) {
      throw new Error(
        `Shared Memory HTTP ${response.status}`
      );
    }

    runtime.connected = true;
    runtime.lastConnectionCheck =
      nowIso();
    runtime.lastError = null;

    return await response.json();
  } catch (error) {
    runtime.connected = false;
    runtime.lastConnectionCheck =
      nowIso();

    runtime.lastError =
      error instanceof Error
        ? error.message
        : "Unknown shared-memory error";

    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/* =========================================================
   CONNECTION
   ========================================================= */

export async function checkSharedMemoryConnection() {
  if (!MEMORY_SERVICE_URL) {
    runtime.configured = false;
    runtime.connected = false;
    runtime.lastConnectionCheck =
      nowIso();

    return {
      configured: false,
      connected: false,
      mode: "local-fallback",
      reason:
        "SHARED_MEMORY_URL is not configured."
    };
  }

  const result =
    await remoteRequest("/health");

  if (!result) {
    return {
      configured: true,
      connected: false,
      mode: "remote",
      reason:
        runtime.lastError ||
        "Shared Memory service is unavailable."
    };
  }

  return {
    configured: true,
    connected: true,
    mode: "remote",
    reason: null
  };
}

/* =========================================================
   WRITE
   ========================================================= */

export async function getSharedMemory(
  options = {}
) {
  runtime.totalReads += 1;

  const limit =
    Number.isFinite(Number(options.limit))
      ? Math.max(
          1,
          Math.min(
            100,
            Number(options.limit)
          )
        )
      : 50;

  if (MEMORY_SERVICE_URL) {
    const result =
      await remoteRequest(
        `/memories?limit=${limit}`
      );

    if (
      result &&
      Array.isArray(result.memories)
    ) {
      runtime.remoteReads += 1;

      return result.memories.map(
        normalizeMemory
      );
    }
  }

  return memoryStore
    .slice(-limit)
    .reverse();
}

export async function saveSharedMemory(
  memory
) {
  const normalized =
    normalizeMemory(memory);

  if (!normalized.content) {
    throw new Error(
      "Memory content is required."
    );
  }

  if (MEMORY_SERVICE_URL) {
    const result =
      await remoteRequest(
        "/memories",
        {
          method: "POST",
          body: JSON.stringify(
            normalized
          )
        }
      );

    if (result) {
      runtime.remoteWrites += 1;
      runtime.totalWrites += 1;
      runtime.lastWriteAt =
        nowIso();

      return (
        result.memory ||
        normalized
      );
    }
  }

  return saveLocalMemory(
    normalized
  );
}

/* =========================================================
   SEARCH
   ========================================================= */

export async function searchSharedMemory(
  query,
  options = {}
) {
  runtime.totalReads += 1;

  const text =
    safeString(query);

  if (!text) {
    return [];
  }

  const limit =
    Number.isFinite(Number(options.limit))
      ? Math.max(
          1,
          Math.min(
            100,
            Number(options.limit)
          )
        )
      : 20;

  if (MEMORY_SERVICE_URL) {
    const encoded =
      encodeURIComponent(text);

    const result =
      await remoteRequest(
        `/memories/search?q=${encoded}&limit=${limit}`
      );

    if (
      result &&
      Array.isArray(result.memories)
    ) {
      runtime.remoteReads += 1;

      return result.memories.map(
        normalizeMemory
      );
    }
  }

  return searchLocalMemories(
    text,
    { limit }
  );
}

/* =========================================================
   RECENT MEMORIES
   ========================================================= */

export async function getRecentMemories(
  limit = 20
) {
  const safeLimit =
    Math.max(
      1,
      Math.min(
        100,
        Number(limit) || 20
      )
    );

  return getSharedMemory({
    limit: safeLimit
  });
}

/* =========================================================
   JEV MEMORY CONTEXT
   ========================================================= */

export async function buildJevMemoryContext(
  state = {},
  options = {}
) {
  const symbol =
    safeString(
      state?.symbol ??
      state?.market?.symbol
    ).toUpperCase();

  const query =
    symbol
      ? `Jev ${symbol} trading market risk accumulation`
      : "Jev trading market risk accumulation";

  const memories =
    await searchSharedMemory(
      query,
      {
        limit:
          options.limit ?? 10
      }
    );

  return {
    symbol: symbol || null,

    memories,

    count:
      memories.length,

    generatedAt:
      nowIso()
  };
}

/* =========================================================
   SNAPSHOT
   ========================================================= */

export async function getJevMemorySnapshot() {
  const recent =
    await getRecentMemories(20);

  return {
    engine: "Jev",
    generatedAt: nowIso(),

    memories: recent,

    stats:
      getSharedMemoryStats(),

    status:
      getSharedMemoryStatus()
  };
}

/* =========================================================
   STATS
   ========================================================= */

export function getSharedMemoryStats() {
  return {
    localMemoryCount:
      memoryStore.length,

    totalReads:
      runtime.totalReads,

    totalWrites:
      runtime.totalWrites,

    remoteReads:
      runtime.remoteReads,

    remoteWrites:
      runtime.remoteWrites,

    lastWriteAt:
      runtime.lastWriteAt
  };
}

/* =========================================================
   STATUS
   ========================================================= */

export function getSharedMemoryStatus() {
  return {
    configured:
      Boolean(
        MEMORY_SERVICE_URL
      ),

    connected:
      runtime.connected,

    mode:
      MEMORY_SERVICE_URL
        ? "remote-with-local-fallback"
        : "local-fallback",

    readOnly:
      false,

    lastConnectionCheck:
      runtime.lastConnectionCheck,

    lastError:
      runtime.lastError,

    memoryCount:
      memoryStore.length
  };
}

/* =========================================================
   DEFAULT EXPORT
   ========================================================= */

export default {
  getSharedMemory,
  saveSharedMemory,
  searchSharedMemory,
  getRecentMemories,
  getSharedMemoryStats,
  buildJevMemoryContext,
  getJevMemorySnapshot,
  checkSharedMemoryConnection,
  getSharedMemoryStatus
};
