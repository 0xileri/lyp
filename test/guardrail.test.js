import test from "node:test";
import assert from "node:assert/strict";

import { Guardrail } from "../src/guardrail.js";
import { ActivityLog } from "../src/activity.js";
import { AccountStateService, FixtureProvider } from "../src/agentos/account.js";
import { VerdictResponseSchema } from "../src/schema.js";
import { DIVERSIFIED, asOf } from "../fixtures/accounts.js";

/**
 * Orchestration tests.
 *
 * The load-bearing one is "the engine works with the model completely
 * removed". Everything about this service's design assumes the narrator is
 * decoration; these tests are what stop that assumption from quietly becoming
 * false.
 */

const NOW = 1_700_000_000_000;

function buildGuardrail({ fixture = DIVERSIFIED, narrator = null, activity = new ActivityLog() } = {}) {
  return new Guardrail({
    stateService: new AccountStateService(new FixtureProvider(asOf(fixture, NOW))),
    narrator,
    activity,
  });
}

const cleanAction = { symbol: "ETHUSDT", side: "BUY", quantity: 2, orderType: "MARKET" };

// --- the model is optional -------------------------------------------------

test("with no narrator configured, the verdict is complete and narration is null", async () => {
  const r = await buildGuardrail().check({ action: cleanAction }, NOW);

  assert.equal(r.verdict, "ALLOW");
  assert.equal(r.narration, null);
  assert.ok(VerdictResponseSchema.safeParse(r).success);
});

test("when the model throws, the verdict is unchanged and narration is null", async () => {
  const failing = {
    narrate: async () => {
      throw new Error("529 overloaded");
    },
  };
  const withModel = await buildGuardrail({ narrator: failing }).check({ action: cleanAction }, NOW);
  const withoutModel = await buildGuardrail().check({ action: cleanAction }, NOW);

  assert.equal(withModel.narration, null);

  // `approval` is excluded because two checks legitimately mint two different
  // approvals -- each carries its own id and expiry, which is precisely what
  // makes them single-use. What must match is the terms they commit to, so
  // those are compared separately below rather than skipped.
  const { approval: withApproval, ...withModelRest } = withModel;
  const { approval: withoutApproval, ...withoutModelRest } = withoutModel;

  assert.deepEqual(withApproval.binds, withoutApproval.binds, "the approved terms are identical");
  assert.notEqual(withApproval.token, withoutApproval.token, "each approval is distinct");

  assert.deepEqual(
    { ...withModelRest, narration: null },
    { ...withoutModelRest, narration: null },
    "a model failure must not perturb any other field",
  );
});

test("when the model hangs, the verdict still returns", async () => {
  // A narrator that never resolves would hang the request if narration were on
  // the critical path. It is not: the Narrator owns its own timeout, and this
  // stand-in rejects the way a timeout does.
  const timingOut = {
    narrate: async () => {
      const err = new Error("Request timed out");
      err.name = "APIConnectionTimeoutError";
      throw err;
    },
  };
  const r = await buildGuardrail({ narrator: timingOut }).check({ action: cleanAction }, NOW);

  assert.equal(r.verdict, "ALLOW");
  assert.equal(r.narration, null);
});

test("the model cannot alter the verdict it is handed", async () => {
  // A narrator that tries to rewrite the object it receives. The response is
  // frozen before it is passed, so the attempt is inert.
  const meddling = {
    narrate: async (verdict) => {
      try {
        verdict.verdict = "ALLOW";
        verdict.suggestedQuantity = 999;
        verdict.violations.length = 0;
      } catch {
        // frozen in strict mode; that is the point
      }
      return "nothing to see here";
    },
  };
  // ETH 12 = 36% of equity: a hard block.
  const r = await buildGuardrail({ narrator: meddling }).check(
    { action: { ...cleanAction, quantity: 12 } },
    NOW,
  );

  assert.equal(r.verdict, "BLOCK");
  assert.equal(r.suggestedQuantity, null);
  assert.ok(r.violations.length > 0);
  assert.equal(r.narration, "nothing to see here");
});

test("narration is attached when the model succeeds", async () => {
  const ok = { narrate: async () => "This was refused because the position was too large." };
  const r = await buildGuardrail({ narrator: ok }).check({ action: { ...cleanAction, quantity: 12 } }, NOW);

  assert.equal(r.verdict, "BLOCK");
  assert.equal(r.narration, "This was refused because the position was too large.");
});

// --- responses are validated on the way out --------------------------------

test("every response satisfies the published schema", async () => {
  const g = buildGuardrail();
  for (const quantity of [2, 5, 12]) {
    const r = await g.check({ action: { ...cleanAction, quantity }, actor: `a${quantity}` }, NOW);
    const parsed = VerdictResponseSchema.safeParse(r);
    assert.ok(parsed.success, `quantity ${quantity}: ${parsed.error?.message}`);
  }
});

test("the account snapshot reports the book the verdict was reached against", async () => {
  const r = await buildGuardrail().check({ action: cleanAction }, NOW);

  assert.equal(r.accountSnapshot.equity, 100_000);
  assert.equal(r.accountSnapshot.totalNotional, 30_000);
  assert.equal(r.accountSnapshot.positionCount, 4);
  assert.equal(r.accountSnapshot.timestamp, new Date(NOW).toISOString());
});

// --- staleness through the full path ---------------------------------------

test("state older than the limit blocks, end to end", async () => {
  const g = buildGuardrail({ fixture: DIVERSIFIED });
  // The fixture is stamped at NOW; ask 90 seconds later.
  const r = await g.check({ action: cleanAction }, NOW + 90_000);

  assert.equal(r.verdict, "BLOCK");
  assert.ok(r.violations.some((v) => v.rule === "stale_account_state"));
});

test("a provider outage degrades to stale cached state, not a crash", async () => {
  let calls = 0;
  const flaky = {
    async fetchAccount() {
      calls += 1;
      if (calls > 1) throw new Error("agent os unreachable");
      return { ...DIVERSIFIED, fetchedAt: NOW };
    },
    async fetchMarks() {
      return { markPrices: DIVERSIFIED.markPrices, fetchedAt: NOW };
    },
  };
  const g = new Guardrail({ stateService: new AccountStateService(flaky) });

  const first = await g.check({ action: cleanAction }, NOW);
  assert.equal(first.verdict, "ALLOW");

  // Well past both the cache TTL and the staleness limit: the fetch fails, the
  // last known state is served, and the staleness rule turns it into a block
  // with a reason rather than a 500 with none.
  const later = await g.check({ action: cleanAction }, NOW + 120_000);
  assert.equal(later.verdict, "BLOCK");
  assert.ok(later.violations.some((v) => v.rule === "stale_account_state"));
});

// --- activity counting -----------------------------------------------------

test("the activity counter is per actor and does not count the request itself", async () => {
  const g = buildGuardrail();

  const first = await g.check({ action: cleanAction, actor: "bot-a" }, NOW);
  assert.equal(first.verdict, "ALLOW", "the first request is never rate limited by itself");

  for (let i = 0; i < 45; i += 1) {
    await g.check({ action: cleanAction, actor: "bot-a" }, NOW + i);
  }

  const throttled = await g.check({ action: cleanAction, actor: "bot-a" }, NOW + 100);
  assert.equal(throttled.verdict, "BLOCK");
  assert.ok(throttled.violations.some((v) => v.rule === "activity_rate"));

  const other = await g.check({ action: cleanAction, actor: "bot-b" }, NOW + 100);
  assert.equal(other.verdict, "ALLOW", "one noisy caller must not throttle another");
});

test("activity outside the window is not counted", () => {
  const log = new ActivityLog();
  log.record("x", NOW);
  log.record("x", NOW + 1_000);

  assert.equal(log.count("x", 60 * 60 * 1000, NOW + 2_000), 2);
  assert.equal(log.count("x", 60 * 60 * 1000, NOW + 3_600_001), 1);
  assert.equal(log.count("x", 60 * 60 * 1000, NOW + 7_200_000), 0);
});

// --- account_risk ----------------------------------------------------------

test("account_risk reports exposure and clusters without reaching a verdict", async () => {
  const r = await buildGuardrail().accountRisk({}, NOW);

  assert.equal(r.accountSnapshot.totalNotional, 30_000);
  assert.ok(Math.abs(r.leverage - 0.3) < 1e-9);
  assert.equal(r.positions.length, 4);
  assert.equal(r.stale, false);
  assert.ok(Math.abs(r.clusterExposure.l1s.notional - 15_000) < 1e-9, "SOL 9,000 + ADA 6,000");
  assert.ok(Math.abs(r.clusterExposure.majors.notional - 9_000) < 1e-9);
  assert.equal(r.verdict, undefined, "account_risk judges nothing");
});
