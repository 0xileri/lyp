# lyp

A read-only risk guardrail for Binance Agent OS. It sits between a trading agent and the
exchange: give it a proposed action and it answers **ALLOW**, **ALLOW_REDUCED**, or
**BLOCK**, with every limit the action breaches and why each one exists.

It never places a trade. It holds no trade permissions, wires no order tools, and
refuses to call one even if the endpoint offers it.

```
  trading agent  ──check_action──▶  lyp  ╌╌read-only╌▶  Binance Agent OS
                 ◀──── verdict ───       ◀╌╌ balances, marks   (401: awaiting OAuth)
```

**Live:** https://lyp.up.railway.app · [`/health`](https://lyp.up.railway.app/health) · [`/agentos`](https://lyp.up.railway.app/agentos)

**Why this exists.** Agent OS bounds *what* an agent may touch — you authorize a
subaccount with the scopes and limits you configure. But inside that boundary, how much
to buy and when is decided by a model running in whatever AI app you chose, off-platform
and invisible to the exchange. Permissions cap the blast radius; nothing checks the
judgment. lyp is that check.

**Built against the real gateway; this deployment is not yet holding a token.** The tool
names, response shapes and error codes are confirmed from an authorized Agent OS session,
not inferred — which is how three defects were found and fixed before they could reach
production (see [The tools it calls](#the-tools-it-calls)). What is missing is an OAuth
`client_id` for *this deployment*, which Binance issues out of band, so the hop is drawn
dashed above because it is dashed in reality. `/health` and `/agentos` both report the
live handshake, so canned data is never mistaken for a live book. The rules engine is
identical either way.

```bash
curl -X POST https://lyp.up.railway.app/check \
  -H 'content-type: application/json' \
  -d '{"action":{"symbol":"ETHUSDT","side":"BUY","quantity":5,"orderType":"MARKET"}}'
# -> ALLOW_REDUCED, suggestedQuantity 3.333...
```

---

## The gap this fills

An autonomous trading agent has a model deciding *what* to trade and an exchange
executing it. Between those two there is usually nothing — the model's judgment is
also the risk check.

That works until it doesn't, and the ways it fails are specific:

- **Nobody owns "how much".** The model sizes the position, and a model that has been
  right nine times sizes the tenth trade like it will also be right.
- **Correlation is invisible per-trade.** Every individual buy looks diversified. The
  book is one bet.
- **Loops don't look like errors.** A malfunctioning agent placing the same order forty
  times is forty individually valid orders.
- **A prompt is not a constraint.** "Never risk more than 10%" in a system prompt is a
  suggestion the model can talk itself out of, and there is no artifact afterwards
  saying which rule was violated.

The check that decides whether money moves should not be the same component that
wants to move it. This service is that separation: a deterministic engine, outside
the model, that the agent has to ask.

---

## What it does and does not do

| | |
|---|---|
| **Does** | Read balances, positions, open orders and mark prices. Evaluate a proposed action against six rules. Return a verdict with every violation. |
| **Does not** | Place, cancel, or modify orders. Move funds. Request trade scope. Let a model reach or alter a verdict. |

Read-only is enforced twice: an **allowlist** of the four tools this service calls, and
a **denylist** that refuses any tool whose name looks order-shaped, checked before every
call. `test/readonly.test.js` asserts both.

---

## Quick start

```bash
npm install
npm test          # 45 tests, no network
npm run demo      # four canned scenarios
```

The demo runs entirely on fixtures — no exchange connection, no API keys.

```
  3. Correlated cluster, blocked
     A tiny ETH buy -- 3% of equity, 7% of the book. Every single-symbol rule
     passes. But 86% of this book is already BTC, and BTC and ETH are one
     position in a drawdown.

  book   100,000 USDT equity, 42,000 USDT exposure (0.42x)
         BTCUSDT        0.6 =  36,000 USDT  [majors]
         SOLUSDT         40 =   6,000 USDT  [l1s]
  action BUY 1 ETHUSDT = 3,000 USDT (3.0% of equity)

  BLOCK
         BLOCK  correlation
                The "majors" cluster would hold 86.7% of total exposure (39,000
                USDT), over the hard cluster limit of 80.0%.
```

---

## Connecting to Agent OS

**Status: reachable, authenticated handshake outstanding.** The endpoint is wired and the
deployment talks to it; what is missing is an authorization token.

The published endpoint is `https://agent.binance.com/mcp/agentic`, over MCP streamable
HTTP. Probing it from the deployment returns:

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="https://agent.binance.com/.well-known/oauth-protected-resource/gateway-mcp"
```

So Agent OS is an **OAuth 2.0 protected resource** (RFC 9728, as the MCP authorization
spec prescribes). Every call needs a bearer token, `initialize` included — there is no
unauthenticated market-data path. Obtaining one is an interactive consent flow against an
Agentic subaccount, which is why it is a step the operator performs rather than something
the build can do for itself.

`GET /agentos` on any deployed instance reports exactly this: the endpoint, whether a
token is configured, and the raw handshake response. It lists tool names and calls none
of them.

To go live:

```bash
# 1. Create and fund an Agentic subaccount, then authorize an agent at
#    binance.com/en/agent-os. Grant MARKET DATA and ACCOUNT READ scope only.
#    Do not grant trade scope: this service does not use it, and the
#    read-only guard refuses order-shaped tools regardless.

# 2. Give the deployment the token.
railway variables --set AGENT_OS_TOKEN=...

# 3. Confirm the handshake now succeeds, and read the real tool names.
curl https://lyp.up.railway.app/agentos

# 4. Switch off fixtures.
railway variables --set GUARDRAIL_PROVIDER=agentos
```

### The tools it calls

Confirmed against a live authorized gateway session, not inferred — an earlier version of
this integration guessed four names and got all four wrong:

| Purpose | Tool |
|---|---|
| Balances and equity | `spot_getAccount` |
| Positions | `futures_usds_positionInformationV2` |
| Open orders | `spot_getOpenOrders` |
| Mark prices | `spot_tickerPrice` |

Overridable via `AGENT_OS_TOOL_BALANCES` / `_POSITIONS` / `_OPEN_ORDERS` / `_MARK_PRICES`
if a gateway revision moves them.

Three things that session also established, each of which is now handled rather than
discovered in production:

- **Mark prices are fetched one symbol at a time.** The gateway accepts a `symbols` array
  but serializes it with spaces, and Binance rejects the query with `-1100 Illegal
  characters found in parameter 'symbols'`. The batch form simply does not work.
- **A spot-only account answers `-2015` for futures positions.** That is recorded as a
  *degraded source* and blocks, rather than being read as "no positions" — "no permission"
  and "no exposure" are different facts, and confusing them understates risk.
- **Binance spells it `unRealizedProfit`** on futures v2 and `unrealizedProfit` elsewhere.
  Both are accepted.

Response field names are read tolerantly (`positionAmt` or `quantity` or `size`, and so
on) since the exact shapes were unverified. A field that is genuinely absent becomes
`NaN` rather than a default, which the engine treats as unusable market data and blocks
on. Defaulting equity to `0` or a mark price to `1` would produce confident nonsense.

Account state is cached for 15s, market data for 30s.

### Skills Hub

Agent OS is more than the MCP gateway, and the read-only research half of
[Binance Skills Hub](https://github.com/binance/binance-skills-hub) pairs naturally with
this service:

```bash
npx skills add https://github.com/binance/binance-skills-hub
```

`query-token-audit` and `check_action` answer the two halves of the same question — *is
this token safe* and *is this position sized safely* — and together they cover more of
what can go wrong than either does alone.

Installed skills are **not vendored into this repo**. The install is reproducible in one
command, and `.agents/` is gitignored.

The action-capable skills are deliberately not installed here. Skills Hub ships wallet,
payment, P2P, fiat and spot-trading skills that can move funds or place orders, and they
load into an agent's context with full permissions. A repository whose central claim is
that it *cannot place a trade* has no business also carrying a `send.py`. Only the eight
read-only research skills are kept: `query-token-audit`, `query-token-info`,
`query-address-info`, `crypto-market-rank`, `binance-trading-signal`, `trading-signal`,
`binance-wallet-tracker`, `binance-leaderboard`.

---

## The agent

`lyp` is the guardrail. [`agent/`](agent/) is a trading agent that runs behind it — a
model that reads the book, forms a view, and proposes trades, where **every proposal is
checked before it counts**.

```bash
export ANTHROPIC_API_KEY=...
npm run agent "Look at the book and propose anything worth doing today."
```

```
lyp agent · model claude-sonnet-5
· guardrail https://lyp.up.railway.app/mcp
· no order is placed by this program

  → propose_trade(symbol: "ETHUSDT", side: "BUY", quantity: 5, orderType: "MARKET")
    ALLOW_REDUCED — size 3.3333333333333335
      [reduce] position_size
```

### The guarantee is structural, not prompted

The agent is not *asked* to consult the guardrail. It has no tool that can act without
one. `propose_trade` is the only action-shaped function it can reach, and that function
calls `check_action` itself before returning — so a `BLOCK` is a refusal produced in code
the model cannot route around, not an instruction it is trusted to follow.

This distinction is the whole point. An agent merely *told* to respect its risk limits is
one confident completion away from not respecting them.

`test/agent.test.js` proves it with **no model in the loop**: that the only action tool is
`propose_trade`, that every proposal reaches the guardrail, that a `BLOCK` yields a
tradable size of zero, and that `ALLOW_REDUCED` records the reduced size rather than the
requested one. No API key is needed to run those tests.

### Connecting your own agent

[`.mcp.json`](.mcp.json) wires both servers for any MCP client that reads it — `lyp` and
Binance Agent OS. Or by hand:

```bash
claude mcp add --transport http lyp https://lyp.up.railway.app/mcp
```

Market data comes from Agent OS when `AGENT_OS_MCP_URL` and a token are configured, and
otherwise from the guardrail's own marks — labelled `guardrail-marks` in the run log, so
the difference is never invisible.

---

## Surfaces

### `POST /mcp` — MCP server

Two tools, both read-only, both open (no payment gating in this build).

| Tool | Purpose |
|---|---|
| `check_action` | Evaluate one proposed action. Returns the verdict. |
| `account_risk` | Current exposure, cluster concentration, staleness. No verdict. |

Stateless: a fresh server per request, so any number of replicas serve it without
sticky routing.

### `POST /check` — the same evaluation over plain REST

```bash
curl -X POST localhost:3000/check -H 'content-type: application/json' -d '{
  "action": { "symbol": "ETHUSDT", "side": "BUY", "quantity": 5, "orderType": "MARKET" },
  "actor": "my-trading-bot"
}'
```

```json
{
  "verdict": "ALLOW_REDUCED",
  "suggestedQuantity": 3.3333333333333335,
  "violations": [{
    "rule": "position_size",
    "severity": "reduce",
    "actual": 0.15,
    "threshold": 0.1,
    "explanation": "Resulting ETHUSDT position would be 15.0% of equity (15,000 USDT against 100,000 USDT), over the soft limit of 10.0%."
  }],
  "accountSnapshot": { "equity": 100000, "totalNotional": 30000, "positionCount": 4, "timestamp": "..." },
  "narration": null
}
```

Any threshold can be overridden per request, so a caller may run stricter limits than
the server default without a redeploy:

```json
{ "action": { ... }, "thresholds": { "positionSize": { "soft": 0.02, "hard": 0.04 } } }
```

### `GET /health`

Reports provider mode, whether narration is on, and `"exchangeScope": "read-only"`.

---

## The rules

Evaluated in order. Every rule runs — nothing short-circuits — so one response carries
every limit an action breaches rather than the first. The verdict is the worst outcome
across all of them.

| # | Rule | Measures | Protects against |
|---|---|---|---|
| 1 | `position_size` | Resulting position notional ÷ equity | One bad call ending the account. A model on a winning streak sizes the next trade like it will also win. |
| 2 | `total_exposure` | Book-wide notional ÷ equity | Leverage accumulating across many individually reasonable positions. No single trade looks wrong; the book does. |
| 3 | `concentration` | One symbol ÷ total exposure | A book that looks diversified by position count while being a single bet by size. |
| 4 | `correlation` | One cluster ÷ total exposure | Correlation blindness. Five L1s in a risk-off move are one position wearing five hats. |
| 5 | `liquidation_distance` | Mark-to-liquidation ÷ mark | Positions that survive on paper but not through an ordinary overnight candle. |
| 6 | `activity_rate` | Actions checked per hour | A looping or malfunctioning agent. Runaway behaviour shows up as frequency long before it shows up as one oversized order. |

Plus two refusals that are not about size:

| Rule | Behaviour |
|---|---|
| `stale_account_state` | Account data older than 60s blocks. Approving against a portfolio that may no longer exist is worse than refusing. |
| `market_data` | A missing or unparseable mark price blocks. A rule that silently does not run is indistinguishable from one that passed. |

All thresholds live in [`src/config.js`](src/config.js), each with a comment explaining
what it protects against — a threshold whose purpose nobody remembers is one that
eventually gets raised until it stops firing.

### Three design decisions worth calling out

**Clusters get their own, looser limits.** Rule 4 treats a correlation cluster as one
position, but reusing the single-symbol thresholds would block any book that is
diversified *within* majors. Holding three majors is genuinely less concentrated than
holding one, and far less diversified than the position count suggests — so clusters
have their own threshold pair.

**Exposure is measured on the resulting position, not the order.** A SELL that halves a
long is a smaller position, and every size rule sees it that way. Closing risk is never
charged as if it added some.

**An action that improves a breached limit is reported, never blocked.** An account
sitting at 85% single-name concentration cannot get back under 60% without selling. A
rule that only looked at the resulting state would refuse every one of those sells for
still being over the limit — trapping the account in the position it flagged. So when a
metric is over its limit but moving in the right direction, the violation is reported at
`warn` severity and the action proceeds.

Rules 5 and 6 only ever block. Trading smaller does not move an isolated-margin
liquidation price, and a smaller order does not fix being in a loop; offering a reduced
size there would be false comfort.

---

## Where the model sits

Nowhere near the verdict.

```
  fetch state ─▶ rules engine ─▶ verdict ─▶ schema validation ─▶ narrator ─▶ response
                 (pure, no I/O)             (frozen here)        (optional)
```

`evaluate()` is a pure function: no network, no wall clock beyond an injected `now`, no
model. The narrator receives a frozen copy of the finished, validated verdict and
writes one paragraph about it. It cannot set a threshold, compute a verdict, or change
a suggested quantity.

If the Anthropic call fails, times out, or is not configured at all, the response is
returned complete with `narration: null`. Four tests cover this, including one that
hands the narrator a verdict and has it try to rewrite the object — the attempt is
inert, and the block still stands.

`narration` is model output. Treat it as display text; an agent that parsed it for a
decision would reintroduce exactly the non-determinism this service exists to remove.

---

## Failure modes

| Situation | Behaviour |
|---|---|
| Account data older than 60s | `BLOCK`, reason `stale_account_state` |
| Missing or unparseable mark price | `BLOCK`, reason `market_data` |
| Agent OS unreachable, cache warm | Serves last known state; the staleness rule turns it into a `BLOCK` with a reason |
| Agent OS unreachable, cache cold | `503` whose body is shaped like a verdict, with `"verdict": "BLOCK"` |
| Malformed request | `400`, and the body still carries `"verdict": "BLOCK"` |
| Model unavailable | Full verdict, `narration: null` |

The pattern throughout: an agent reading `verdict` blindly can never mistake a failure
for permission.

---

## Tests

```bash
npm test
```

45 tests, fixture-based, no live calls. Covering each rule firing individually, several
firing together, a cluster treated as one position, the model unavailable and the model
misbehaving, stale data, missing market data, a clean allow, per-request overrides, and
read-only enforcement at the call boundary.

Each threshold test pins its arithmetic in a comment, and the fixtures are tuned so
that each scenario is caught by the rule it exists to demonstrate and not incidentally
by another — a fixture where three rules fire at once proves nothing about any of them.

---

## Deploying

Deployed on Railway at **https://lyp.up.railway.app**, built from `master` via
[`railway.json`](railway.json) — Nixpacks, `npm start`, health check on `/health`. Pushes
to `master` deploy automatically.

To run your own:

```bash
railway up
railway variables --set AGENT_OS_MCP_URL=... --set AGENT_OS_TOKEN=... --set GUARDRAIL_PROVIDER=agentos
```

`GUARDRAIL_PROVIDER` defaults to `fixture`, so a fresh deploy comes up working with no
configuration at all. Switching it to `agentos` takes effect on the next deploy.

`ANTHROPIC_API_KEY` is optional. Without it, narration is disabled and everything else
is unchanged.

---

## Known limits

Stated plainly rather than discovered later:

- **The Agent OS endpoint, auth, and tool names are unverified.** See *Connecting to
  Agent OS* above. This is the one part that has not been run against the real thing.
- **Liquidation distance for a proposed position is an estimate.** The exchange cannot
  report a price for a position that does not exist yet, so it falls back to
  `1/leverage − maintenanceMarginRate`, which ignores funding, fees and cross-margin
  offsets. Exchange-reported prices always win, and the response labels which was used.
- **The activity counter is in-memory and per-instance.** Across replicas each instance
  counts its own traffic. A shared store would be more globally accurate and would also
  make the guardrail fail when the store did.
- **Correlation clusters are a hand-maintained static map.** A rolling correlation
  matrix converges on "everything is correlated" precisely during the move you needed
  the number for, and it makes verdicts non-reproducible.
- **Thresholds can be loosened per request, not only tightened.** The caller here is
  assumed to be the operator. In a setting where it is not, the override path should be
  clamped to the server defaults.

---

The response structuring and schema-validation approach here is carried over from prior
work of mine; the Agent OS integration and the rules engine are new.
