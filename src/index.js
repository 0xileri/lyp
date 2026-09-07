import express from "express";
import { SERVER, NARRATION } from "./config.js";
import { CheckRequestSchema } from "./schema.js";
import { Guardrail } from "./guardrail.js";
import { AccountStateService, AgentOsProvider, FixtureProvider } from "./agentos/account.js";
import { createNarrator } from "./narration.js";
import { mcpRequestHandler } from "./mcp/server.js";
import { DEMO_ACCOUNT } from "../fixtures/accounts.js";

/**
 * HTTP surfaces: POST /mcp, POST /check, GET /health.
 *
 * /check and check_action run the identical code path; the REST route exists so
 * a caller that is not an MCP client can still ask before it trades.
 */

export function createApp({ guardrail, provider = SERVER.provider } = {}) {
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  app.disable("x-powered-by");

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
