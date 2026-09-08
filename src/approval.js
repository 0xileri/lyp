import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Signed approvals.
 *
 * `check_action` on its own is advisory: a caller asks, gets a verdict, and is
 * then trusted to obey it. Inside this project's own agent that trust is not
 * required, because `propose_trade` is the only tool the model can reach. For
 * any third-party agent pointing at the MCP endpoint, it is required entirely
 * — such a caller can check one ETH, receive ALLOW, and trade a hundred.
 *
 * An approval closes the gap as far as it can honestly be closed. A permitted
 * verdict mints a short-lived token that commits to the exact order it
 * approved: symbol, side, order type, and a *maximum* quantity. Anything an
 * executor can verify, and nothing it can forge.
 *
 * What this does not do, stated plainly: it cannot force an executor to check.
 * This service never touches the exchange, so it has no chokepoint to stand in
 * — unlike a design where the guardrail *is* the executor. What it converts is
 * "the guardrail said yes, trust me" into "here is proof the guardrail said
 * yes, to this order, at this time, once". Enforcement still belongs to
 * whoever places the order; this makes their obligation checkable rather than
 * assumed, and makes an unapproved order visibly unapproved after the fact.
 *
 * A BLOCK mints nothing. The absence of a token is the refusal.
 */

const VERSION = "lyp1";
const DEFAULT_TTL_MS = 60_000;

/**
 * Signing key.
 *
 * A configured key survives restarts and is shared across replicas. Without
 * one, a per-process random key is generated so the feature still works out of
 * the box — at the cost that tokens do not outlive the process and are not
 * valid on a sibling replica. `keySource` reports which case is in effect
 * rather than leaving an operator to guess.
 */
const CONFIGURED_KEY = process.env.GUARDRAIL_SIGNING_KEY || null;
const SIGNING_KEY = CONFIGURED_KEY ?? randomBytes(32).toString("hex");

export const keySource = CONFIGURED_KEY ? "configured" : "ephemeral";

const b64url = (buf) => Buffer.from(buf).toString("base64url");

function sign(payloadB64) {
  return createHmac("sha256", SIGNING_KEY).update(payloadB64).digest();
}

/**
 * Approvals already spent, and approvals that have expired.
 *
 * Single-use is the property that stops one approval authorising a stream of
 * orders. The store is in memory, which is a real limitation and is documented
 * rather than hidden: across N replicas an approval could in principle be
 * redeemed once per replica. A shared store would fix that and would also make
 * the guardrail fail when the store does, which is the wrong trade for a
 * component whose job is to keep answering.
 */
const spent = new Map();

function prune(now) {
  for (const [jti, exp] of spent) {
    if (exp <= now) spent.delete(jti);
  }
}

/**
 * Mint an approval for a permitted verdict.
 *
 * `maxQuantity` is the size the guardrail actually permits, which on an
 * ALLOW_REDUCED is the reduced size and not the size that was requested. That
 * distinction is the entire point of binding it into the signature.
 *
 * Returns null for BLOCK — there is nothing to approve.
 */
export function mintApproval({ action, verdict, suggestedQuantity, ttlMs = DEFAULT_TTL_MS, now = Date.now() }) {
  if (verdict === "BLOCK") return null;

  const maxQuantity = verdict === "ALLOW_REDUCED" ? suggestedQuantity : action.quantity;
  if (!(maxQuantity > 0)) return null;

  const payload = {
    v: 1,
    sym: action.symbol,
    side: action.side,
    type: action.orderType,
    maxQty: maxQuantity,
    verdict,
    iat: Math.floor(now / 1000),
    exp: Math.floor((now + ttlMs) / 1000),
    jti: randomBytes(12).toString("base64url"),
  };

  const payloadB64 = b64url(JSON.stringify(payload));
  const token = `${VERSION}.${payloadB64}.${b64url(sign(payloadB64))}`;

  return {
    token,
    maxQuantity,
    expiresAt: new Date(payload.exp * 1000).toISOString(),
    // Repeated in the clear so a caller can read the terms without decoding,
    // while the signature remains the only thing that makes them binding.
    binds: { symbol: payload.sym, side: payload.side, orderType: payload.type, maxQuantity },
  };
}

/** Reasons a verification fails, as stable machine-readable codes. */
export const REJECTIONS = {
  MALFORMED: "the approval is not a well-formed token",
  BAD_SIGNATURE: "the signature does not match; the approval was not issued by this guardrail",
  EXPIRED: "the approval has expired",
  ALREADY_USED: "the approval has already been redeemed; approvals are single-use",
  SYMBOL_MISMATCH: "the order is for a different symbol than the approval",
  SIDE_MISMATCH: "the order is for a different side than the approval",
  TYPE_MISMATCH: "the order is a different order type than the approval",
  QUANTITY_EXCEEDED: "the order is larger than the approved maximum",
};

/**
 * Verify an approval against the order an executor is about to place, and
 * consume it.
 *
 * Trading *less* than the approved maximum is fine — an executor that fills
 * partially, or sizes down for its own reasons, has not exceeded what the
 * guardrail permitted. Trading more is the case this exists to catch.
 */
export function verifyApproval(token, order, { now = Date.now(), consume = true } = {}) {
  const reject = (code) => ({ valid: false, code, reason: REJECTIONS[code] });

  if (typeof token !== "string") return reject("MALFORMED");
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return reject("MALFORMED");

  const [, payloadB64, sigB64] = parts;

  let expected;
  let provided;
  try {
    expected = sign(payloadB64);
    provided = Buffer.from(sigB64, "base64url");
  } catch {
    return reject("MALFORMED");
  }
  // Length is checked first because timingSafeEqual throws on a mismatch, and
  // the comparison itself is constant-time so a forged signature leaks nothing
  // about how close it was.
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return reject("BAD_SIGNATURE");
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return reject("MALFORMED");
  }

  prune(now);
  if (payload.exp * 1000 <= now) return reject("EXPIRED");
  if (spent.has(payload.jti)) return reject("ALREADY_USED");

  if (order.symbol?.toUpperCase() !== payload.sym) return reject("SYMBOL_MISMATCH");
  if (order.side !== payload.side) return reject("SIDE_MISMATCH");
  if (order.orderType !== payload.type) return reject("TYPE_MISMATCH");
  if (!(Number(order.quantity) <= payload.maxQty)) return reject("QUANTITY_EXCEEDED");

  if (consume) spent.set(payload.jti, payload.exp * 1000);

  return {
    valid: true,
    verdict: payload.verdict,
    approved: { symbol: payload.sym, side: payload.side, orderType: payload.type, maxQuantity: payload.maxQty },
    issuedAt: new Date(payload.iat * 1000).toISOString(),
    expiresAt: new Date(payload.exp * 1000).toISOString(),
  };
}

/** Test seam: forget every redeemed approval. */
export function resetApprovals() {
  spent.clear();
}
