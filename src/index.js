import express from "express";
import { SERVER, NARRATION } from "./config.js";
import { CheckRequestSchema } from "./schema.js";
import { Guardrail } from "./guardrail.js";
import { AccountStateService, AgentOsProvider, FixtureProvider } from "./agentos/account.js";
import { createNarrator } from "./narration.js";
import { mcpRequestHandler } from "./mcp/server.js";
import { landingPage } from "./landing.js";
import { AgentOsClient } from "./agentos/client.js";
import { beginAuthorization, completeAuthorization, tokens } from "./agentos/oauth.js";
import { DEMO_ACCOUNT } from "../fixtures/accounts.js";

/**
 * HTTP surfaces: POST /mcp, POST /check, GET /health, and a landing page at /.
 *
 * /check and check_action run the identical code path; the REST route exists so
 * a caller that is not an MCP client can still ask before it trades. The
 * landing page calls that same /check, so a browser and an agent are exercising
 * one implementation rather than two that can drift apart.
 */

export function createApp({ guardrail, provider = SERVER.provider } = {}) {
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  app.disable("x-powered-by");

  // A browser hitting the bare URL should learn what this is, not "Cannot GET /".
  app.get("/", (_req, res) => {
    res.type("html").send(landingPage({ narrationEnabled: NARRATION.enabled, provider }));
  });

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      provider,
      narration: NARRATION.enabled ? "enabled" : "disabled",
      // Stated explicitly because it is the property that matters most about
      // this service, and it should be checkable without reading the source.
      exchangeScope: "read-only",
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  /**
   * What the Agent OS endpoint actually exposes, and which of those tools this
   * service will call.
   *
   * Read-only in the strictest sense: it lists tool names and invokes none of
   * them. It exists because the tool names this service wires were inferred
   * rather than read from the docs, and this is the honest way to check them
   * against the real endpoint — including from a deployment whose network can
   * reach Binance when a laptop cannot.
   */
  app.get("/agentos", async (req, res) => {
    const client = new AgentOsClient({
      url: process.env.AGENT_OS_MCP_URL,
      token: () => tokens.get(),
    });
    const started = Date.now();
    try {
      const audit = await withTimeout(client.auditTools(), 15_000);
      res.json({
        endpoint: client.url,
        token: tokens.status(),
        elapsedMs: Date.now() - started,
        ...audit,
        missing: audit.wired.filter((n) => !audit.readable.includes(n)),
      });
    } catch (err) {
      // The MCP SDK reports a failed handshake without the status code that
      // explains it. Re-issue the same initialize as a plain POST so the
      // response is legible: an auth challenge, a wrong path and a protocol
      // mismatch all look identical otherwise.
      const raw = await rawProbe(client.url, tokens.get());
      res.status(502).json({
        endpoint: client.url,
        token: tokens.status(),
        connectUrl: `${req.protocol}://${req.get("host")}/connect`,
        elapsedMs: Date.now() - started,
        error: err.message,
        raw,
        // RFC 9728: a 401 carrying resource_metadata tells a client where to
        // discover the authorization server. Following it is the defined next
        // step of the handshake, not a workaround.
        oauth: await discoverAuth(raw),
      });
    } finally {
      await client.close().catch(() => {});
    }
  });

  /**
   * Start the Agent OS authorization flow.
   *
   * Agent OS offers no API-key path and no dynamic client registration, so this
   * redirect is the only way a token comes into existence. The operator lands
   * on Binance's consent screen, grants read scopes, and returns to /callback.
   */
  app.get("/connect", (req, res) => {
    try {
      const { url } = beginAuthorization({
        clientId: process.env.AGENT_OS_CLIENT_ID,
        redirectUri: callbackUrl(req),
      });
      res.redirect(url);
    } catch (err) {
      res.status(503).json({ error: err.message, redirectUri: callbackUrl(req) });
    }
  });

  /** Where Binance returns the authorization code. */
  app.get("/callback", async (req, res) => {
    const { code, state, error, error_description: description } = req.query;
    if (error) {
      return res.status(400).type("html").send(
        connectResult(false, `Authorization was refused: ${escapeHtml(String(description ?? error))}`),
      );
    }
    if (!code || !state) {
      return res.status(400).type("html").send(connectResult(false, "Missing code or state."));
    }
    try {
      const granted = await completeAuthorization({
        code: String(code),
        state: String(state),
        clientId: process.env.AGENT_OS_CLIENT_ID,
      });
      tokens.set(granted);
      // Cached fixture/live state is now the wrong shape of truth; drop it so
      // the next verdict reads from the account that was just authorized.
      guardrail.stateService.invalidate?.();
      res.type("html").send(
        connectResult(true, `Scopes granted: ${escapeHtml(granted.scope ?? "(not reported)")}.`),
      );
    } catch (err) {
      res.status(502).type("html").send(connectResult(false, escapeHtml(err.message)));
    }
  });

  app.post("/check", async (req, res) => {
    const parsed = CheckRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "invalid request",
        // A malformed request is not a verdict, but a caller that reads
        // `verdict` blindly must not see anything permissive.
        verdict: "BLOCK",
        details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }

    try {
      res.json(await guardrail.check(parsed.data));
    } catch (err) {
      res.status(503).json(unavailable(err));
    }
  });

  app.post("/mcp", mcpRequestHandler(guardrail));

  // MCP over streamable HTTP uses GET and DELETE for SSE streams and session
  // teardown. This deployment is stateless, so both are explicitly unsupported
  // rather than silently 404ing as a routing mistake.
  const noSession = (_req, res) =>
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "this server is stateless; use POST /mcp" },
      id: null,
    });
  app.get("/mcp", noSession);
  app.delete("/mcp", noSession);

  return app;
}

/**
 * Fail closed.
 *
 * When state cannot be fetched at all, the answer is BLOCK. The status code is
 * 503 so that operators see a real failure, and the body is shaped like a
 * verdict so that an agent reading `verdict` cannot mistake an outage for
 * permission.
 */
function unavailable(err) {
  return {
    verdict: "BLOCK",
    suggestedQuantity: null,
    violations: [
      {
        rule: "guardrail_unavailable",
        severity: "block",
        actual: 0,
        threshold: 1,
        explanation: `Account state could not be read: ${err.message}. Refusing rather than guessing.`,
      },
    ],
    accountSnapshot: { equity: 0, totalNotional: 0, positionCount: 0, timestamp: new Date().toISOString() },
    narration: null,
  };
}

/** Wire the provider named by GUARDRAIL_PROVIDER. */
export function createGuardrail(provider = SERVER.provider) {
  const source = provider === "agentos" ? new AgentOsProvider() : new FixtureProvider(DEMO_ACCOUNT);
  return new Guardrail({
    stateService: new AccountStateService(source),
    narrator: createNarrator(),
  });
}

// Started directly rather than imported by a test.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("index.js")) {
  const app = createApp({ guardrail: createGuardrail() });
  app.listen(SERVER.port, () => {
    console.log(`risk guardrail listening on :${SERVER.port}`);
    console.log(`  provider:  ${SERVER.provider}${SERVER.provider === "fixture" ? " (no live exchange connection)" : ""}`);
    console.log(`  narration: ${NARRATION.enabled ? NARRATION.model : "disabled"}`);
    console.log(`  scope:     read-only; this service cannot place trades`);
  });
}

/** Reject after `ms` so a hung upstream cannot hold a request open. */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms).unref?.(),
    ),
  ]);
}

/**
 * A plain HTTP POST of the MCP `initialize` handshake, for diagnosis only.
 *
 * Reports what the endpoint actually answered — status, content type, and a
 * short body excerpt — so that "auth required", "wrong path" and "protocol
 * mismatch" can be told apart. Sends no credentials it was not given, and
 * calls no tools.
 */
async function rawProbe(url, token) {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "lyp", version: "0.1.0" },
    },
  };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    });
    const text = await res.text();
    return {
      status: res.status,
      statusText: res.statusText,
      contentType: res.headers.get("content-type"),
      wwwAuthenticate: res.headers.get("www-authenticate"),
      bodyExcerpt: text.slice(0, 500),
    };
  } catch (err) {
    return { transportError: err.message };
  }
}

/**
 * Follow the OAuth discovery chain a 401 points at.
 *
 * RFC 9728 defines `WWW-Authenticate: Bearer resource_metadata="..."` as the
 * pointer to a protected-resource document, which in turn names the
 * authorization servers. Reading those two documents is the specified next step
 * of the handshake, and it is what tells an operator which consent screen to
 * visit and which scopes exist to be granted.
 *
 * Reads metadata only. Starts no authorization, holds no token.
 */
async function discoverAuth(raw) {
  const header = raw?.wwwAuthenticate;
  const match = header && /resource_metadata="([^"]+)"/.exec(header);
  if (!match) return { discovered: false, reason: "no resource_metadata in the challenge" };

  const get = async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { url, status: res.status };
    return { url, status: res.status, body: await res.json() };
  };

  try {
    const resource = await get(match[1]);
    const servers = resource.body?.authorization_servers ?? [];
    const authServer = servers[0]
      ? await get(new URL("/.well-known/oauth-authorization-server", servers[0]).href).catch(
          () => null,
        )
      : null;

    return {
      discovered: true,
      resourceMetadata: resource,
      // The fields an operator actually needs to complete consent.
      summary: {
        scopesSupported: resource.body?.scopes_supported,
        authorizationServers: servers,
        authorizationEndpoint: authServer?.body?.authorization_endpoint,
        tokenEndpoint: authServer?.body?.token_endpoint,
        registrationEndpoint: authServer?.body?.registration_endpoint,
        grantTypes: authServer?.body?.grant_types_supported,
        codeChallengeMethods: authServer?.body?.code_challenge_methods_supported,
      },
    };
  } catch (err) {
    return { discovered: false, reason: err.message };
  }
}

/**
 * The callback URL this deployment is reachable at.
 *
 * Derived from the forwarded host so the value registered with Binance matches
 * whatever domain actually served the request — Railway's generated domain has
 * already changed once during this project's life.
 */
function callbackUrl(req) {
  const proto = req.get("x-forwarded-proto") ?? req.protocol;
  return `${proto}://${req.get("host")}/callback`;
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** A plain result page for the end of the OAuth round trip. */
function connectResult(ok, detail) {
  return `<!doctype html><meta charset="utf-8"><title>${ok ? "Connected" : "Not connected"} — lyp</title>
<style>
 body{margin:0;background:#0a0a0c;color:#ecebe8;font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
      display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
 .c{max-width:520px;border:1px solid #22222b;background:#131318;border-radius:14px;padding:32px}
 h1{margin:0 0 12px;font-size:22px;letter-spacing:-0.02em;color:${ok ? "#4ade80" : "#f87171"}}
 p{margin:0 0 14px;color:#9d9b95}
 code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;color:#7dd3a0}
 a{color:#ecebe8}
</style>
<div class="c">
  <h1>${ok ? "Connected to Agent OS" : "Not connected"}</h1>
  <p>${detail}</p>
  <p>${
    ok
      ? 'Account reads will now use the authorized subaccount. Check <code>/agentos</code> for the tools it exposes, then set <code>GUARDRAIL_PROVIDER=agentos</code> to switch verdicts off fixture state.'
      : 'Nothing was stored. <code>/agentos</code> reports the current handshake state.'
  }</p>
  <p><a href="/">← back to lyp</a></p>
</div>`;
}
