/**
 * Canned account states, shared by the tests and the demo script.
 *
 * Each fixture is tuned so that the scenario it exists for is caught by the
 * rule it is meant to demonstrate, and not incidentally by a different one.
 * That tuning is the point: a fixture where three rules fire at once proves
 * nothing about any of them.
 *
 * Marks are round numbers so the arithmetic in each test is checkable by hand.
 */

export const MARKS = {
  BTCUSDT: 60_000,
  ETHUSDT: 3_000,
  SOLUSDT: 150,
  AVAXUSDT: 30,
  ADAUSDT: 0.5,
  DOGEUSDT: 0.15,
};

const position = (symbol, quantity, extra = {}) => ({
  symbol,
  side: "LONG",
  quantity,
  entryPrice: MARKS[symbol],
  markPrice: MARKS[symbol],
  leverage: 1,
  liquidationPrice: 0,
  unrealizedPnl: 0,
  ...extra,
});

/**
 * A genuinely diversified book. 100k equity, 30k exposure (0.30x), spread
 * across majors, two L1s and a meme, with no cluster near its limit.
 *
 *   BTC  9,000   majors
 *   SOL  9,000   l1s
 *   ADA  6,000   l1s
 *   DOGE 6,000   memes
 *   ----------
 *        30,000  total
 */
export const DIVERSIFIED = {
  equity: 100_000,
  balances: [{ asset: "USDT", free: 70_000, locked: 0 }],
  positions: [
    position("BTCUSDT", 0.15),
    position("SOLUSDT", 60),
    position("ADAUSDT", 12_000),
    position("DOGEUSDT", 40_000),
  ],
  openOrders: [],
  markPrices: MARKS,
};

/**
 * The same equity, but 86% of exposure sits in one correlation cluster.
 * Any further majors buy pushes the cluster past its hard limit while every
 * single-symbol rule stays comfortably inside its own.
 *
 *   BTC  36,000  majors
 *   SOL   6,000  l1s
 */
export const CLUSTER_HEAVY = {
  equity: 100_000,
  balances: [{ asset: "USDT", free: 64_000, locked: 0 }],
  positions: [position("BTCUSDT", 0.6), position("SOLUSDT", 40)],
  openOrders: [],
  markPrices: MARKS,
};

/**
 * A small, unremarkable book containing one 10x position sitting 8% from
 * liquidation. Exposure is only 0.21x, so nothing else objects -- which is what
 * makes it a clean test of the rule that adding risk anywhere is refused while
 * a position is that close to being liquidated.
 */
export const LEVERED_NEAR_LIQ = {
  equity: 100_000,
  balances: [{ asset: "USDT", free: 79_000, locked: 0 }],
  positions: [
    position("SOLUSDT", 100, { leverage: 10, liquidationPrice: 138 }), // 8% away
    position("BTCUSDT", 0.1),
  ],
  openOrders: [],
  markPrices: MARKS,
};

/**
 * 30k of exposure against 21k of equity: 1.43x, just under the 1.5x soft cap.
 * Lets a small order breach the book-wide exposure limit without being large
 * enough to trip the single-position limit, which is the only way to observe
 * the exposure rule in isolation.
 */
export const NEAR_EXPOSURE_CAP = {
  equity: 21_000,
  balances: [{ asset: "USDT", free: 21_000, locked: 0 }],
  positions: [position("BTCUSDT", 0.5)],
  openOrders: [],
  markPrices: MARKS,
};

/**
 * A small book (15k against 100k equity) where a position that is modest
 * against equity is still a large share of the book. Isolates concentration
 * from position size.
 */
export const LOPSIDED = {
  equity: 100_000,
  balances: [{ asset: "USDT", free: 85_000, locked: 0 }],
  positions: [position("BTCUSDT", 0.25)],
  openOrders: [],
  markPrices: MARKS,
};

/** Holds a position the mark-price feed has no entry for. */
export const MISSING_MARK = {
  equity: 100_000,
  balances: [{ asset: "USDT", free: 90_000, locked: 0 }],
  positions: [position("BTCUSDT", 0.15)],
  openOrders: [],
  markPrices: { BTCUSDT: 60_000 }, // no ETHUSDT
};

/** The account the server serves in fixture mode. */
export const DEMO_ACCOUNT = DIVERSIFIED;

/** Stamp a fixture with a specific fetch time, for staleness tests. */
export function asOf(fixture, fetchedAt) {
  return { ...fixture, fetchedAt };
}
