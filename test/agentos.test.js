import test from "node:test";
import assert from "node:assert/strict";

import { AgentOsProvider, normalizePositions, normalizeMarks, deriveEquity, normalizeBalances } from "../src/agentos/account.js";
import { isWriteTool, TOOL_NAMES } from "../src/agentos/client.js";
import { evaluate } from "../src/engine/rules.js";
import { resolveThresholds } from "../src/config.js";
import { DIVERSIFIED } from "../fixtures/accounts.js";

/**
 * Agent OS integration.
 *
 * Every shape and failure mode asserted here was observed against a live
 * authorized gateway session rather than guessed. The earlier version of this
 * integration inferred four tool names and got all four wrong, so the point of
 * these tests is to pin what was actually seen.
 */

/** A stub client that answers or rejects per tool name. */
function stubClient(handlers) {
  return {
    async call(name, args) {
      const handler = handlers[name];
      if (!handler) throw new Error(`unexpected tool ${name}`);
      return typeof handler === "function" ? handler(args) : handler;
    },
  };
}

// --- the real tool surface -------------------------------------------------

test("the wired tool names are the ones the gateway actually exposes", () => {
  assert.equal(TOOL_NAMES.balances, "spot_getAccount");
  assert.equal(TOOL_NAMES.positions, "futures_usds_positionInformationV2");
  assert.equal(TOOL_NAMES.openOrders, "spot_getOpenOrders");
  assert.equal(TOOL_NAMES.markPrices, "spot_tickerPrice");
});

test("the read-only guard refuses every mutating tool the gateway offers", () => {
  // Names taken from the live tool listing, not invented.
  for (const name of [
    "spot_newOrder",
    "spot_deleteOrder",
    "spot_deleteOpenOrders",
    "margin_marginAccountNewOrder",
    "margin_marginAccountCancelOrder",
    "margin_marginAccountBorrowRepay",
    "convert_acceptQuote",
    "convert_placeLimitOrder",
    "wallet_userUniversalTransfer",
    "tool_execute",
  ]) {
    assert.equal(isWriteTool(name), true, `${name} must be refused`);
  }
});

test("the four reads are not caught by the guard", () => {
  for (const name of Object.values(TOOL_NAMES)) {
    assert.equal(isWriteTool(name), false, `${name} must be permitted`);
  }
});

// --- observed response shapes ----------------------------------------------

test("spot_getAccount balances normalize", () => {
  // Exactly the payload the live account returned.
  const balances = normalizeBalances({
    accountType: "SPOT",
    balances: [{ asset: "USDT", free: "0.02234192", locked: "0.00000000" }],
  });
  assert.deepEqual(balances, [{ asset: "USDT", free: 0.02234192, locked: 0 }]);
  assert.ok(Math.abs(deriveEquity({}, balances, []) - 0.02234192) < 1e-12);
});

test("spot_tickerPrice normalizes a single-symbol response", () => {
  assert.deepEqual(normalizeMarks({ symbol: "ETHUSDT", price: "2496.28000000" }), {
    ETHUSDT: 2496.28,
  });
});

test("futures positions use Binance's capital-R PnL spelling", () => {
  const [position] = normalizePositions([
    {
      symbol: "BTCUSDT",
      positionAmt: "-0.5",
      entryPrice: "80000",
      markPrice: "79266.49",
      leverage: "10",
      liquidationPrice: "88000",
      unRealizedProfit: "366.75",
    },
  ]);
  assert.equal(position.side, "SHORT", "a negative positionAmt is a short");
  assert.equal(position.quantity, 0.5);
  assert.equal(position.unrealizedPnl, 366.75);
});

// --- failure modes seen live -----------------------------------------------

test("a positions failure is recorded as degraded, not read as zero positions", async () => {
  // The live account is spot-only, and the gateway answers -2015 for futures.
  const provider = new AgentOsProvider(
    stubClient({
      [TOOL_NAMES.balances]: { balances: [{ asset: "USDT", free: "1000", locked: "0" }] },
      [TOOL_NAMES.positions]: () => {
        throw new Error('{"code":-2015,"msg":"Invalid API-key, IP, or permissions for action"}');
      },
      [TOOL_NAMES.openOrders]: [],
    }),
  );

  const account = await provider.fetchAccount();
  assert.deepEqual(account.positions, []);
  assert.equal(account.degraded.length, 1);
  assert.equal(account.degraded[0].source, "positions");
  assert.match(account.degraded[0].reason, /-2015/);
});

test("a degraded source blocks, because absent is not the same as empty", () => {
  const decision = evaluate({
    action: { symbol: "ETHUSDT", side: "BUY", quantity: 2, orderType: "MARKET" },
    account: {
      ...DIVERSIFIED,
      fetchedAt: 1_700_000_000_000,
      degraded: [{ source: "positions", reason: "-2015 permissions" }],
    },
    thresholds: resolveThresholds(),
    now: 1_700_000_000_000,
  });

  assert.equal(decision.verdict, "BLOCK");
  const violation = decision.violations.find((v) => v.rule === "source_unavailable");
  assert.ok(violation, "the unreadable source is named");
  assert.match(violation.explanation, /understated/);
});

test("unreadable balances are fatal rather than degraded", async () => {
  // Without balances there is no equity, and every ratio divides by it.
  const provider = new AgentOsProvider(
    stubClient({
      [TOOL_NAMES.balances]: () => {
        throw new Error("gateway unavailable");
      },
      [TOOL_NAMES.positions]: [],
      [TOOL_NAMES.openOrders]: [],
    }),
  );
  await assert.rejects(() => provider.fetchAccount(), /gateway unavailable/);
});

test("marks are fetched one symbol at a time, not as an array", async () => {
  // The gateway serializes a `symbols` array with spaces and Binance rejects it
  // with -1100, so the batch form is not used.
  const seen = [];
  const provider = new AgentOsProvider(
    stubClient({
      [TOOL_NAMES.markPrices]: ({ symbol, symbols }) => {
        assert.equal(symbols, undefined, "no array form");
        seen.push(symbol);
        return { symbol, price: "100" };
      },
    }),
  );

  const { markPrices } = await provider.fetchMarks(["BTCUSDT", "ETHUSDT"]);
  assert.deepEqual(seen, ["BTCUSDT", "ETHUSDT"]);
  assert.deepEqual(markPrices, { BTCUSDT: 100, ETHUSDT: 100 });
});

test("one unpriceable symbol does not take the others down", async () => {
  const provider = new AgentOsProvider(
    stubClient({
      [TOOL_NAMES.markPrices]: ({ symbol }) => {
        if (symbol === "DEADUSDT") throw new Error("-1121 invalid symbol");
        return { symbol, price: "42" };
      },
    }),
  );

  const { markPrices } = await provider.fetchMarks(["BTCUSDT", "DEADUSDT"]);
  assert.deepEqual(markPrices, { BTCUSDT: 42 });
  // The missing symbol is absent rather than defaulted; the engine blocks on it.
  assert.equal(markPrices.DEADUSDT, undefined);
});
