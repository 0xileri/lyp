import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * MCP client for Binance Agent OS, over streamable HTTP.
 *
 * This service is read-only against the exchange by construction, not by
 * convention. Two independent mechanisms enforce that:
 *
 *  1. An allowlist. Only the four tools named in TOOL_NAMES are ever called.
 *  2. A denylist guard on every call, so a tool that is renamed, aliased or
 *     newly introduced upstream into something order-shaped is refused here
 *     even if it somehow reaches the allowlist.
 *
 * Belt and braces is warranted: the entire value of a guardrail is that it
 * cannot itself become the thing that places the trade.
 */

// ---------------------------------------------------------------------------
// TODO(agent-os): the two values below, plus the four tool names, are the only
// unknowns in this file. They come from https://binance.com/agent-os, which
// was not reachable from the build environment. Everything else -- transport,
// auth, session lifecycle, read-only gating, response normalisation -- is
// implemented and exercised by the fixture provider.
//
// To wire the live connection:
//   1. set AGENT_OS_MCP_URL and AGENT_OS_TOKEN in .env
//   2. run `npm run audit:tools` to print the tool names the endpoint exposes
//   3. map them onto the four entries below (env vars, no code change needed)
// ---------------------------------------------------------------------------

export const TOOL_NAMES = {
  balances: process.env.AGENT_OS_TOOL_BALANCES ?? "get_account_balances",
  positions: process.env.AGENT_OS_TOOL_POSITIONS ?? "get_open_positions",
  openOrders: process.env.AGENT_OS_TOOL_OPEN_ORDERS ?? "get_open_orders",
  markPrices: process.env.AGENT_OS_TOOL_MARK_PRICES ?? "get_mark_price",
};

/** Substrings that mark a tool as capable of changing exchange state. */
const WRITE_TOOL_PATTERNS = [
  "order", "trade", "buy", "sell", "swap", "convert", "transfer",
  "withdraw", "deposit", "borrow", "repay", "leverage", "margin_type",
  "close", "cancel", "execute", "submit", "place", "pay",
];

/**
 * True when a tool name looks like it can move money or change a position.
 *
 * Substring matching is intentionally over-eager. A false positive costs a
 * read we can do another way; a false negative costs a trade nobody asked for.
 * `get_open_orders` is the one read we need that trips the "order" pattern, so
 * it is allowed through by exact name.
 */
export function isWriteTool(name) {
  const n = String(name).toLowerCase();
  if (n === TOOL_NAMES.openOrders.toLowerCase()) return false;
  return WRITE_TOOL_PATTERNS.some((p) => n.includes(p));
}

export class ReadOnlyViolationError extends Error {
  constructor(toolName) {
    super(
      `refused to call "${toolName}": this service holds read-only scope and never ` +
        `invokes exchange-mutating tools`,
    );
    this.name = "ReadOnlyViolationError";
  }
}

export class AgentOsClient {
  #client = null;
  #transport = null;
  #allowed;

  constructor({ url, token, allowedTools = Object.values(TOOL_NAMES) } = {}) {
    if (!url) {
      throw new Error(
        "AGENT_OS_MCP_URL is not set. Set it in .env, or run with " +
          "GUARDRAIL_PROVIDER=fixture to exercise the engine without a live connection.",
      );
    }
    this.url = url;
    this.token = token;
    this.#allowed = new Set(allowedTools);
  }

  async connect() {
    if (this.#client) return this.#client;

    this.#transport = new StreamableHTTPClientTransport(new URL(this.url), {
      requestInit: {
        headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
      },
    });

    this.#client = new Client(
      { name: "lyp", version: "0.1.0" },
      // No tool capabilities are declared: this client consumes tools, and
      // never offers any of its own back to the exchange side.
      { capabilities: {} },
    );

    await this.#client.connect(this.#transport);
    return this.#client;
  }

  /** Tool names the endpoint exposes, split by whether we will ever call them. */
  async auditTools() {
    const client = await this.connect();
    const { tools } = await client.listTools();
    const readable = [];
    const refused = [];
    for (const t of tools) {
      (isWriteTool(t.name) ? refused : readable).push(t.name);
    }
    return { readable, refused, wired: [...this.#allowed] };
  }

  /**
   * Call one tool, after both gates. Throws rather than returning an error
   * value, because a guardrail that degrades quietly is not a guardrail.
   */
  async call(name, args = {}) {
    if (isWriteTool(name)) throw new ReadOnlyViolationError(name);
    if (!this.#allowed.has(name)) {
      throw new ReadOnlyViolationError(
        `${name} (not in the read-only allowlist: ${[...this.#allowed].join(", ")})`,
      );
    }
    const client = await this.connect();
    const result = await client.callTool({ name, arguments: args });
    return unwrapToolResult(result);
  }

  async close() {
    await this.#transport?.close?.();
    this.#client = null;
    this.#transport = null;
  }
}

/**
 * MCP tool results arrive as content blocks. Structured content is preferred
 * when present; otherwise the first text block is parsed as JSON. A tool that
 * returns neither is an error rather than an empty object, so that a broken
 * upstream surfaces as a BLOCK instead of an empty portfolio that reads as
 * "no positions, everything is fine".
 */
export function unwrapToolResult(result) {
  if (result?.structuredContent !== undefined) return result.structuredContent;

  const text = result?.content?.find((c) => c.type === "text")?.text;
  if (typeof text !== "string") {
    throw new Error("Agent OS tool returned no structured content and no text block");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Agent OS tool returned unparseable text: ${text.slice(0, 200)}`);
  }
}
