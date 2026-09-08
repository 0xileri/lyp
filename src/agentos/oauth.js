import { createHash, randomBytes } from "node:crypto";

/**
 * OAuth 2.0 authorization-code flow with PKCE, against Binance Agent OS.
 *
 * Discovered from the endpoint's own 401 challenge (RFC 9728) rather than
 * hardcoded from documentation: the protected-resource document at
 * agent.binance.com names agent.binance.com as its authorization server, whose
 * metadata gives the two endpoints below. It advertises `authorization_code`
 * only, requires PKCE S256, and offers no dynamic client registration — so a
 * client_id has to be issued to the operator out of band, and every other part
 * of the flow happens here.
 *
 * This exists because there is no API-key path to Agent OS. Without a flow,
 * "set a token" is not an instruction anyone can follow.
 */

export const AUTH_ENDPOINTS = {
  authorize:
    process.env.AGENT_OS_AUTHORIZE_URL ?? "https://accounts.binance.com/agentic-oauth/authorize",
  token: process.env.AGENT_OS_TOKEN_URL ?? "https://accounts.binance.com/oauth-agentic/token",
  /** RFC 8707 resource indicator: the API the token is meant for. */
  resource: process.env.AGENT_OS_MCP_URL ?? "https://agent.binance.com/mcp/agentic",
};

/**
 * Scopes requested.
 *
 * Read-only by intent as well as by enforcement. Trading scopes are not
 * requested even though the account may be able to grant them: a token this
 * service holds should not be capable of placing an order, so that the
 * read-only guarantee does not rest solely on this service behaving correctly.
 */
export const REQUESTED_SCOPE = process.env.AGENT_OS_SCOPE ?? "market_data account:read";

const b64url = (buf) => buf.toString("base64url");

export function createPkce() {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

/**
 * Pending authorizations, keyed by `state`.
 *
 * In memory and short-lived on purpose: a verifier that outlives its exchange
 * is a liability, and there is nothing here worth persisting across a restart.
 */
const pending = new Map();
const PENDING_TTL_MS = 10 * 60 * 1000;

function prune(now = Date.now()) {
  for (const [state, entry] of pending) {
    if (now - entry.at > PENDING_TTL_MS) pending.delete(state);
  }
}

export function beginAuthorization({ clientId, redirectUri }) {
  if (!clientId) {
    throw new Error(
      "AGENT_OS_CLIENT_ID is not set. Agent OS offers no dynamic client registration, " +
        "so a client id has to be issued to you before the flow can start.",
    );
  }
  prune();
  const { verifier, challenge } = createPkce();
  const state = b64url(randomBytes(24));
  pending.set(state, { verifier, redirectUri, at: Date.now() });

  const url = new URL(AUTH_ENDPOINTS.authorize);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", AUTH_ENDPOINTS.resource);
  if (REQUESTED_SCOPE) url.searchParams.set("scope", REQUESTED_SCOPE);

  return { url: url.href, state };
}

export async function completeAuthorization({ code, state, clientId }) {
  const entry = pending.get(state);
  if (!entry) {
    // An unknown state is either a replay, a expired attempt, or a forgery.
    // None of them should be exchanged.
    throw new Error("unknown or expired authorization state");
  }
  pending.delete(state);

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: entry.redirectUri,
    client_id: clientId,
    code_verifier: entry.verifier,
    resource: AUTH_ENDPOINTS.resource,
  });

  const res = await fetch(AUTH_ENDPOINTS.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
    signal: AbortSignal.timeout(15_000),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`token exchange failed: ${res.status} ${text.slice(0, 300)}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`token endpoint returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (!json.access_token) throw new Error("token response carried no access_token");
  return json;
}

/**
 * The access token currently held, if any.
 *
 * Deliberately process-local and never logged. A token obtained through the
 * flow lives only as long as the process; AGENT_OS_TOKEN is the durable path
 * for a deployment that should come back connected after a restart.
 */
class TokenStore {
  #token = process.env.AGENT_OS_TOKEN || null;
  #expiresAt = null;
  #scope = null;
  #source = process.env.AGENT_OS_TOKEN ? "environment" : null;

  set(tokenResponse) {
    this.#token = tokenResponse.access_token;
    this.#scope = tokenResponse.scope ?? null;
    this.#expiresAt = tokenResponse.expires_in
      ? Date.now() + Number(tokenResponse.expires_in) * 1000
      : null;
    this.#source = "oauth";
  }

  get() {
    if (this.#expiresAt && Date.now() >= this.#expiresAt) return null;
    return this.#token;
  }

  /** Everything about the token except the token. */
  status() {
    return {
      present: Boolean(this.get()),
      source: this.#source,
      scope: this.#scope,
      expiresAt: this.#expiresAt ? new Date(this.#expiresAt).toISOString() : null,
    };
  }

  clear() {
    this.#token = null;
    this.#expiresAt = null;
    this.#scope = null;
    this.#source = null;
  }
}

export const tokens = new TokenStore();
