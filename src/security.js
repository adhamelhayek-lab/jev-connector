// Jev Connector
// Security Layer V2.0
//
// Purpose:
// - Protect every /api endpoint
// - Authenticate trusted AI Hub services
// - Compare API secrets safely
// - Reject malformed authentication
// - Never expose or log secrets
// - Attach authenticated client information to requests
// - Add request IDs and lightweight abuse protection
// - Fail closed when security is misconfigured
//
// IMPORTANT:
// JEV_API_KEY must exist only in the server environment.
// Never commit the real key to GitHub.
//
// Security boundary:
// - Authentication happens here.
// - Trading authorization does NOT happen here.
// - Wallet permissions do NOT happen here.
// - Risk controls remain separate and higher priority.

import crypto from "node:crypto";

const AUTH_SCHEME = "Bearer";
const MAX_TOKEN_LENGTH = 512;
const MAX_CLIENT_ID_LENGTH = 100;
const PUBLIC_CLIENT_ID = "jev-connector";
const REQUEST_ID_HEADER = "x-request-id";

// Lightweight in-memory authentication throttling.
// This is intentionally not a replacement for a production gateway/WAF.
const FAILURE_WINDOW_MS = 60_000;
const MAX_FAILURES_PER_WINDOW = 20;
const failureBuckets = new Map();

function getApiKey() {
  return typeof process.env.JEV_API_KEY === "string"
    ? process.env.JEV_API_KEY.trim()
    : "";
}

/**
 * Compare two secrets without exposing timing information.
 */
function safeCompare(left, right) {
  if (typeof left !== "string" || typeof right !== "string") {
    return false;
  }

  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

/**
 * Generate a non-secret request identifier.
 */
function createRequestId() {
  return crypto.randomUUID();
}

/**
 * Get a bounded request identifier supplied by an upstream service.
 * Invalid values are replaced with a fresh ID.
 */
function getRequestId(req) {
  const supplied = req.get(REQUEST_ID_HEADER);

  if (
    typeof supplied === "string" &&
    /^[A-Za-z0-9._:-]{1,128}$/.test(supplied)
  ) {
    return supplied;
  }

  return createRequestId();
}

/**
 * Extract a Bearer token from Authorization.
 *
 * Returns null for malformed or missing headers.
 */
function getBearerToken(req) {
  const header = req.get("authorization");

  if (typeof header !== "string" || header.length === 0) {
    return null;
  }

  const match = header.match(/^Bearer[ \t]+([^\s]+)$/i);

  if (!match) {
    return null;
  }

  const token = match[1].trim();

  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return null;
  }

  return token;
}

/**
 * Informational client identifier.
 * It is NEVER used as authentication.
 */
function getClientId(req) {
  const client = req.get("x-ai-client");

  if (typeof client !== "string" || client.trim() === "") {
    return "unknown";
  }

  return client.trim().slice(0, MAX_CLIENT_ID_LENGTH);
}

/**
 * Use a coarse key for throttling failed authentication attempts.
 * Prefer an upstream proxy/IP value when available.
 */
function getFailureKey(req) {
  const forwarded = req.get("x-forwarded-for");

  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim().slice(0, 100);
  }

  return req.ip || "unknown";
}

function isRateLimited(req) {
  const key = getFailureKey(req);
  const current = Date.now();
  const bucket = failureBuckets.get(key);

  if (!bucket || current - bucket.startedAt >= FAILURE_WINDOW_MS) {
    failureBuckets.set(key, {
      startedAt: current,
      failures: 0
    });
    return false;
  }

  return bucket.failures >= MAX_FAILURES_PER_WINDOW;
}

function recordAuthFailure(req) {
  const key = getFailureKey(req);
  const current = Date.now();
  const bucket = failureBuckets.get(key);

  if (!bucket || current - bucket.startedAt >= FAILURE_WINDOW_MS) {
    failureBuckets.set(key, {
      startedAt: current,
      failures: 1
    });
  } else {
    bucket.failures += 1;
  }
}

/**
 * Periodically remove expired throttle entries.
 * Keeps the in-memory map bounded during normal operation.
 */
function cleanupFailureBuckets() {
  const cutoff = Date.now() - FAILURE_WINDOW_MS;

  for (const [key, bucket] of failureBuckets) {
    if (bucket.startedAt < cutoff) {
      failureBuckets.delete(key);
    }
  }
}

const cleanupTimer = setInterval(
  cleanupFailureBuckets,
  FAILURE_WINDOW_MS
);

if (typeof cleanupTimer.unref === "function") {
  cleanupTimer.unref();
}

/**
 * Attach a request ID to every response.
 * This does not authenticate the request.
 */
export function attachRequestId(req, res, next) {
  const requestId = getRequestId(req);

  req.jevRequestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);

  return next();
}

/**
 * Authentication middleware.
 */
export function requireJevAuth(req, res, next) {
  const apiKey = getApiKey();

  // Always create a request ID before returning an error.
  const requestId = req.jevRequestId || getRequestId(req);
  req.jevRequestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);

  // Fail closed if the server is not configured.
  if (!apiKey) {
    console.error("[SECURITY] JEV_API_KEY is not configured.");

    return res.status(503).json({
      ok: false,
      error: "Jev authentication is not configured",
      requestId
    });
  }

  if (isRateLimited(req)) {
    return res.status(429).json({
      ok: false,
      error: "Too many authentication attempts",
      requestId
    });
  }

  const token = getBearerToken(req);

  if (!token || !safeCompare(token, apiKey)) {
    recordAuthFailure(req);

    // Deliberately keep missing and incorrect credentials indistinguishable.
    return res.status(401).json({
      ok: false,
      error: "Invalid authentication",
      requestId
    });
  }

  // Authentication succeeded.
  // No secret is attached to the request.
  req.jevAuth = {
    authenticated: true,
    service: PUBLIC_CLIENT_ID,
    client: getClientId(req),
    requestId
  };

  return next();
}

/**
 * Check whether authentication is configured.
 * Never returns the secret.
 */
export function isAuthConfigured() {
  return getApiKey().length > 0;
}

/**
 * Return safe authentication metadata.
 */
export function getAuthStatus() {
  return {
    configured: isAuthConfigured(),
    scheme: AUTH_SCHEME,
    service: PUBLIC_CLIENT_ID,
    tokenMaxLength: MAX_TOKEN_LENGTH,
    failureLimitPerMinute: MAX_FAILURES_PER_WINDOW
  };
}

/**
 * Clear the local authentication throttle state.
 * Useful for controlled tests or server lifecycle management.
 */
export function resetSecurityRuntime() {
  failureBuckets.clear();
}

/**
 * Default export for convenient middleware imports.
 */
export default {
  attachRequestId,
  requireJevAuth,
  isAuthConfigured,
  getAuthStatus,
  resetSecurityRuntime
};
