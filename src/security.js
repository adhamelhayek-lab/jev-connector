// Jev Connector
// Security Layer V1.1
//
// Purpose:
// - Protect every /api endpoint
// - Authenticate trusted AI Hub services
// - Compare API secrets safely
// - Reject malformed authentication
// - Never expose or log secrets
// - Attach authenticated client information to requests
//
// IMPORTANT:
// JEV_API_KEY must exist only in the server environment.
// Never commit the real key to GitHub.
//
// Security boundary:
// - Authentication happens here.
// - Trading authorization does NOT happen here.
// - Wallet permissions do NOT happen here.
// - Risk controls must remain separate and higher priority.

import crypto from "node:crypto";

const API_KEY =
  typeof process.env.JEV_API_KEY === "string"
    ? process.env.JEV_API_KEY.trim()
    : "";

const AUTH_SCHEME = "Bearer";

const MAX_TOKEN_LENGTH = 512;

const PUBLIC_CLIENT_ID = "jev-connector";

/**
 * Compare two secrets without leaking timing information.
 */
function safeCompare(left, right) {
  if (
    typeof left !== "string" ||
    typeof right !== "string"
  ) {
    return false;
  }

  const leftBuffer =
    Buffer.from(left, "utf8");

  const rightBuffer =
    Buffer.from(right, "utf8");

  if (
    leftBuffer.length !== rightBuffer.length
  ) {
    return false;
  }

  return crypto.timingSafeEqual(
    leftBuffer,
    rightBuffer
  );
}

/**
 * Extract a Bearer token from Authorization header.
 *
 * Returns null for malformed or missing headers.
 */
function getBearerToken(req) {
  const header =
    req.get("authorization");

  if (
    typeof header !== "string" ||
    header.length === 0
  ) {
    return null;
  }

  const match =
    header.match(/^Bearer[ \t]+([^\s]+)$/i);

  if (!match) {
    return null;
  }

  const token =
    match[1].trim();

  if (
    token.length === 0 ||
    token.length > MAX_TOKEN_LENGTH
  ) {
    return null;
  }

  return token;
}

/**
 * Return a safe client identifier.
 *
 * x-ai-client is informational only.
 * It is NEVER treated as authentication.
 */
function getClientId(req) {
  const client =
    req.get("x-ai-client");

  if (
    typeof client !== "string" ||
    client.trim() === ""
  ) {
    return "unknown";
  }

  return client
    .trim()
    .slice(0, 100);
}

/**
 * Authentication middleware.
 */
export function requireJevAuth(
  req,
  res,
  next
) {
  // Fail closed if the server has not
  // been configured with an API key.
  if (!API_KEY) {
    console.error(
      "[SECURITY] JEV_API_KEY is not configured."
    );

    return res.status(503).json({
      ok: false,
      error:
        "Jev authentication is not configured"
    });
  }

  const token =
    getBearerToken(req);

  if (!token) {
    return res.status(401).json({
      ok: false,
      error:
        "Bearer authentication required"
    });
  }

  if (
    !safeCompare(token, API_KEY)
  ) {
    return res.status(401).json({
      ok: false,
      error: "Invalid authentication"
    });
  }

  // Authentication succeeded.
  // Attach non-secret request metadata.
  req.jevAuth = {
    authenticated: true,
    service: PUBLIC_CLIENT_ID,
    client: getClientId(req)
  };

  return next();
}

/**
 * Check whether authentication is configured.
 *
 * This never returns the actual secret.
 */
export function isAuthConfigured() {
  return API_KEY.length > 0;
}

/**
 * Return safe authentication metadata.
 *
 * Never expose the API key.
 */
export function getAuthStatus() {
  return {
    configured: isAuthConfigured(),
    scheme: AUTH_SCHEME,
    service: PUBLIC_CLIENT_ID
  };
}
