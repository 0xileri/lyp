/**
 * Static correlation clusters.
 *
 * Assets inside a cluster tend to move together hard enough that treating
 * them as independent positions understates risk. The map is deliberately
 * static and hand-maintained rather than derived from a rolling correlation
 * matrix: a matrix estimated on recent data converges to "everything is
 * correlated" precisely during the move you needed the number for, and it
 * makes the verdict non-reproducible.
 */
export const CLUSTERS = {
  majors: ["BTC", "ETH", "WBTC", "WETH", "BETH"],
  l1s: ["SOL", "AVAX", "ADA", "DOT", "NEAR", "ATOM", "APT", "SUI", "TON", "TRX", "ALGO", "SEI", "INJ"],
  memes: ["DOGE", "SHIB", "PEPE", "WIF", "BONK", "FLOKI", "BOME"],
};

/** Quote assets stripped when deriving a base asset from a symbol name. */
const QUOTE_ASSETS = ["USDT", "FDUSD", "USDC", "BUSD", "TUSD", "USD", "BTC", "ETH", "BNB"];

const ASSET_TO_CLUSTER = new Map();
for (const [name, assets] of Object.entries(CLUSTERS)) {
  for (const asset of assets) ASSET_TO_CLUSTER.set(asset, name);
}

/**
 * "BTCUSDT" -> "BTC". Longest matching quote suffix wins, so "ETHBTC"
 * resolves to base ETH rather than being mangled by the shorter match.
 */
export function baseAssetOf(symbol) {
  const s = String(symbol).toUpperCase();
  let best = null;
  for (const quote of QUOTE_ASSETS) {
    if (s.length > quote.length && s.endsWith(quote)) {
      if (!best || quote.length > best.length) best = quote;
    }
  }
  return best ? s.slice(0, -best.length) : s;
}

/** Cluster name for a symbol, or null when the asset is unclustered. */
export function clusterOf(symbol) {
  return ASSET_TO_CLUSTER.get(baseAssetOf(symbol)) ?? null;
}

/** True when two symbols sit in the same cluster. */
export function sameCluster(a, b) {
  const ca = clusterOf(a);
  return ca !== null && ca === clusterOf(b);
}
