import test from "node:test";
import assert from "node:assert/strict";

import { evaluate } from "../src/engine/rules.js";
import { resolveThresholds } from "../src/config.js";
import { clusterOf, baseAssetOf } from "../src/engine/clusters.js";
import {
  DIVERSIFIED,
  CLUSTER_HEAVY,
  LEVERED_NEAR_LIQ,
  NEAR_EXPOSURE_CAP,
  LOPSIDED,
  MISSING_MARK,
} from "../fixtures/accounts.js";

/**
 * Rules engine tests.
 *
 * Every case pins the arithmetic in a comment, because a threshold test that
 * only asserts "something fired" passes just as happily when the wrong rule
 * fires for the wrong reason.
 */

const NOW = 1_700_000_000_000;
const T = resolveThresholds();

function check(action, fixture, opts = {}) {
  return evaluate({
    action: { orderType: "MARKET", ...action },
    account: { ...fixture, fetchedAt: opts.fetchedAt ?? NOW },
    thresholds: opts.thresholds ?? T,
    activityCount: opts.activityCount ?? 0,
    now: NOW,
  });
}

const rules = (r) => r.violations.map((v) => v.rule).sort();
const rule = (r, name) => r.violations.find((v) => v.rule === name);

// --- the clean case --------------------------------------------------------

test("clean action on a diversified book is allowed with no violations", () => {
  // ETH 2 @ 3,000 = 6,000 notional.
  //   position size  6,000 / 100,000            = 6.0%   (soft 10%)
  //   exposure      36,000 / 100,000            = 0.36x  (soft 1.5x)
  //   concentration  6,000 /  36,000            = 16.7%  (soft 35%)
  //   majors        15,000 /  36,000            = 41.7%  (soft 55%)
  const r = check({ symbol: "ETHUSDT", side: "BUY", quantity: 2 }, DIVERSIFIED);

  assert.equal(r.verdict, "ALLOW");
  assert.deepEqual(r.violations, []);
  assert.equal(r.suggestedQuantity, null);
});

// --- each rule in isolation ------------------------------------------------

test("position size: over soft, under hard, is reduced to the soft cap", () => {
  // ETH 5 @ 3,000 = 15,000 = 15% of equity: over soft 10%, under hard 25%.
  // Cap = 10% * 100,000 / 3,000 = 3.333 ETH.
  const r = check({ symbol: "ETHUSDT", side: "BUY", quantity: 5 }, DIVERSIFIED);

  assert.equal(r.verdict, "ALLOW_REDUCED");
  assert.deepEqual(rules(r), ["position_size"]);
  assert.equal(rule(r, "position_size").severity, "reduce");
  assert.ok(Math.abs(r.suggestedQuantity - 10 / 3) < 1e-9, `got ${r.suggestedQuantity}`);
});

test("position size: over the hard ceiling blocks", () => {
  // ETH 12 @ 3,000 = 36,000 = 36% of equity, past the 25% hard ceiling.
  const r = check({ symbol: "ETHUSDT", side: "BUY", quantity: 12 }, DIVERSIFIED);

  assert.equal(r.verdict, "BLOCK");
  assert.equal(rule(r, "position_size").severity, "block");
  assert.equal(r.suggestedQuantity, null, "a blocked action never carries a suggested quantity");
});

test("total exposure: a small order that pushes the book past the leverage cap", () => {
  // Book is 30,000 against 21,000 equity = 1.43x, under the 1.5x soft cap.
  // ADA 4,000 @ 0.5 = 2,000 notional, only 9.5% of equity, so position size
  // stays quiet -- but the book lands at 32,000 / 21,000 = 1.52x.
  // Cap = (1.5 * 21,000 - 30,000) / 0.5 = 3,000 ADA.
  const r = check({ symbol: "ADAUSDT", side: "BUY", quantity: 4_000 }, NEAR_EXPOSURE_CAP);

  assert.deepEqual(rules(r), ["total_exposure"]);
  assert.equal(r.verdict, "ALLOW_REDUCED");
  assert.ok(Math.abs(r.suggestedQuantity - 3_000) < 1e-6, `got ${r.suggestedQuantity}`);
});

test("concentration: a position modest against equity but large against the book", () => {
  // Book is one 15,000 BTC position. ADA 20,000 @ 0.5 = 10,000 notional,
  // exactly 10% of equity so position size does not fire, but that is
  // 10,000 / 25,000 = 40% of the book, past the 35% soft limit.
  // Cap = 35% * 15,000 / 65% = 8,077 notional = 16,154 ADA.
  const r = check({ symbol: "ADAUSDT", side: "BUY", quantity: 20_000 }, LOPSIDED);

  assert.deepEqual(rules(r), ["concentration"]);
  assert.equal(r.verdict, "ALLOW_REDUCED");
  assert.ok(Math.abs(r.suggestedQuantity - (0.35 * 15_000) / 0.65 / 0.5) < 1e-6);
});

test("correlation: buying into an already-dominant cluster blocks", () => {
  // Book: BTC 36,000 (majors) + SOL 6,000 (l1s) = 42,000.
  // ETH 1 @ 3,000 = 3,000, a trivial 3% of equity and 6.7% of the book, so
  // every single-symbol rule passes. Majors reach 39,000 / 45,000 = 86.7%,
  // past the 80% hard cluster limit.
  const r = check({ symbol: "ETHUSDT", side: "BUY", quantity: 1 }, CLUSTER_HEAVY);

  assert.deepEqual(rules(r), ["correlation"], "no single-symbol rule should fire here");
  assert.equal(r.verdict, "BLOCK");
  assert.match(rule(r, "correlation").explanation, /majors/);
});

test("liquidation distance: no new risk while a position sits near liquidation", () => {
  // SOL is 10x with liquidation at 138 against a mark of 150 -- 8% away,
  // inside the 15% minimum. The proposed ETH buy is unlevered and tiny, but it
  // still adds exposure, so it is refused.
  const r = check({ symbol: "ETHUSDT", side: "BUY", quantity: 1 }, LEVERED_NEAR_LIQ);

  assert.deepEqual(rules(r), ["liquidation_distance"]);
  assert.equal(r.verdict, "BLOCK");
  assert.ok(Math.abs(rule(r, "liquidation_distance").actual - 0.08) < 1e-9);
});

test("liquidation distance: a levered position of its own is estimated from leverage", () => {
  // 20x on a clean book: 1/20 - 0.005 = 4.5% from liquidation, inside 15%.
  const r = check(
    { symbol: "ETHUSDT", side: "BUY", quantity: 1, leverage: 20 },
    { ...DIVERSIFIED, positions: [] },
  );

  assert.equal(r.verdict, "BLOCK");
  const v = rule(r, "liquidation_distance");
  assert.ok(Math.abs(v.actual - 0.045) < 1e-9);
  assert.match(v.explanation, /estimated from leverage/);
});

test("activity rate: at the ceiling, blocks", () => {
  const r = check({ symbol: "ETHUSDT", side: "BUY", quantity: 2 }, DIVERSIFIED, { activityCount: 40 });

  assert.equal(r.verdict, "BLOCK");
  assert.equal(rule(r, "activity_rate").severity, "block");
});

test("activity rate: past the warning level but under the ceiling does not block", () => {
  const r = check({ symbol: "ETHUSDT", side: "BUY", quantity: 2 }, DIVERSIFIED, { activityCount: 25 });

  assert.equal(r.verdict, "ALLOW");
  assert.equal(rule(r, "activity_rate").severity, "warn");
});

// --- combinations ----------------------------------------------------------

test("several rules fire together and all are reported, not just the worst", () => {
  // ETH 7 @ 3,000 = 21,000:
  //   position size  21,000 / 100,000 = 21%    -> reduce, cap 3.333 ETH
  //   concentration  21,000 /  51,000 = 41.2%  -> reduce, cap 5.385 ETH
  //   majors         30,000 /  51,000 = 58.8%  -> reduce, cap 5.556 ETH
  const r = check({ symbol: "ETHUSDT", side: "BUY", quantity: 7 }, DIVERSIFIED);

  assert.equal(r.verdict, "ALLOW_REDUCED");
  assert.deepEqual(rules(r), ["concentration", "correlation", "position_size"]);
  assert.ok(
    Math.abs(r.suggestedQuantity - 10 / 3) < 1e-9,
    "the strictest rule sets the suggested quantity",
  );
});

test("a blocking rule outranks reducing rules in the same response", () => {
  const r = check({ symbol: "ETHUSDT", side: "BUY", quantity: 12 }, DIVERSIFIED);

  assert.equal(r.verdict, "BLOCK");
  assert.ok(r.violations.length > 1, "reducing rules are still reported alongside the block");
  assert.ok(r.violations.some((v) => v.severity === "reduce"));
});

// --- the cluster concept ---------------------------------------------------

test("a cluster is treated as one position: same size, different cluster, allowed", () => {
  // The mirror of the correlation test. Same book, same 3,000 notional, but
  // into a cluster that is not already dominant -- so it passes.
  const r = check({ symbol: "AVAXUSDT", side: "BUY", quantity: 100 }, CLUSTER_HEAVY);

  assert.equal(r.verdict, "ALLOW");
  assert.deepEqual(r.violations, []);
});

test("cluster membership is derived from the base asset, not the pair string", () => {
  assert.equal(baseAssetOf("BTCUSDT"), "BTC");
  assert.equal(baseAssetOf("ETHBTC"), "ETH", "longest quote suffix wins");
  assert.equal(clusterOf("DOGEUSDT"), "memes");
  assert.equal(clusterOf("SOLUSDT"), "l1s");
  assert.equal(clusterOf("XYZUSDT"), null, "unknown assets are unclustered, not misfiled");
});

// --- refusals that are not about size --------------------------------------

test("stale account state blocks an otherwise clean action", () => {
  const r = check({ symbol: "ETHUSDT", side: "BUY", quantity: 2 }, DIVERSIFIED, {
    fetchedAt: NOW - 90_000, // 90s old, past the 60s limit
  });

  assert.equal(r.verdict, "BLOCK");
  assert.deepEqual(rules(r), ["stale_account_state"]);
  assert.match(rule(r, "stale_account_state").explanation, /Stale account state/);
});

test("fresh account state inside the limit does not block", () => {
  const r = check({ symbol: "ETHUSDT", side: "BUY", quantity: 2 }, DIVERSIFIED, {
    fetchedAt: NOW - 30_000,
  });

  assert.equal(r.verdict, "ALLOW");
});

test("a missing mark price blocks rather than skipping the size rules", () => {
  const r = check({ symbol: "ETHUSDT", side: "BUY", quantity: 2 }, MISSING_MARK);

  assert.equal(r.verdict, "BLOCK");
  assert.deepEqual(rules(r), ["market_data"]);
});

test("an unparseable mark price is treated as missing", () => {
  const r = check({ symbol: "ETHUSDT", side: "BUY", quantity: 2 }, {
    ...DIVERSIFIED,
    markPrices: { ...DIVERSIFIED.markPrices, ETHUSDT: NaN },
  });

  assert.equal(r.verdict, "BLOCK");
  assert.deepEqual(rules(r), ["market_data"]);
});

// --- direction awareness ---------------------------------------------------

test("an action that improves a breached limit is reported but never blocked", () => {
  // Halving a 36,000 BTC position on a book that is 86% BTC. Afterwards BTC is
  // still 75% of the book, over the 60% hard limit -- but it was 86% before.
  // Blocking this sell would be refusing the only trade that fixes the problem.
  const r = check({ symbol: "BTCUSDT", side: "SELL", quantity: 0.3 }, CLUSTER_HEAVY);

  assert.equal(r.verdict, "ALLOW");
  assert.ok(r.violations.length > 0, "the breach is still reported");
  assert.ok(
    r.violations.every((v) => v.severity === "warn"),
    "an improving action produces warnings, not blocks",
  );
  assert.match(rule(r, "concentration").explanation, /moves that number down/);
});

test("a deleveraging sell is allowed even while a position is near liquidation", () => {
  // Selling half of the 10x SOL position. Concentration is still over its soft
  // limit afterwards (55.6%), but down from 71.4%.
  const r = check({ symbol: "SOLUSDT", side: "SELL", quantity: 50 }, LEVERED_NEAR_LIQ);

  assert.equal(r.verdict, "ALLOW", "the fix for a near-liquidation position must not be blocked");
  assert.ok(r.violations.every((v) => v.severity === "warn"));
});

test("an action that worsens an already-breached limit is still blocked", () => {
  // The mirror image: same book, buying more BTC rather than selling it.
  const r = check({ symbol: "BTCUSDT", side: "BUY", quantity: 0.1 }, CLUSTER_HEAVY);

  assert.equal(r.verdict, "BLOCK");
  assert.ok(r.violations.some((v) => v.severity === "block"));
});

// --- overrides -------------------------------------------------------------

test("per-request thresholds can tighten a limit that the defaults allow", () => {
  const strict = resolveThresholds({ positionSize: { soft: 0.02, hard: 0.04 } });
  const r = check({ symbol: "ETHUSDT", side: "BUY", quantity: 2 }, DIVERSIFIED, { thresholds: strict });

  // 6% of equity: fine by default, past a 4% hard ceiling.
  assert.equal(r.verdict, "BLOCK");
  assert.equal(rule(r, "position_size").threshold, 0.04);
});

test("overrides are partial: unspecified fields keep their defaults", () => {
  const t = resolveThresholds({ positionSize: { soft: 0.05 } });

  assert.equal(t.positionSize.soft, 0.05);
  assert.equal(t.positionSize.hard, 0.25, "hard ceiling is untouched");
  assert.equal(t.concentration.soft, 0.35, "unrelated rules are untouched");
});

test("a reduce whose cap is not tradable is reported as a block", () => {
  // Cluster is already past the soft limit on existing positions alone, so no
  // smaller order satisfies it. The engine must not suggest a quantity of zero.
  const loose = resolveThresholds({ clusterConcentration: { soft: 0.55, hard: 0.99 } });
  const r = check({ symbol: "ETHUSDT", side: "BUY", quantity: 1 }, CLUSTER_HEAVY, { thresholds: loose });

  assert.equal(r.verdict, "BLOCK");
  assert.equal(r.suggestedQuantity, null);
  assert.match(rule(r, "correlation").explanation, /No smaller quantity satisfies this limit/);
});

test("a suggested quantity never exceeds what was asked for", () => {
  const r = check({ symbol: "ETHUSDT", side: "BUY", quantity: 3.2 }, DIVERSIFIED);

  if (r.verdict === "ALLOW_REDUCED") {
    assert.ok(r.suggestedQuantity <= 3.2);
  }
});
