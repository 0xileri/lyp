/**
 * Every risk threshold in the system, in one place.
 *
 * Each entry documents what it protects against, because a threshold whose
 * purpose nobody remembers is a threshold that eventually gets raised until it
 * stops firing. Ratios are fractions of account equity unless stated otherwise.
 *
 * All of these are overridable per request (see `resolveThresholds`), so a
 * caller can run limits stricter than the defaults without redeploying.
 */
export const DEFAULT_THRESHOLDS = {
  /**
   * Notional of a single proposed position as a fraction of equity.
   *
   * Protects against: one bad call ending the account. An agent that has been
   * right nine times in a row will size the tenth trade like it is also going
   * to be right.
   *
   * soft -> the action is allowed at a reduced quantity.
   * hard -> refused outright.
   */
  positionSize: { soft: 0.1, hard: 0.25 },

  /**
   * Sum of all position notionals as a multiple of equity, after the proposed
   * action. Values above 1 mean leverage is in use.
   *
   * Protects against: leverage accumulating across many individually
   * reasonable positions. No single trade looks wrong; the book does.
   */
  totalExposure: { soft: 1.5, hard: 3.0 },

  /**
   * One symbol's notional as a share of total exposure.
   *
   * Protects against: a book that looks diversified by position count while
   * being a single bet by size.
   */
  concentration: { soft: 0.35, hard: 0.6 },

  /**
   * A correlation cluster's combined notional as a share of total exposure.
   *
   * Deliberately looser than `concentration`: holding three different majors
   * is genuinely less concentrated than holding one, just far less
   * diversified than the position count suggests. Reusing the single-symbol
   * limits here would block any book that is diversified *within* a cluster.
   *
   * Protects against: correlation blindness. Five L1s in a risk-off move are
   * one position wearing five hats.
   */
  clusterConcentration: { soft: 0.55, hard: 0.8 },

  /**
   * Minimum acceptable distance from mark price to liquidation price, as a
   * fraction of mark price. 0.15 = "liquidation must be more than 15% away".
   *
   * Protects against: positions that survive on paper but not through an
   * ordinary overnight candle. This rule only ever blocks — reducing quantity
   * does not move an isolated-margin liquidation price, so offering a smaller
   * size here would be false comfort.
   */
  liquidation: { minDistance: 0.15 },

  /**
   * Actions evaluated per rolling window.
   *
   * Protects against: a malfunctioning or looping agent. Runaway behaviour
   * shows up as frequency long before it shows up as a single oversized
   * order. Like the liquidation rule, a smaller quantity does not fix being
   * in a loop, so the ceiling blocks rather than reduces.
   */
  activityRate: { warn: 20, ceiling: 40, windowMs: 60 * 60 * 1000 },

  /**
   * Maximum age of fetched account state before a verdict may rely on it.
   *
   * Protects against: approving against a portfolio that no longer exists.
   * Past this age the answer is BLOCK, never a guess.
   */
  staleness: { maxAccountAgeMs: 60 * 1000 },

  /**
   * Maintenance margin rate used to *estimate* a liquidation price for a
   * proposed position when the exchange has not reported one (it cannot — the
   * position does not exist yet). 0.005 is a common tier-1 linear futures
   * rate. An exchange-reported liquidation price always wins over this
   * estimate; see `estimateLiquidationDistance`.
   */
  maintenanceMarginRate: 0.005,
};

/** Cache TTLs, per the operating brief. */
export const CACHE_TTL = {
  /** Balances, positions, open orders. */
  accountMs: 15 * 1000,
  /** Mark prices. */
  marketMs: 30 * 1000,
};

/**
 * Merge caller-supplied overrides over the defaults.
 *
 * One level of nesting, no prototype pollution, and unknown keys are ignored
 * rather than silently creating thresholds no rule reads.
 */
export function resolveThresholds(overrides) {
  if (!overrides || typeof overrides !== "object") return DEFAULT_THRESHOLDS;

  const out = {};
  for (const [key, base] of Object.entries(DEFAULT_THRESHOLDS)) {
    const override = Object.hasOwn(overrides, key) ? overrides[key] : undefined;

    if (override === undefined) {
      out[key] = base;
    } else if (typeof base === "number") {
      out[key] = typeof override === "number" ? override : base;
    } else {
      out[key] = { ...base };
      if (override && typeof override === "object") {
        for (const field of Object.keys(base)) {
          if (typeof override[field] === "number") out[key][field] = override[field];
        }
      }
    }
  }
  return out;
}

export const SERVER = {
  port: Number(process.env.PORT ?? 3000),
  /** "fixture" runs the full engine against canned state; "agentos" connects. */
  provider: process.env.GUARDRAIL_PROVIDER ?? "fixture",
};

export const NARRATION = {
  enabled: Boolean(process.env.ANTHROPIC_API_KEY),
  model: process.env.NARRATION_MODEL ?? "claude-sonnet-5",
  timeoutMs: Number(process.env.NARRATION_TIMEOUT_MS ?? 4000),
};
