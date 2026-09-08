import test from "node:test";
import assert from "node:assert/strict";

import {
  AgentOsClient,
  ReadOnlyViolationError,
  isWriteTool,
  unwrapToolResult,
  TOOL_NAMES,
  DEFAULT_AGENT_OS_URL,
} from "../src/agentos/client.js";

/**
 * Read-only enforcement.
 *
 * The single most important property of this service is that it cannot place a
 * trade. These tests assert that at the boundary where it would have to happen.
 */

test("tools that could move money or change a position are classified as writes", () => {
  for (const name of [
    "create_order",
    "place_spot_order",
    "cancel_order",
    "submit_trade",
    "execute_swap",
    "transfer_funds",
    "withdraw",
    "set_leverage",
    "repay_margin_loan",
    "close_position",
    "pay_invoice",
  ]) {
    assert.equal(isWriteTool(name), true, `${name} should be refused`);
  }
});

test("the reads this service needs are not misclassified", () => {
  for (const name of ["get_account_balances", "get_open_positions", "get_mark_price", "list_symbols"]) {
    assert.equal(isWriteTool(name), false, `${name} should be permitted`);
  }
});

test("get_open_orders is allowed by exact name despite containing 'order'", () => {
  // The substring test is deliberately over-eager, so the one read that trips
  // it is exempted explicitly rather than by loosening the pattern.
  assert.equal(isWriteTool(TOOL_NAMES.openOrders), false);
  assert.equal(isWriteTool("get_open_orders_and_place_one"), true);
});

test("calling a write tool is refused before any network activity", async () => {
  // The URL is unreachable on purpose: if the refusal were not happening first,
  // this would fail with a connection error instead of a ReadOnlyViolationError.
  const client = new AgentOsClient({ url: "http://127.0.0.1:1/mcp", token: "x" });

  await assert.rejects(() => client.call("create_order", { symbol: "BTCUSDT" }), ReadOnlyViolationError);
  await assert.rejects(() => client.call("cancel_order", {}), ReadOnlyViolationError);
});

test("a read tool outside the allowlist is also refused", async () => {
  const client = new AgentOsClient({ url: "http://127.0.0.1:1/mcp", token: "x" });

  await assert.rejects(() => client.call("get_something_unexpected"), ReadOnlyViolationError);
});

test("the endpoint defaults to the published Agent OS URL", () => {
  // Market data on Agent OS is unauthenticated, so a client with no
  // configuration at all should still point somewhere real rather than refuse
  // to construct.
  assert.equal(new AgentOsClient().url, DEFAULT_AGENT_OS_URL);
  assert.match(DEFAULT_AGENT_OS_URL, /^https:\/\/agent\.binance\.com\//);
});

test("an explicitly empty endpoint is a configuration error, not a silent no-op", () => {
  assert.throws(() => new AgentOsClient({ url: "" }), /No Agent OS endpoint/);
});

test("tool results are unwrapped from structured content or a JSON text block", () => {
  assert.deepEqual(unwrapToolResult({ structuredContent: { equity: 100 } }), { equity: 100 });
  assert.deepEqual(unwrapToolResult({ content: [{ type: "text", text: '{"equity":100}' }] }), { equity: 100 });
});

test("an empty or unparseable tool result throws rather than reading as an empty account", () => {
  // An empty object here would present as "no positions", which is the most
  // dangerous possible misreading of a broken upstream.
  assert.throws(() => unwrapToolResult({ content: [] }), /no structured content/);
  assert.throws(() => unwrapToolResult({}), /no structured content/);
  assert.throws(() => unwrapToolResult({ content: [{ type: "text", text: "<html>502</html>" }] }), /unparseable/);
});
