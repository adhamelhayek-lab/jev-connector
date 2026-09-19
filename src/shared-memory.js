// shared-memory.js
// Jev Shared Memory V3.1.0
//
// Purpose:
// - Persistent Jev memory using Upstash Redis REST
// - Safe local fallback if Redis is unavailable
// - Search and recent-memory retrieval
// - Memory statistics and connection status
// - Robust memory-content normalization
// - Compatible with Jev Connector API
//
// Environment variables:
// - UPSTASH_REDIS_REST_URL
// - UPSTASH_REDIS_REST_TOKEN
// - SHARED_MEMORY_NAMESPACE (optional)

const REDIS_URL =
  process.env.UPSTASH_REDIS_REST_URL?.trim().replace(/\/+$/, "") || "";

const REDIS_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN?.trim() || "";

const NAMESPACE =
  process.env.SHARED_MEMORY_NAMESPACE?.trim() || "jev:memory";

const MEMORY_KEY = `${NAMESPACE}:items`;

const MAX_MEMORY_ITEMS = 1000;

const localMemory = [];

let lastConnectionCheck = null;
let lastError = null;
let lastKnownCount = 0;

function isConfigured() {
  return Boolean(REDIS_URL && REDIS_TOKEN);
}

function makeId() {
  return `mem_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function now() {
  return new Date().toISOString();
}

/**
 * Extract memory content from many compatible input formats.
 */
function extractContent(input) {
  if (typeof input === "string") {
    return input;
  }

  if (!input || typeof input !== "object") {
    return "";
  }

  const candidates = [
    input.content,
    input.text,
    input.message,
    input.value,
    input.memory,
    input.note,
    input.information,
    input.data,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }

    if (
      candidate !== null &&
      candidate !== undefined &&
      typeof candidate !== "string"
    ) {
      try {
        const serialized = JSON.stringify(candidate);

        if (serialized && serialized !== "{}" && serialized !== "null") {
          return serialized;
        }
      } catch {
        // Continue checking other fields.
      }
    }
  }

  return "";
}

/**
 * Normalize any supported memory input.
 */
function normalizeMemory(input = {}) {
  const content = extractContent(input);

  if (typeof input === "string") {
    return {
      id: makeId(),
      createdAt: now(),
      content,
      type: "text",
      tags: [],
      source: "jev",
      metadata: {},
    };
  }

  const safeInput =
    input && typeof input === "object"
      ? input
      : {};

  return {
    id: safeInput.id || makeId(),
    createdAt: safeInput.createdAt || now(),
    type: safeInput.type || "memory",
    content,
    tags: Array.isArray(safeInput.tags)
      ? safeInput.tags
      : [],
    source: safeInput.source || "jev",
    metadata:
      safeInput.metadata &&
      typeof safeInput.metadata === "object"
        ? safeInput.metadata
        : {},
  };
}

async function redisCommand(command) {
  if (!isConfigured()) {
    throw new Error("Upstash Redis is not configured");
  }

  const response = await fetch(REDIS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");

    throw new Error(
      `Upstash Redis HTTP ${response.status}${
        body ? `: ${body}` : ""
      }`
    );
  }

  const result = await response.json();

  if (result?.error) {
    throw new Error(String(result.error));
  }

  return result?.result;
}

async function pingRedis() {
  return await redisCommand(["PING"]);
}

/**
 * Save one memory.
 */
export async function saveSharedMemory(input) {
  const memory = normalizeMemory(input);

  // Do not silently save an empty memory.
  if (!memory.content || !String(memory.content).trim()) {
    return {
      ok: false,
      persistent: false,
      error: "Memory content is empty",
      memory: null,
    };
  }

  const encoded = JSON.stringify(memory);

  if (isConfigured()) {
    try {
      await redisCommand([
        "LPUSH",
        MEMORY_KEY,
        encoded,
      ]);

      await redisCommand([
        "LTRIM",
        MEMORY_KEY,
        0,
        MAX_MEMORY_ITEMS - 1,
      ]);

      lastError = null;
      lastConnectionCheck = now();

      const count = await redisCommand([
        "LLEN",
        MEMORY_KEY,
      ]);

      lastKnownCount = Number(count) || 0;

      return {
        ok: true,
        persistent: true,
        memory,
      };
    } catch (error) {
      lastError = error?.message || String(error);
    }
  }

  // Safe local fallback.
  localMemory.unshift(memory);

  if (localMemory.length > MAX_MEMORY_ITEMS) {
    localMemory.length = MAX_MEMORY_ITEMS;
  }

  lastKnownCount = localMemory.length;

  return {
    ok: true,
    persistent: false,
    fallback: true,
    memory,
  };
}

/**
 * Get recent memories.
 */
export async function getRecentMemories(limit = 20) {
  const safeLimit = Math.min(
    Math.max(Number(limit) || 20, 1),
    100
  );

  if (isConfigured()) {
    try {
      const result = await redisCommand([
        "LRANGE",
        MEMORY_KEY,
        0,
        safeLimit - 1,
      ]);

      const memories = Array.isArray(result)
        ? result
            .map((item) => {
              try {
                return JSON.parse(item);
              } catch {
                return null;
              }
            })
            .filter(Boolean)
        : [];

      lastError = null;
      lastConnectionCheck = now();

      return memories;
    } catch (error) {
      lastError = error?.message || String(error);
    }
  }

  return localMemory.slice(0, safeLimit);
}

/**
 * Get all available memory records.
 */
async function getAllMemories() {
  if (isConfigured()) {
    try {
      const result = await redisCommand([
        "LRANGE",
        MEMORY_KEY,
        0,
        MAX_MEMORY_ITEMS - 1,
      ]);

      const memories = Array.isArray(result)
        ? result
            .map((item) => {
              try {
                return JSON.parse(item);
              } catch {
                return null;
              }
            })
            .filter(Boolean)
        : [];

      lastError = null;
      lastConnectionCheck = now();

      return memories;
    } catch (error) {
      lastError = error?.message || String(error);
    }
  }

  return [...localMemory];
}

/**
 * Search memories.
 */
export async function searchSharedMemory(
  query,
  options = {}
) {
  const text = String(query || "")
    .trim()
    .toLowerCase();

  if (!text) {
    return [];
  }

  const limit = Math.min(
    Math.max(Number(options.limit) || 20, 1),
    100
  );

  const memories = await getAllMemories();

  const terms = text
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);

  const results = memories
    .map((memory) => {
      const searchable = [
        memory.content,
        memory.type,
        memory.source,
        ...(Array.isArray(memory.tags)
          ? memory.tags
          : []),
        JSON.stringify(memory.metadata || {}),
      ]
        .join(" ")
        .toLowerCase();

      let score = 0;

      for (const term of terms) {
        if (searchable.includes(term)) {
          score += 1;
        }
      }

      return {
        memory,
        score,
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }

      return String(b.memory.createdAt).localeCompare(
        String(a.memory.createdAt)
      );
    })
    .slice(0, limit);

  return results.map((item) => ({
    ...item.memory,
    score: item.score,
  }));
}

/**
 * Compatibility helper.
 */
export async function getSharedMemory(options = {}) {
  return await getRecentMemories(
    options.limit || 20
  );
}

/**
 * Build memory context for Jev.
 */
export async function buildJevMemoryContext(
  query,
  options = {}
) {
  const memories = await searchSharedMemory(
    query,
    {
      limit: options.limit || 10,
    }
  );

  if (!memories.length) {
    return "";
  }

  return memories
    .map((memory, index) => {
      const content =
        typeof memory.content === "string"
          ? memory.content
          : JSON.stringify(memory.content);

      return `[Memory ${index + 1}] ${content}`;
    })
    .join("\n");
}

/**
 * Return a complete Jev memory snapshot.
 */
export async function getJevMemorySnapshot() {
  const recent = await getRecentMemories(20);
  const stats = await getSharedMemoryStats();

  return {
    ok: true,
    stats,
    recent,
  };
}

/**
 * Get memory statistics.
 */
export async function getSharedMemoryStats() {
  if (isConfigured()) {
    try {
      const count = await redisCommand([
        "LLEN",
        MEMORY_KEY,
      ]);

      lastKnownCount = Number(count) || 0;
      lastError = null;

      return {
        ok: true,
        configured: true,
        persistent: true,
        mode: "upstash-redis",
        memoryCount: lastKnownCount,
        namespace: NAMESPACE,
        maxMemoryItems: MAX_MEMORY_ITEMS,
      };
    } catch (error) {
      lastError = error?.message || String(error);
    }
  }

  return {
    ok: true,
    configured: false,
    persistent: false,
    mode: "local-fallback",
    memoryCount: localMemory.length,
    namespace: NAMESPACE,
    maxMemoryItems: MAX_MEMORY_ITEMS,
  };
}

/**
 * Check Redis connection.
 */
export async function checkSharedMemoryConnection() {
  const checkedAt = now();

  if (!isConfigured()) {
    lastConnectionCheck = checkedAt;
    lastError = null;
    lastKnownCount = localMemory.length;

    return {
      ok: true,
      configured: false,
      connected: false,
      mode: "local-fallback",
      readOnly: false,
      checkedAt,
      error: null,
      memoryCount: localMemory.length,
    };
  }

  try {
    const result = await pingRedis();

    const count = await redisCommand([
      "LLEN",
      MEMORY_KEY,
    ]);

    lastConnectionCheck = checkedAt;
    lastError = null;
    lastKnownCount = Number(count) || 0;

    return {
      ok: true,
      configured: true,
      connected: true,
      mode: "upstash-redis",
      readOnly: false,
      checkedAt,
      ping: result,
      error: null,
      memoryCount: lastKnownCount,
    };
  } catch (error) {
    lastConnectionCheck = checkedAt;
    lastError = error?.message || String(error);

    return {
      ok: false,
      configured: true,
      connected: false,
      mode: "upstash-redis",
      readOnly: false,
      checkedAt,
      error: lastError,
      memoryCount: lastKnownCount,
    };
  }
}

/**
 * Get current memory status.
 */
export async function getSharedMemoryStatus() {
  const connection =
    await checkSharedMemoryConnection();

  return {
    configured: connection.configured,
    connected: connection.connected,
    mode: connection.mode,
    readOnly: connection.readOnly,
    lastConnectionCheck:
      lastConnectionCheck ||
      connection.checkedAt ||
      null,
    lastError:
      lastError ||
      connection.error ||
      null,
    memoryCount:
      connection.memoryCount ??
      lastKnownCount,
  };
}

export default {
  getSharedMemory,
  saveSharedMemory,
  searchSharedMemory,
  getRecentMemories,
  buildJevMemoryContext,
  getJevMemorySnapshot,
  getSharedMemoryStats,
  checkSharedMemoryConnection,
  getSharedMemoryStatus,
};
