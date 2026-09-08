import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * The agent's tool layer.
 *
 * The design decision that matters is here rather than in the prompt: the only
 * action-shaped tool the model can reach is `propose_trade`, and that function
 * calls the guardrail itself before returning. The model cannot skip the check,
 * cannot see a path around it, and cannot act on a BLOCK, because the refusal
 * happens in this file and not in an instruction the model is asked to follow.
 *
 * Prompts are guidance. This is a constraint. An agent that is merely *told* to
 * check its risk limits is one confident completion away from not checking
 * them, which is the whole reason this project exists.
 */

export const DEFAULT_GUARDRAIL_URL = process.env.LYP_MCP_URL ?? "https://lyp.up.railway.app/mcp";

/** Minimal MCP client over streamable HTTP. */
export class McpConnection {
  #client = null;
  #transport = null;

  constructor(url, { name = "lyp-agent", token = null } = {}) {
    this.url = url;
    this.name = name;
    this.token = token;
  }

  async connect() {
    if (this.#client) return this.#client;
    this.#transport = new StreamableHTTPClientTransport(new URL(this.url), {
      requestInit: { headers: this.token ? { Authorization: `Bearer ${this.token}` } : {} },
    });
    this.#client = new Client({ name: this.name, version: "0.1.0" }, { capabilities: {} });
    await this.#client.connect(this.#transport);
    return this.#client;
  }

  async call(name, args = {}) {
    const client = await this.connect();
    const result = await client.callTool({ name, arguments: args });
    if (result?.structuredContent !== undefined) return result.structuredContent;
    const text = result?.content?.find((c) => c.type === "text")?.text;
    if (typeof text !== "string") throw new Error(`${name} returned no usable content`);
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  }

  async close() {
    await this.#transport?.close?.();
    this.#client = null;
    this.#transport = null;
  }
}

/**
 * The agent's decision record.
 *
 * Every proposal and every verdict is appended, so a run can be audited after
 * the fact without re-reading the model's reasoning. What the model said it
 * would do and what the guardrail permitted are recorded separately, because
 * the interesting cases are the ones where they differ.
 */
export class RunLog {
  entries = [];

  record(entry) {
    this.entries.push({ at: new Date().toISOString(), ...entry });
    return entry;
  }

  get proposals() {
    return this.entries.filter((e) => e.kind === "proposal");
  }

  /** Trades the guardrail permitted, at the size it permitted. */
  get permitted() {
    return this.proposals.filter((p) => p.verdict !== "BLOCK");
  }

  get blocked() {
    return this.proposals.filter((p) => p.verdict === "BLOCK");
  }
}

/**
 * Build the tool set exposed to the model.
 *
 * `guardrail` is an McpConnection to lyp. `market` is an optional McpConnection
 * to Binance Agent OS; when absent, prices come from the guardrail's own view
 * of the book, which is the same data the verdict is computed against.
 */
export function createTools({ guardrail, market = null, log = new RunLog() }) {
  /** Cached so a multi-step run does not re-fetch the book on every thought. */
  let bookCache = null;

  async function book() {
    if (bookCache) return bookCache;
    bookCache = await guardrail.call("account_risk", {});
    return bookCache;
  }

  const definitions = [
    {
      name: "get_account_risk",
      description:
        "Current account exposure: equity, total notional, each position with its share of the " +
        "book, correlation-cluster concentration, and whether the data is stale. No action is " +
        "proposed and no verdict is returned. Call this first.",
      input_schema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "get_market_price",
      description:
        "Latest price for one symbol, e.g. BTCUSDT. Sourced from Binance Agent OS when a " +
        "connection is authorized, otherwise from the mark prices the guardrail is using.",
      input_schema: {
        type: "object",
        properties: { symbol: { type: "string", description: "e.g. BTCUSDT" } },
        required: ["symbol"],
      },
    },
    {
      name: "propose_trade",
      description:
        "Propose one trade. It is checked against the risk guardrail before this function " +
        "returns, and the verdict is final: BLOCK means the trade does not happen, and " +
        "ALLOW_REDUCED means it happens only at suggestedQuantity. This is the only way to " +
        "act, and it never places a real order — it records an intent.",
      input_schema: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          side: { type: "string", enum: ["BUY", "SELL"] },
          quantity: { type: "number", exclusiveMinimum: 0 },
          orderType: {
            type: "string",
            enum: ["MARKET", "LIMIT", "STOP", "STOP_MARKET", "TAKE_PROFIT", "TAKE_PROFIT_MARKET"],
          },
          leverage: { type: "number", description: "Omit for spot." },
          reasoning: {
            type: "string",
            description: "Why this trade, in one sentence. Recorded in the run log.",
          },
        },
        required: ["symbol", "side", "quantity", "orderType", "reasoning"],
      },
    },
  ];

  const handlers = {
    async get_account_risk() {
      const risk = await book();
      log.record({ kind: "read", tool: "get_account_risk" });
      return {
        equity: risk.accountSnapshot.equity,
        totalNotional: risk.accountSnapshot.totalNotional,
        leverage: risk.leverage,
        positionCount: risk.accountSnapshot.positionCount,
        positions: risk.positions,
        clusterExposure: risk.clusterExposure,
        stale: risk.stale,
      };
    },

    async get_market_price({ symbol }) {
      const upper = String(symbol).toUpperCase();

      if (market) {
        try {
          const res = await market.call("spot_tickerPrice", { symbol: upper });
          const price = Number(res?.price);
          if (Number.isFinite(price)) {
            log.record({ kind: "read", tool: "get_market_price", symbol: upper, source: "agent-os" });
            return { symbol: upper, price, source: "binance-agent-os" };
          }
        } catch (err) {
          // Fall through to the guardrail's marks rather than failing the run.
          log.record({ kind: "warn", tool: "get_market_price", error: err.message });
        }
      }

      const risk = await book();
      // The guardrail's full mark set first, so a symbol the book does not hold
      // yet can still be priced — which is the normal case when opening a
      // position. Falling back to a held position's mark covers older guardrail
      // builds that do not publish markPrices.
      const mark = risk.markPrices?.[upper] ?? risk.positions.find((p) => p.symbol === upper)?.markPrice;
      if (Number.isFinite(mark)) {
        log.record({ kind: "read", tool: "get_market_price", symbol: upper, source: "guardrail" });
        return { symbol: upper, price: mark, source: "guardrail-marks" };
      }
      return {
        symbol: upper,
        price: null,
        error:
          "No price available for this symbol. Without a price the guardrail cannot measure " +
          "exposure and will refuse any trade in it.",
      };
    },

    /**
     * The constraint.
     *
     * The guardrail is consulted here, unconditionally, before anything is
     * recorded as permitted. A BLOCK is returned to the model as a refusal it
     * cannot override; an ALLOW_REDUCED is recorded at the reduced size, not
     * the requested one.
     */
    async propose_trade({ symbol, side, quantity, orderType, leverage, reasoning }) {
      const action = { symbol: String(symbol).toUpperCase(), side, quantity, orderType };
      if (leverage !== undefined) action.leverage = leverage;

      const verdict = await guardrail.call("check_action", { action, actor: "lyp-agent" });

      // The size that would actually be traded, which is not always the size
      // that was asked for.
      const effectiveQuantity =
        verdict.verdict === "BLOCK"
          ? 0
          : verdict.verdict === "ALLOW_REDUCED"
            ? verdict.suggestedQuantity
            : quantity;

      log.record({
        kind: "proposal",
        requested: action,
        reasoning,
        verdict: verdict.verdict,
        effectiveQuantity,
        violations: verdict.violations.map((v) => ({ rule: v.rule, severity: v.severity })),
      });

      // Exposure changed (or was refused); the cached book is no longer the
      // right basis for a follow-up proposal.
      bookCache = null;

      return {
        verdict: verdict.verdict,
        effectiveQuantity,
        executed: false,
        note:
          verdict.verdict === "BLOCK"
            ? "REFUSED. This trade does not happen. Do not propose it again in a smaller " +
              "variation unless a violation explicitly says a smaller size would pass."
            : verdict.verdict === "ALLOW_REDUCED"
              ? `Permitted only at ${effectiveQuantity}, not ${quantity}. Recorded at the reduced size.`
              : "Permitted as requested. Recorded as an intent; no order was placed.",
        violations: verdict.violations,
        narration: verdict.narration,
      };
    },
  };

  return { definitions, handlers, log };
}
