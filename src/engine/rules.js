import { clusterOf } from "./clusters.js";

/**
 * The rules engine.
 *
 * Entirely deterministic: same inputs, same verdict, every time. No model is
 * consulted here and none can be. `evaluate` performs no I/O and reads no
 * clock beyond the `now` it is handed, which is the whole point of the
 * component. The language model attached to this service writes prose about
 * the object this function returns; it never participates in producing it.
 *
 * Rules collect violations rather than short-circuiting, so a caller sees every
 * limit their action breaches in one pass instead of fixing one and
 * rediscovering the next.
 */

/** Ordering used to fold many violations into one verdict. */
const SEVERITY_RANK = { warn: 0, reduce: 1, block: 2 };
const VERDICT_FOR_SEVERITY = { warn: "ALLOW", reduce: "ALLOW_REDUCED", block: "BLOCK" };

/**
 * Signed base-asset quantity held in a symbol. Long is positive, short is
 * negative, so adding to a short and reducing a long become the same
 * arithmetic.
 */
function signedQuantity(positions, symbol) {
  let signed = 0;
  for (const p of positions) {
    if (p.symbol !== symbol) continue;
    signed += p.side === "SHORT" ? -Math.abs(p.quantity) : Math.abs(p.quantity);
  }
  return signed;
}

/**
 * Largest action quantity that keeps the resulting position notional within
 * capNotional.
 *
 * The constraint is abs(existingSigned + dir*q) * mark <= capNotional. Solving
 * the upper branch gives q <= capQty - dir*existingSigned, which is why
 * reducing an existing position is never limited by a size cap: dir opposes the
 * sign of the position, and the bound goes up rather than down.
 */
function maxActionQty(existingSigned, dir, capNotional, mark) {
  if (!(mark > 0)) return 0;
  const capQty = capNotional / mark;
  return capQty - dir * existingSigned;
}

/**
 * Everything the rules need to know about the world after the proposed action,
 * computed once.
 *
 * Exposure is measured on resulting positions rather than on the order itself,
 * so an order that closes risk is never charged for it. A SELL that halves a
 * long is a smaller position, and every size rule sees it that way.
 */
export function projectExposure(action, account) {
  const mark = account.markPrices[action.symbol];
  const dir = action.side === "BUY" ? 1 : -1;

  const existingSigned = signedQuantity(account.positions, action.symbol);
  const resultingSigned = existingSigned + dir * action.quantity;

  let otherNotional = 0;
  let otherClusterNotional = 0;
  const actionCluster = clusterOf(action.symbol);

  for (const p of account.positions) {
    if (p.symbol === action.symbol) continue; // folded in via resultingSymbolNotional
    const pMark = account.markPrices[p.symbol];
    if (!(pMark > 0)) continue; // unpriceable positions are caught by the market-data gate
    const notional = Math.abs(p.quantity) * pMark;
    otherNotional += notional;
    if (actionCluster && clusterOf(p.symbol) === actionCluster) otherClusterNotional += notional;
  }

  const resultingSymbolNotional = Math.abs(resultingSigned) * (mark ?? 0);
  const existingSymbolNotional = Math.abs(existingSigned) * (mark ?? 0);

  return {
    mark,
    dir,
    existingSigned,
    resultingSigned,
    otherNotional,
    otherClusterNotional,
    actionCluster,
    existingSymbolNotional,
    resultingSymbolNotional,
    /** Book-wide notional before the action, for the improvement test below. */
    currentTotalNotional: otherNotional + existingSymbolNotional,
    projectedTotalNotional: otherNotional + resultingSymbolNotional,
    /** True when the action makes the symbol's position larger in absolute terms. */
    increasesExposure: Math.abs(resultingSigned) > Math.abs(existingSigned),
  };
}

/** Ratio comparisons are on floats; this absorbs representation noise only. */
const EPSILON = 1e-12;

/**
 * Severity for a measured ratio, given where it started.
 *
 * The `before` comparison is what stops this service from trapping an account
 * in a position it has already flagged. An account sitting at 85% single-name
 * concentration cannot get back under 60% without selling, and a rule that
 * only looked at the resulting state would refuse every one of those sells for
 * still being over the limit. So an action that moves a breached metric toward
 * its limit is reported and allowed, never blocked -- it is the fix, not the
 * cause.
 *
 * @returns {"warn"|"reduce"|"block"|null} null when the limit is respected
 */
function severityFor(after, before, soft, hard) {
  if (after <= soft) return null;
  if (after <= before + EPSILON) return "warn";
  return after > hard ? "block" : "reduce";
}

/** Shared tail for an over-limit-but-improving explanation. */
const IMPROVING = " This action moves that number down rather than up, so it is not blocked.";

/**
 * Distance from mark to liquidation, as a fraction of mark.
 *
 * An exchange-reported liquidation price always wins. For a position that does
 * not exist yet the exchange cannot report one, so this falls back to the
 * standard first-order approximation, 1/leverage - maintenanceMarginRate, which
 * ignores funding, fees and cross-margin offsets. It is an estimate, and the
 * response says so rather than presenting it as exchange truth.
 */
export function liquidationDistance(position, mark, maintenanceMarginRate) {
  if (position.liquidationPrice > 0 && mark > 0) {
    return { distance: Math.abs(mark - position.liquidationPrice) / mark, estimated: false };
  }
  const leverage = position.leverage;
  if (!(leverage > 1)) return null; // unlevered: there is no liquidation price to be near
  return { distance: Math.max(0, 1 / leverage - maintenanceMarginRate), estimated: true };
}

// ---------------------------------------------------------------------------
// Individual rules.
//
// Each returns { violation, cap }, where cap is the largest action quantity
// that would satisfy the soft limit, or null when the rule cannot be satisfied
// by trading smaller.
// ---------------------------------------------------------------------------

function rulePositionSize(action, account, t, ex) {
  if (!(account.equity > 0)) return null;
  const ratio = ex.resultingSymbolNotional / account.equity;
  const before = ex.existingSymbolNotional / account.equity;
  const severity = severityFor(ratio, before, t.positionSize.soft, t.positionSize.hard);
  if (!severity) return null;

  const threshold = severity === "block" ? t.positionSize.hard : t.positionSize.soft;
  return {
    violation: {
      rule: "position_size",
      severity,
      actual: ratio,
      threshold,
      explanation:
        "Resulting " + action.symbol + " position would be " + pct(ratio) + " of equity (" +
        money(ex.resultingSymbolNotional) + " against " + money(account.equity) + "), over the " +
        (severity === "block" ? "hard" : "soft") + " limit of " + pct(threshold) + "." +
        (severity === "warn" ? IMPROVING : ""),
    },
    cap: maxActionQty(ex.existingSigned, ex.dir, t.positionSize.soft * account.equity, ex.mark),
  };
}

function ruleTotalExposure(action, account, t, ex) {
  if (!(account.equity > 0)) return null;
  const ratio = ex.projectedTotalNotional / account.equity;
  const before = ex.currentTotalNotional / account.equity;
  const severity = severityFor(ratio, before, t.totalExposure.soft, t.totalExposure.hard);
  if (!severity) return null;

  const threshold = severity === "block" ? t.totalExposure.hard : t.totalExposure.soft;
  return {
    violation: {
      rule: "total_exposure",
      severity,
      actual: ratio,
      threshold,
      explanation:
        "Book-wide exposure after this action would be " + ratio.toFixed(2) + "x equity (" +
        money(ex.projectedTotalNotional) + " across " + account.positions.length +
        " position(s)), over the " + (severity === "block" ? "hard" : "soft") + " limit of " +
        threshold.toFixed(2) + "x." + (severity === "warn" ? IMPROVING : ""),
    },
    cap: maxActionQty(
      ex.existingSigned,
      ex.dir,
      t.totalExposure.soft * account.equity - ex.otherNotional,
      ex.mark,
    ),
  };
}

function ruleConcentration(action, account, t, ex) {
  if (!(ex.projectedTotalNotional > 0)) return null;
  const ratio = ex.resultingSymbolNotional / ex.projectedTotalNotional;
  const before =
    ex.currentTotalNotional > 0 ? ex.existingSymbolNotional / ex.currentTotalNotional : 0;
  const severity = severityFor(ratio, before, t.concentration.soft, t.concentration.hard);
  if (!severity) return null;

  const threshold = severity === "block" ? t.concentration.hard : t.concentration.soft;

  // n / (other + n) <= soft   =>   n <= soft * other / (1 - soft)
  const soft = t.concentration.soft;
  const capNotional = soft >= 1 ? Infinity : (soft * ex.otherNotional) / (1 - soft);

  return {
    violation: {
      rule: "concentration",
      severity,
      actual: ratio,
      threshold,
      explanation:
        action.symbol + " would be " + pct(ratio) + " of total exposure, over the " +
        (severity === "block" ? "hard" : "soft") + " single-symbol limit of " + pct(threshold) +
        ". Position count is not diversification." + (severity === "warn" ? IMPROVING : ""),
    },
    cap: maxActionQty(ex.existingSigned, ex.dir, capNotional, ex.mark),
  };
}

function ruleCorrelation(action, account, t, ex) {
  if (!ex.actionCluster) return null;
  if (!(ex.projectedTotalNotional > 0)) return null;

  const clusterNotional = ex.otherClusterNotional + ex.resultingSymbolNotional;
  const ratio = clusterNotional / ex.projectedTotalNotional;
  const before =
    ex.currentTotalNotional > 0
      ? (ex.otherClusterNotional + ex.existingSymbolNotional) / ex.currentTotalNotional
      : 0;
  const severity = severityFor(ratio, before, t.clusterConcentration.soft, t.clusterConcentration.hard);
  if (!severity) return null;

  const threshold = severity === "block" ? t.clusterConcentration.hard : t.clusterConcentration.soft;

  // (otherCluster + n) / (other + n) <= soft
  //   =>  n <= (soft * other - otherCluster) / (1 - soft)
  // A non-positive cap means the cluster is already over the limit on existing
  // positions alone, so no smaller order rescues it.
  const soft = t.clusterConcentration.soft;
  const capNotional =
    soft >= 1 ? Infinity : (soft * ex.otherNotional - ex.otherClusterNotional) / (1 - soft);

  return {
    violation: {
      rule: "correlation",
      severity,
      actual: ratio,
      threshold,
      explanation:
        'The "' + ex.actionCluster + '" cluster would hold ' + pct(ratio) +
        " of total exposure (" + money(clusterNotional) + "), over the " +
        (severity === "block" ? "hard" : "soft") + " cluster limit of " + pct(threshold) +
        ". Correlated names are counted as one position because they behave like one in a drawdown." +
        (severity === "warn" ? IMPROVING : ""),
    },
    cap: maxActionQty(ex.existingSigned, ex.dir, capNotional, ex.mark),
  };
}

function ruleLiquidation(action, account, t, ex) {
  const min = t.liquidation.minDistance;
  const mmr = t.maintenanceMarginRate;
  const offenders = [];

  // An action that reduces the book is never blocked by this rule, including
  // when it is the deleveraging trade that fixes a position already sitting
  // near its liquidation price.
  if (ex.increasesExposure) {
    const existing = account.positions.find((p) => p.symbol === action.symbol);
    const leverage = action.leverage ?? existing?.leverage;
    const est = liquidationDistance({ leverage, liquidationPrice: 0 }, ex.mark, mmr);
    if (est && est.distance < min) offenders.push({ symbol: action.symbol, ...est });

    for (const p of account.positions) {
      if (p.symbol === action.symbol) continue;
      const dist = liquidationDistance(p, account.markPrices[p.symbol], mmr);
      if (dist && dist.distance < min) offenders.push({ symbol: p.symbol, ...dist });
    }
  }

  if (offenders.length === 0) return null;
  const worst = offenders.reduce((a, b) => (a.distance <= b.distance ? a : b));

  return {
    violation: {
      rule: "liquidation_distance",
      severity: "block",
      actual: worst.distance,
      threshold: min,
      explanation:
        worst.symbol + " would sit " + pct(worst.distance) + " from liquidation" +
        (worst.estimated
          ? " (estimated from leverage, since the exchange has no price for a position that does not exist yet)"
          : "") +
        ", inside the " + pct(min) + " minimum. " +
        (offenders.length > 1 ? offenders.length + " positions are inside the threshold. " : "") +
        "Trading smaller does not move an isolated-margin liquidation price, so this blocks rather than reduces.",
    },
    cap: null,
  };
}

function ruleActivityRate(t, activityCount) {
  const { warn, ceiling, windowMs } = t.activityRate;
  const minutes = Math.round(windowMs / 60000);

  if (activityCount >= ceiling) {
    return {
      violation: {
        rule: "activity_rate",
        severity: "block",
        actual: activityCount,
        threshold: ceiling,
        explanation:
          activityCount + " actions checked in the last " + minutes +
          " minutes, at or over the ceiling of " + ceiling +
          ". A smaller order does not fix a loop, so this blocks.",
      },
      cap: null,
    };
  }
  if (activityCount >= warn) {
    return {
      violation: {
        rule: "activity_rate",
        severity: "warn",
        actual: activityCount,
        threshold: warn,
        explanation:
          activityCount + " actions checked in the last " + minutes +
          " minutes, past the warning level of " + warn + " but under the ceiling of " +
          ceiling + ". Not blocking.",
      },
      cap: null,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------

/**
 * Evaluate one proposed action. Pure: no network, no wall clock, no model.
 *
 * @param {object} args
 * @param {object} args.action        validated ProposedAction
 * @param {object} args.account       account state snapshot
 * @param {object} args.thresholds    resolved thresholds
 * @param {number} args.activityCount actions already checked in the window
 * @param {number} args.now           epoch ms, injected so tests control time
 * @returns {{verdict: string, suggestedQuantity: number|null, violations: object[]}}
 */
export function evaluate({ action, account, thresholds: t, activityCount = 0, now = Date.now() }) {
  const violations = [];
  const caps = [];

  // --- Gates that run before any exposure arithmetic ------------------------

  // Missing or unusable market data is a refusal, never a skipped rule. A rule
  // that silently does not run is indistinguishable from a rule that passed.
  const mark = account.markPrices?.[action.symbol];
  const marketDataUsable = typeof mark === "number" && Number.isFinite(mark) && mark > 0;
  if (!marketDataUsable) {
    violations.push({
      rule: "market_data",
      severity: "block",
      actual: 0,
      threshold: 1,
      explanation:
        "No usable mark price for " + action.symbol +
        ". Exposure cannot be measured, so the action is refused rather than evaluated against unknown values.",
    });
  }

  const ageMs = now - account.fetchedAt;
  if (ageMs > t.staleness.maxAccountAgeMs) {
    violations.push({
      rule: "stale_account_state",
      severity: "block",
      actual: ageMs,
      threshold: t.staleness.maxAccountAgeMs,
      explanation:
        "Stale account state: " + (ageMs / 1000).toFixed(1) + "s old, past the " +
        (t.staleness.maxAccountAgeMs / 1000).toFixed(0) +
        "s limit. Approving against a portfolio that may no longer exist is worse than refusing.",
    });
  }

  const activity = ruleActivityRate(t, activityCount);
  if (activity) violations.push(activity.violation);

  // Exposure rules need a mark price; without one they would produce NaN.
  if (marketDataUsable) {
    const ex = projectExposure(action, account);
    const results = [
      rulePositionSize(action, account, t, ex),
      ruleTotalExposure(action, account, t, ex),
      ruleConcentration(action, account, t, ex),
      ruleCorrelation(action, account, t, ex),
      ruleLiquidation(action, account, t, ex),
    ];

    for (const r of results) {
      if (!r) continue;
      if (r.violation.severity === "reduce" && (!(r.cap > 0) || !Number.isFinite(r.cap))) {
        // A "reduce" whose cap is not a tradable quantity is really a block:
        // there is no smaller order that satisfies the limit.
        violations.push({
          ...r.violation,
          severity: "block",
          explanation: r.violation.explanation + " No smaller quantity satisfies this limit.",
        });
        continue;
      }
      if (r.violation.severity === "reduce") caps.push(r.cap);
      violations.push(r.violation);
    }
  }

  // --- Fold every violation into one verdict --------------------------------

  const worst = violations.reduce(
    (acc, v) => (SEVERITY_RANK[v.severity] > SEVERITY_RANK[acc] ? v.severity : acc),
    "warn",
  );
  const verdict = violations.length === 0 ? "ALLOW" : VERDICT_FOR_SEVERITY[worst];

  if (verdict !== "ALLOW_REDUCED") {
    return { verdict, suggestedQuantity: null, violations };
  }

  // The strictest reducing rule wins, and a suggestion never exceeds the ask.
  const suggested = Math.min(...caps, action.quantity);
  if (!(suggested > 0)) {
    return {
      verdict: "BLOCK",
      suggestedQuantity: null,
      violations: violations.map((v) => (v.severity === "reduce" ? { ...v, severity: "block" } : v)),
    };
  }
  return { verdict, suggestedQuantity: suggested, violations };
}

const pct = (x) => (x * 100).toFixed(1) + "%";
const money = (x) => x.toLocaleString("en-US", { maximumFractionDigits: 0 }) + " USDT";
