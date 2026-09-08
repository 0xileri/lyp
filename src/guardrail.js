import { resolveThresholds } from "./config.js";
import { ActivityLog } from "./activity.js";
import { evaluate } from "./engine/rules.js";
import { clusterOf } from "./engine/clusters.js";
import { assertValidResponse } from "./schema.js";
import { mintApproval } from "./approval.js";

/**
 * Orchestration: fetch state, run the deterministic engine, attach optional
 * narration, validate on the way out.
 *
 * The ordering here is the load-bearing part. The verdict object is complete
 * and validated before the narrator is ever invoked, and the narrator receives
 * a frozen copy. There is no code path in which model output can reach the
 * verdict, the violations or the suggested quantity.
 */
export class Guardrail {
  constructor({ stateService, narrator = null, activity = new ActivityLog() }) {
    this.stateService = stateService;
    this.narrator = narrator;
    this.activity = activity;
  }

  /**
   * Evaluate one proposed action.
   *
   * @param {object} req  validated CheckRequest
   * @param {number} now  epoch ms, injected so tests control time
   */
  async check(req, now = Date.now()) {
    const thresholds = resolveThresholds(req.thresholds);
    const actor = req.actor ?? "default";

    const account = await this.stateService.getState([req.action.symbol], now);

    // Counted before recording, so a request is never rate-limited by itself.
    const activityCount = this.activity.count(actor, thresholds.activityRate.windowMs, now);
    this.activity.record(actor, now);

    const decision = evaluate({
      action: req.action,
      account,
      thresholds,
      activityCount,
      now,
    });

    const response = {
      verdict: decision.verdict,
      suggestedQuantity: decision.suggestedQuantity,
      violations: decision.violations,
      accountSnapshot: snapshotOf(account),
      // Minted only for a permitted verdict, and bound to the size actually
      // permitted rather than the size requested. A BLOCK carries no approval:
      // the absence of a token is the refusal.
      approval: mintApproval({
        action: req.action,
        verdict: decision.verdict,
        suggestedQuantity: decision.suggestedQuantity,
        now,
      }),
      narration: null,
    };

    // The verdict is final at this point. Narration is additive and failure of
    // the model leaves the object exactly as it is.
    response.narration = await this.#narrate(response, req.action);

    return assertValidResponse(response);
  }

  /** Current exposure, with no action proposed and no verdict reached. */
  async accountRisk(req = {}, now = Date.now()) {
    const thresholds = resolveThresholds(req.thresholds);
    const account = await this.stateService.getState([], now);
    const snapshot = snapshotOf(account);

    const positions = account.positions.map((p) => {
      const mark = account.markPrices[p.symbol];
      const notional = Number.isFinite(mark) ? Math.abs(p.quantity) * mark : null;
      return {
        symbol: p.symbol,
        side: p.side,
        quantity: p.quantity,
        markPrice: Number.isFinite(mark) ? mark : null,
        notional,
        shareOfExposure: notional && snapshot.totalNotional > 0 ? notional / snapshot.totalNotional : null,
        cluster: clusterOf(p.symbol),
        leverage: p.leverage,
        liquidationPrice: p.liquidationPrice || null,
      };
    });

    const clusters = {};
    for (const p of positions) {
      if (!p.cluster || p.notional === null) continue;
      clusters[p.cluster] = (clusters[p.cluster] ?? 0) + p.notional;
    }

    const ageMs = now - account.fetchedAt;
    return {
      accountSnapshot: snapshot,
      // Every mark the guardrail is using, not only those for held symbols.
      // A caller deciding whether to *open* a position needs the price of
      // something it does not own yet, and without this it would have to guess
      // or go find a second price source that may disagree with the one the
      // verdict is computed against.
      markPrices: account.markPrices,
      leverage: snapshot.equity > 0 ? snapshot.totalNotional / snapshot.equity : null,
      positions,
      clusterExposure: Object.fromEntries(
        Object.entries(clusters).map(([name, notional]) => [
          name,
          {
            notional,
            shareOfExposure: snapshot.totalNotional > 0 ? notional / snapshot.totalNotional : null,
          },
        ]),
      ),
      stale: ageMs > thresholds.staleness.maxAccountAgeMs,
      ageMs,
      thresholds,
    };
  }

  async #narrate(response, action) {
    if (!this.narrator) return null;
    try {
      // Frozen so a narrator implementation cannot mutate the verdict it is
      // describing, deliberately or otherwise.
      return await this.narrator.narrate(Object.freeze(structuredClone(response)), Object.freeze({ ...action }));
    } catch {
      // Narration is cosmetic. A model outage must not change what the
      // guardrail decides, or whether it answers at all.
      return null;
    }
  }
}

/** The four numbers every response carries about the account it judged. */
export function snapshotOf(account) {
  let totalNotional = 0;
  for (const p of account.positions) {
    const mark = account.markPrices[p.symbol];
    if (Number.isFinite(mark)) totalNotional += Math.abs(p.quantity) * mark;
  }
  return {
    equity: Number.isFinite(account.equity) ? account.equity : 0,
    totalNotional,
    positionCount: account.positions.length,
    timestamp: new Date(account.fetchedAt).toISOString(),
  };
}
