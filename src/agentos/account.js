import { CACHE_TTL } from "../config.js";
import { AgentOsClient, TOOL_NAMES } from "./client.js";
import { tokens } from "./oauth.js";

/**
 * Account state acquisition and caching.
 *
 * The normalisers stay tolerant about field names even though the shapes are
 * now confirmed against a live authorized session, because Binance is not
 * consistent with itself: futures v2 reports `unRealizedProfit` where other
 * endpoints use `unrealizedProfit`, and quantity arrives as `positionAmt`,
 * `qty` or `size` depending on where you ask. Each field is read from a list
 * and the first present one wins.
 *
 * When a required field is absent entirely the value becomes NaN rather than a
 * default, which the rules engine treats as unusable market data and blocks on.
 * Silently defaulting equity to 0, or a mark price to 1, would produce
 * confident nonsense.
 */

const pick = (obj, names, fallback = undefined) => {
  for (const n of names) {
    if (obj && obj[n] !== undefined && obj[n] !== null) return obj[n];
  }
  return fallback;
};

const num = (v) => {
  if (v === undefined || v === null || v === "") return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

const arrayFrom = (v) => {
  if (Array.isArray(v)) return v;
  if (Array.isArray(v?.data)) return v.data;
  if (Array.isArray(v?.balances)) return v.balances;
  if (Array.isArray(v?.positions)) return v.positions;
  if (Array.isArray(v?.orders)) return v.orders;
  if (Array.isArray(v?.result)) return v.result;
  return [];
};

export function normalizeBalances(raw) {
  return arrayFrom(raw).map((b) => ({
    asset: String(pick(b, ["asset", "coin", "currency", "symbol"], "")).toUpperCase(),
    free: num(pick(b, ["free", "available", "availableBalance", "walletBalance"])),
    locked: num(pick(b, ["locked", "frozen", "inOrder", "holds"], 0)),
  }));
}

export function normalizePositions(raw) {
  return arrayFrom(raw)
    .map((p) => {
      const quantity = Math.abs(num(pick(p, ["positionAmt", "quantity", "size", "amount", "qty"])));
      const rawAmt = num(pick(p, ["positionAmt", "quantity", "size", "amount", "qty"]));
      const explicitSide = String(pick(p, ["positionSide", "side", "direction"], "")).toUpperCase();
      const side =
        explicitSide === "SHORT" || explicitSide === "SELL" || rawAmt < 0 ? "SHORT" : "LONG";

      return {
        symbol: String(pick(p, ["symbol", "pair", "instrument"], "")).toUpperCase(),
        side,
        quantity,
        entryPrice: num(pick(p, ["entryPrice", "avgPrice", "averagePrice", "costBasis"])),
        markPrice: num(pick(p, ["markPrice", "marketPrice", "lastPrice", "price"])),
        leverage: num(pick(p, ["leverage", "lev"], 1)),
        liquidationPrice: num(pick(p, ["liquidationPrice", "liqPrice", "estimatedLiquidationPrice"], 0)),
        // Binance spells it unRealizedProfit on futures v2; the lowercase-r
        // spelling appears elsewhere. Both are accepted.
        unrealizedPnl: num(pick(p, ["unRealizedProfit", "unrealizedProfit", "unrealizedPnl", "uPnl"], 0)),
      };
    })
    .filter((p) => p.symbol && p.quantity > 0);
}

export function normalizeOpenOrders(raw) {
  return arrayFrom(raw).map((o) => ({
    symbol: String(pick(o, ["symbol", "pair"], "")).toUpperCase(),
    side: String(pick(o, ["side"], "")).toUpperCase(),
    quantity: num(pick(o, ["origQty", "quantity", "size", "qty"])),
    price: num(pick(o, ["price", "limitPrice"], 0)),
    orderType: String(pick(o, ["type", "orderType"], "")).toUpperCase(),
  }));
}

/**
 * Accepts the three shapes seen in the wild: an array of tickers, a single
 * ticker object, or a bare map of symbol to price.
 *
 * The single-ticker case is the one `spot_tickerPrice` actually returns when
 * asked for one symbol — `{"symbol":"ETHUSDT","price":"2496.28"}` — and it has
 * to be recognised before the map branch, which would otherwise read the
 * literal keys "symbol" and "price" as if they were ticker names.
 */
export function normalizeMarks(raw) {
  const out = {};
  const arr = arrayFrom(raw);
  if (arr.length > 0) {
    for (const m of arr) {
      const symbol = String(pick(m, ["symbol", "pair"], "")).toUpperCase();
      const price = num(pick(m, ["markPrice", "price", "indexPrice", "lastPrice"]));
      if (symbol) out[symbol] = price;
    }
    return out;
  }
  if (raw && typeof raw === "object" && raw.symbol !== undefined) {
    out[String(raw.symbol).toUpperCase()] = num(
      pick(raw, ["markPrice", "price", "indexPrice", "lastPrice"]),
    );
    return out;
  }
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) {
      const n = num(typeof v === "object" ? pick(v, ["markPrice", "price"]) : v);
      out[String(k).toUpperCase()] = n;
    }
  }
  return out;
}

/**
 * Account equity in quote currency.
 *
 * Prefers a figure the exchange reports directly. Falls back to stablecoin
 * balances plus unrealised PnL, which is right for a subaccount margined in
 * stables and is the shape the demo fixtures use.
 */
export function deriveEquity(rawAccount, balances, positions) {
  const reported = num(
    pick(rawAccount ?? {}, [
      "totalMarginBalance",
      "marginBalance",
      "totalWalletBalance",
      "equity",
      "accountEquity",
      "totalEquity",
    ]),
  );
  if (Number.isFinite(reported) && reported > 0) return reported;

  const STABLES = new Set(["USDT", "USDC", "FDUSD", "BUSD", "TUSD", "DAI"]);
  const cash = balances
    .filter((b) => STABLES.has(b.asset))
    .reduce((sum, b) => sum + (Number.isFinite(b.free) ? b.free : 0) + (Number.isFinite(b.locked) ? b.locked : 0), 0);
  const pnl = positions.reduce((sum, p) => sum + (Number.isFinite(p.unrealizedPnl) ? p.unrealizedPnl : 0), 0);
  return cash + pnl;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/** Live provider, backed by the Agent OS MCP endpoint. Read-only. */
export class AgentOsProvider {
  constructor(client = new AgentOsClient({ url: process.env.AGENT_OS_MCP_URL, token: () => tokens.get() })) {
    this.client = client;
  }

  async fetchAccount() {
    const [balancesRes, positionsRes, ordersRes] = await Promise.allSettled([
      this.client.call(TOOL_NAMES.balances),
      this.client.call(TOOL_NAMES.positions),
      this.client.call(TOOL_NAMES.openOrders),
    ]);

    // Balances are load-bearing: without them there is no equity, and every
    // ratio in the engine divides by it. A failure here is fatal by design.
    if (balancesRes.status === "rejected") throw balancesRes.reason;

    const rawBalances = balancesRes.value;
    const balances = normalizeBalances(rawBalances);

    // Positions and open orders are recorded as degraded rather than defaulted.
    //
    // A spot-only account genuinely has no futures positions, and the gateway
    // answers -2015 for it. But "no permission" and "no positions" are not the
    // same fact, and quietly reading the first as the second would understate
    // exposure on an account whose token simply lacks the scope. The engine
    // turns a degraded source into a refusal; it does not guess.
    const degraded = [];
    const positions = positionsRes.status === "fulfilled"
      ? normalizePositions(positionsRes.value)
      : (degraded.push({ source: "positions", reason: reasonOf(positionsRes.reason) }), []);
    const openOrders = ordersRes.status === "fulfilled"
      ? normalizeOpenOrders(ordersRes.value)
      : (degraded.push({ source: "openOrders", reason: reasonOf(ordersRes.reason) }), []);

    return {
      balances,
      positions,
      openOrders,
      equity: deriveEquity(rawBalances, balances, positions),
      degraded,
      fetchedAt: Date.now(),
    };
  }

  /**
   * One call per symbol.
   *
   * The gateway accepts a `symbols` array, but serializes it with spaces and
   * Binance then rejects the query with -1100 ("Illegal characters found in
   * parameter 'symbols'"). Asking per symbol sidesteps the encoding entirely,
   * and a portfolio has few enough symbols that the extra round trips are
   * cheaper than a batch that fails outright.
   *
   * A symbol that fails is simply absent from the map, which the engine treats
   * as unusable market data and blocks on.
   */
  async fetchMarks(symbols) {
    const results = await Promise.allSettled(
      symbols.map((symbol) => this.client.call(TOOL_NAMES.markPrices, { symbol })),
    );
    const markPrices = {};
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      Object.assign(markPrices, normalizeMarks(result.value));
    }
    return { markPrices, fetchedAt: Date.now() };
  }
}

/**
 * Fixture provider. Runs the identical engine against canned state, so the
 * demo, the tests and a live deployment differ only in where the numbers come
 * from.
 */
export class FixtureProvider {
  constructor(fixture) {
    this.fixture = fixture;
  }

  async fetchAccount() {
    const f = this.fixture;
    return {
      balances: f.balances ?? [],
      positions: f.positions ?? [],
      openOrders: f.openOrders ?? [],
      equity: f.equity,
      fetchedAt: f.fetchedAt ?? Date.now(),
    };
  }

  async fetchMarks() {
    return { markPrices: this.fixture.markPrices ?? {}, fetchedAt: this.fixture.fetchedAt ?? Date.now() };
  }
}

// ---------------------------------------------------------------------------

/**
 * TTL cache over a provider: 15s for account state, 30s for marks.
 *
 * When a refresh fails, the last known value is served rather than throwing.
 * That is deliberate. Stale data flows into the rules engine, which has an
 * explicit staleness rule and turns it into a BLOCK with a reason the caller
 * can read. Throwing a 500 instead would tell an autonomous caller only that
 * something broke, which is exactly the moment it is most likely to retry
 * blind.
 */
export class AccountStateService {
  #cache = new Map();

  constructor(provider, ttl = CACHE_TTL) {
    this.provider = provider;
    this.ttl = ttl;
  }

  async #cached(key, ttlMs, fetcher, now) {
    const current = this.#cache.get(key);
    if (current && now - current.at < ttlMs) return current.value;
    try {
      const value = await fetcher();
      this.#cache.set(key, { value, at: now });
      return value;
    } catch (err) {
      if (current) return current.value; // age travels in the payload; the staleness rule decides
      throw err;
    }
  }

  async getState(symbols = [], now = Date.now()) {
    const account = await this.#cached("account", this.ttl.accountMs, () => this.provider.fetchAccount(), now);
    const wanted = [...new Set([...symbols, ...account.positions.map((p) => p.symbol)])];
    const marks = await this.#cached("marks", this.ttl.marketMs, () => this.provider.fetchMarks(wanted), now);

    return {
      ...account,
      markPrices: marks.markPrices,
      marketFetchedAt: marks.fetchedAt,
    };
  }

  /** Drop cached state, so the next read goes to the provider. */
  invalidate() {
    this.#cache.clear();
  }
}

/** A short, loggable reason from a rejected tool call. */
function reasonOf(err) {
  const message = err?.message ?? String(err);
  return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}
