import test from "node:test";
import assert from "node:assert/strict";

import { mintApproval, verifyApproval, resetApprovals } from "../src/approval.js";

/**
 * Signed approvals.
 *
 * `check_action` alone is advisory. These tests cover the part that is not: an
 * approval commits to one order, cannot be forged without the signing key,
 * cannot be stretched to a larger order, and cannot be spent twice.
 */

const action = { symbol: "ETHUSDT", side: "BUY", quantity: 5, orderType: "MARKET" };
const order = { symbol: "ETHUSDT", side: "BUY", quantity: 5, orderType: "MARKET" };

const allow = (over = {}) =>
  mintApproval({ action, verdict: "ALLOW", suggestedQuantity: null, ...over });

test.beforeEach(() => resetApprovals());

test("a BLOCK mints nothing at all", () => {
  // The absence of a token is the refusal. There is no such thing as an
  // approval that says no.
  assert.equal(mintApproval({ action, verdict: "BLOCK", suggestedQuantity: null }), null);
});

test("an approval verifies against the order it was issued for", () => {
  const approval = allow();
  const result = verifyApproval(approval.token, order);

  assert.equal(result.valid, true);
  assert.equal(result.verdict, "ALLOW");
  assert.deepEqual(result.approved, {
    symbol: "ETHUSDT",
    side: "BUY",
    orderType: "MARKET",
    maxQuantity: 5,
  });
});

test("ALLOW_REDUCED binds the reduced size, not the requested one", () => {
  const approval = mintApproval({
    action,
    verdict: "ALLOW_REDUCED",
    suggestedQuantity: 3.3333,
  });

  assert.equal(approval.maxQuantity, 3.3333);

  // The whole point: the caller asked for 5 and holds an approval good for
  // 3.3333. Presenting the original request is refused.
  const stretched = verifyApproval(approval.token, { ...order, quantity: 5 });
  assert.equal(stretched.valid, false);
  assert.equal(stretched.code, "QUANTITY_EXCEEDED");

  resetApprovals();
  const honest = verifyApproval(
    mintApproval({ action, verdict: "ALLOW_REDUCED", suggestedQuantity: 3.3333 }).token,
    { ...order, quantity: 3.3333 },
  );
  assert.equal(honest.valid, true);
});

test("trading less than approved is permitted", () => {
  // An executor that fills partially, or sizes down for its own reasons, has
  // not exceeded what the guardrail allowed.
  const result = verifyApproval(allow().token, { ...order, quantity: 1 });
  assert.equal(result.valid, true);
});

test("trading more than approved is refused", () => {
  const result = verifyApproval(allow().token, { ...order, quantity: 5.0001 });
  assert.equal(result.valid, false);
  assert.equal(result.code, "QUANTITY_EXCEEDED");
});

test("an approval is single-use", () => {
  const approval = allow();

  assert.equal(verifyApproval(approval.token, order).valid, true);

  const replay = verifyApproval(approval.token, order);
  assert.equal(replay.valid, false);
  assert.equal(replay.code, "ALREADY_USED");
});

test("an expired approval is refused", () => {
  const now = 1_700_000_000_000;
  const approval = mintApproval({ action, verdict: "ALLOW", suggestedQuantity: null, ttlMs: 60_000, now });

  assert.equal(verifyApproval(approval.token, order, { now: now + 30_000 }).valid, true);

  resetApprovals();
  const late = verifyApproval(approval.token, order, { now: now + 61_000 });
  assert.equal(late.valid, false);
  assert.equal(late.code, "EXPIRED");
});

test("a tampered payload does not verify", () => {
  const approval = allow();
  const [version, payload, signature] = approval.token.split(".");

  // Rewrite the approved quantity to 500 and keep the original signature.
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  decoded.maxQty = 500;
  const forged = Buffer.from(JSON.stringify(decoded)).toString("base64url");

  const result = verifyApproval(`${version}.${forged}.${signature}`, { ...order, quantity: 500 });
  assert.equal(result.valid, false);
  assert.equal(result.code, "BAD_SIGNATURE");
});

test("an approval for one symbol does not authorize another", () => {
  const result = verifyApproval(allow().token, { ...order, symbol: "BTCUSDT" });
  assert.equal(result.valid, false);
  assert.equal(result.code, "SYMBOL_MISMATCH");
});

test("an approval to buy does not authorize a sell", () => {
  const result = verifyApproval(allow().token, { ...order, side: "SELL" });
  assert.equal(result.valid, false);
  assert.equal(result.code, "SIDE_MISMATCH");
});

test("an approval for a market order does not authorize a different type", () => {
  const result = verifyApproval(allow().token, { ...order, orderType: "LIMIT" });
  assert.equal(result.valid, false);
  assert.equal(result.code, "TYPE_MISMATCH");
});

test("garbage is rejected as malformed, not as a crash", () => {
  for (const bad of ["", "not-a-token", "lyp1.only-two", "wrong1.a.b", null, 42, {}]) {
    const result = verifyApproval(bad, order);
    assert.equal(result.valid, false, `rejected: ${JSON.stringify(bad)}`);
    assert.ok(["MALFORMED", "BAD_SIGNATURE"].includes(result.code));
  }
});

test("a failed verification does not consume the approval", () => {
  const approval = allow();

  // A mismatched order should not burn a legitimate approval, or an executor
  // that fat-fingers one field would be forced to re-check from scratch.
  assert.equal(verifyApproval(approval.token, { ...order, quantity: 99 }).valid, false);
  assert.equal(verifyApproval(approval.token, order).valid, true);
});

test("verification can be previewed without consuming", () => {
  const approval = allow();

  assert.equal(verifyApproval(approval.token, order, { consume: false }).valid, true);
  assert.equal(verifyApproval(approval.token, order).valid, true, "still spendable after a preview");
  assert.equal(verifyApproval(approval.token, order).code, "ALREADY_USED");
});
