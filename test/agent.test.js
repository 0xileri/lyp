import test from "node:test";
import assert from "node:assert/strict";

import { createTools, RunLog } from "../agent/tools.js";

/**
 * The agent's structural guarantee.
 *
 * The claim under test is that the guardrail is not something the agent is
 * asked to consult — it is something it cannot avoid. That has to be provable
 * without a model in the loop, or it is a claim about a prompt rather than
 * about the system. Every test here drives the tool layer directly, with a
 * stubbed guardrail, and no API key is required to run any of them.
 */

/** A stand-in for the MCP connection to lyp, recording what it was asked. */
function stubGuardrail(verdicts = {}) {
  const calls = [];
  return {
    calls,
    async call(name, args) {
      calls.push({ name, args });
      if (name === "account_risk") {
        return {
          accountSnapshot: { equity: 100_000, totalNotional: 30_000, positionCount: 1 },
          leverage: 0.3,
          positions: [{ symbol: "ETHUSDT", markPrice: 3000, notional: 30_000 }],
          markPrices: { ETHUSDT: 3000, BTCUSDT: 79_000 },
          clusterExposure: {},
          stale: false,
        };
      }
      if (name === "check_action") {
        return (
          verdicts[args.action.symbol] ?? {
            verdict: "ALLOW",
            suggestedQuantity: null,
            violations: [],
            narration: null,
          }
        );
      }
      throw new Error(`unexpected tool ${name}`);
    },
    async close() {},
  };
}

const propose = (tools, over = {}) =>
  tools.handlers.propose_trade({
    symbol: "ETHUSDT",
    side: "BUY",
    quantity: 5,
    orderType: "MARKET",
    reasoning: "test",
    ...over,
  });

test("the only action-shaped tool is propose_trade", () => {
  const tools = createTools({ guardrail: stubGuardrail() });
  const names = tools.definitions.map((d) => d.name).sort();
  assert.deepEqual(names, ["get_account_risk", "get_market_price", "propose_trade"]);

  // Nothing in the tool surface can place, cancel or settle an order. If a tool
  // is ever added that can, this assertion is where it gets caught.
  const forbidden = /place|execute|submit|cancel|withdraw|transfer/i;
  assert.ok(!names.some((n) => forbidden.test(n)), "no execution tool is exposed");
});

test("every proposal consults the guardrail before it counts", async () => {
  const guardrail = stubGuardrail();
  const tools = createTools({ guardrail });

  await propose(tools);

  const checks = guardrail.calls.filter((c) => c.name === "check_action");
  assert.equal(checks.length, 1, "check_action was called exactly once");
  assert.deepEqual(checks[0].args.action, {
    symbol: "ETHUSDT",
    side: "BUY",
    quantity: 5,
    orderType: "MARKET",
  });
});

test("a BLOCK is a refusal the agent cannot act on", async () => {
  const tools = createTools({
    guardrail: stubGuardrail({
      ETHUSDT: {
        verdict: "BLOCK",
        suggestedQuantity: null,
        violations: [{ rule: "position_size", severity: "block" }],
        narration: null,
      },
    }),
  });

  const result = await propose(tools);

  assert.equal(result.verdict, "BLOCK");
  assert.equal(result.effectiveQuantity, 0, "nothing is tradable on a block");
  assert.equal(result.executed, false);
  assert.match(result.note, /REFUSED/);
  assert.equal(tools.log.blocked.length, 1);
  assert.equal(tools.log.permitted.length, 0);
});

test("ALLOW_REDUCED records the reduced size, not the requested one", async () => {
  const tools = createTools({
    guardrail: stubGuardrail({
      ETHUSDT: {
        verdict: "ALLOW_REDUCED",
        suggestedQuantity: 3.3333,
        violations: [{ rule: "position_size", severity: "reduce" }],
        narration: null,
      },
    }),
  });

  const result = await propose(tools, { quantity: 5 });

  assert.equal(result.effectiveQuantity, 3.3333);
  // The distinction that matters: the agent asked for 5 and the record says
  // 3.3333. A log that stored the request would misreport the book.
  const [entry] = tools.log.proposals;
  assert.equal(entry.requested.quantity, 5);
  assert.equal(entry.effectiveQuantity, 3.3333);
});

test("no verdict, including ALLOW, results in an executed order", async () => {
  const tools = createTools({ guardrail: stubGuardrail() });
  const result = await propose(tools);

  assert.equal(result.verdict, "ALLOW");
  assert.equal(result.executed, false);
  assert.match(result.note, /no order was placed/);
});

test("leverage is forwarded to the guardrail when present, omitted when not", async () => {
  const guardrail = stubGuardrail();
  const tools = createTools({ guardrail });

  await propose(tools);
  await propose(tools, { leverage: 20 });

  const [spot, levered] = guardrail.calls.filter((c) => c.name === "check_action");
  assert.ok(!("leverage" in spot.args.action), "spot proposals carry no leverage field");
  assert.equal(levered.args.action.leverage, 20);
});

test("the book is re-read after a proposal rather than served from cache", async () => {
  const guardrail = stubGuardrail();
  const tools = createTools({ guardrail });

  await tools.handlers.get_account_risk();
  await tools.handlers.get_account_risk();
  assert.equal(
    guardrail.calls.filter((c) => c.name === "account_risk").length,
    1,
    "repeated reads inside one decision are cached",
  );

  await propose(tools);
  await tools.handlers.get_account_risk();
  assert.equal(
    guardrail.calls.filter((c) => c.name === "account_risk").length,
    2,
    "exposure changed, so the next read goes back to the guardrail",
  );
});

test("a symbol with no price is reported rather than guessed", async () => {
  const tools = createTools({ guardrail: stubGuardrail() });
  const result = await tools.handlers.get_market_price({ symbol: "DOGEUSDT" });

  assert.equal(result.price, null);
  assert.match(result.error, /No price available/);
});

test("market data falls back to guardrail marks when Agent OS is unavailable", async () => {
  const market = {
    async call() {
      throw new Error("401 Unauthorized");
    },
    async close() {},
  };
  const tools = createTools({ guardrail: stubGuardrail(), market });

  const result = await tools.handlers.get_market_price({ symbol: "ETHUSDT" });

  // Degrading to the guardrail's own marks keeps the run going, and the source
  // is labelled so the difference is never invisible.
  assert.equal(result.price, 3000);
  assert.equal(result.source, "guardrail-marks");
});

test("the run log separates what was asked from what was permitted", async () => {
  const log = new RunLog();
  const tools = createTools({
    guardrail: stubGuardrail({
      BTCUSDT: { verdict: "BLOCK", suggestedQuantity: null, violations: [], narration: null },
    }),
    log,
  });

  await propose(tools, { symbol: "ETHUSDT", quantity: 2 });
  await propose(tools, { symbol: "BTCUSDT", quantity: 1 });

  assert.equal(log.proposals.length, 2);
  assert.equal(log.permitted.length, 1);
  assert.equal(log.blocked.length, 1);
  assert.equal(log.blocked[0].requested.symbol, "BTCUSDT");
});

test("a symbol the book does not hold can still be priced", async () => {
  // The case that matters when opening a position rather than adding to one.
  // An earlier version could only price symbols already held, which meant the
  // agent went blind at exactly the moment it needed a price.
  const tools = createTools({ guardrail: stubGuardrail() });
  const result = await tools.handlers.get_market_price({ symbol: "BTCUSDT" });

  assert.equal(result.price, 79_000);
  assert.equal(result.source, "guardrail-marks");
});
