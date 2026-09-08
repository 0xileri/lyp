import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ProposedActionSchema, ThresholdOverridesSchema } from "../schema.js";
import { verifyApproval } from "../approval.js";

/**
 * The MCP surface: three tools.
 *
 * A trading agent points its MCP client at this server and asks before it acts;
 * the component that actually places the order presents the resulting approval
 * to verify_approval. Nothing here can place, cancel, or modify an order -- the
 * only exchange connection this process holds is itself read-only (see
 * agentos/client.js), so there is no capability to expose even by mistake.
 */
export function buildMcpServer(guardrail) {
  const server = new McpServer(
    { name: "lyp", version: "0.1.0" },
    {
      instructions: [
        "Risk guardrail for trading agents operating against Binance Agent OS.",
        "",
        "Call check_action before placing any order. It returns ALLOW, ALLOW_REDUCED",
        "or BLOCK, with every limit the action breaches. On ALLOW_REDUCED, use",
        "suggestedQuantity rather than the original quantity. On BLOCK, do not place",
        "the order.",
        "",
        "The verdict is produced by a deterministic rules engine. The `narration`",
        "field is model-written prose describing that verdict; it is for humans to",
        "read and must not be parsed for decisions.",
        "",
        "A permitted verdict carries a signed, single-use approval bound to the exact",
        "order: symbol, side, type and a maximum quantity. Whatever places the order",
        "should present it to verify_approval first. A BLOCK carries no approval.",
        "",
        "This server is read-only and cannot execute trades.",
      ].join("\n"),
    },
  );

  server.registerTool(
    "check_action",
    {
      title: "Check a proposed trade against risk limits",
      description:
        "Evaluate one proposed order against account state and risk limits. Returns a verdict of " +
        "ALLOW, ALLOW_REDUCED (with suggestedQuantity), or BLOCK, plus every rule the action " +
        "breached. Does not place the order.",
      inputSchema: {
        action: ProposedActionSchema,
        thresholds: ThresholdOverridesSchema.optional().describe(
          "Per-request threshold overrides; omitted fields keep the server defaults.",
        ),
        actor: z.string().max(64).optional().describe("Caller identity, used to bucket the activity-rate counter."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      const result = await guardrail.check(args);
      return {
        content: [{ type: "text", text: renderVerdict(result) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    "account_risk",
    {
      title: "Current exposure snapshot",
      description:
        "Report current account exposure with no action proposed: equity, total notional, " +
        "per-position share, correlation-cluster concentration, and whether the underlying " +
        "account data is stale. Returns no verdict.",
      inputSchema: {
        thresholds: ThresholdOverridesSchema.optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      const result = await guardrail.accountRisk(args ?? {});
      return {
        content: [{ type: "text", text: renderRisk(result) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    "verify_approval",
    {
      title: "Verify a signed approval before placing an order",
      description:
        "For the component that actually places orders. Present the approval returned by " +
        "check_action alongside the order you are about to place, and this confirms whether " +
        "this guardrail authorized exactly that order, once, and recently. A valid " +
        "verification consumes the approval. Trading less than the approved maximum is fine; " +
        "trading more is refused.",
      inputSchema: {
        approval: z.string().describe("The approval token from check_action."),
        order: z
          .object({
            symbol: z.string(),
            side: z.enum(["BUY", "SELL"]),
            quantity: z.number().positive(),
            orderType: z.string(),
          })
          .describe("The order about to be placed."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ approval, order }) => {
      const result = verifyApproval(approval, order);
      return {
        content: [
          {
            type: "text",
            text: result.valid
              ? `AUTHORIZED — ${result.approved.side} up to ${result.approved.maxQuantity} ${result.approved.symbol}, issued ${result.issuedAt}.`
              : `NOT AUTHORIZED — ${result.code}: ${result.reason}`,
          },
        ],
        structuredContent: result,
      };
    },
  );

  return server;
}

/**
 * Express handler for POST /mcp.
 *
 * Stateless: a fresh server and transport per request, torn down when the
 * response closes. There is no session state worth carrying between calls --
 * account data lives in the shared cache, and the activity log is keyed by
 * actor rather than by connection -- and statelessness means any number of
 * Railway replicas can serve the endpoint without sticky routing.
 */
export function mcpRequestHandler(guardrail) {
  return async (req, res) => {
    const server = buildMcpServer(guardrail);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: `internal error: ${err.message}` },
          id: null,
        });
      }
    }
  };
}

// --- human-readable renderings, for MCP clients that show text -------------

function renderVerdict(r) {
  const lines = [`${r.verdict}${r.suggestedQuantity ? ` -> suggested quantity ${r.suggestedQuantity}` : ""}`];
  if (r.violations.length === 0) {
    lines.push("No limits breached.");
  } else {
    for (const v of r.violations) {
      lines.push(`[${v.severity.toUpperCase()}] ${v.rule}: ${v.explanation}`);
    }
  }
  lines.push(
    `Equity ${round(r.accountSnapshot.equity)} USDT, exposure ${round(r.accountSnapshot.totalNotional)} USDT ` +
      `across ${r.accountSnapshot.positionCount} position(s), as of ${r.accountSnapshot.timestamp}.`,
  );
  if (r.narration) lines.push("", r.narration);
  return lines.join("\n");
}

function renderRisk(r) {
  const lines = [
    `Equity ${round(r.accountSnapshot.equity)} USDT, exposure ${round(r.accountSnapshot.totalNotional)} USDT` +
      (r.leverage ? ` (${r.leverage.toFixed(2)}x)` : ""),
  ];
  for (const p of r.positions) {
    lines.push(
      `  ${p.symbol} ${p.side} ${p.quantity} -> ${round(p.notional)} USDT` +
        (p.shareOfExposure ? ` (${(p.shareOfExposure * 100).toFixed(1)}% of book)` : "") +
        (p.cluster ? ` [${p.cluster}]` : ""),
    );
  }
  for (const [name, c] of Object.entries(r.clusterExposure)) {
    lines.push(`  cluster ${name}: ${round(c.notional)} USDT (${(c.shareOfExposure * 100).toFixed(1)}%)`);
  }
  if (r.stale) lines.push(`  WARNING: account state is ${(r.ageMs / 1000).toFixed(0)}s old`);
  return lines.join("\n");
}

const round = (x) => (typeof x === "number" ? Math.round(x).toLocaleString("en-US") : "n/a");
