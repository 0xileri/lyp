/**
 * The page served at GET /.
 *
 * A landing page rather than a stub, because the deployed URL is the first
 * thing most people will see of this project and "Cannot GET /" reads as a
 * broken deployment.
 *
 * The interactive panel calls the same POST /check an agent calls. There is no
 * separate demo path and no canned response in this file, so the page cannot
 * drift from what the service actually does — if the engine changes, the
 * numbers on this page change with it.
 *
 * Everything else on the page is generated from the tables below, which mirror
 * src/config.js and src/approval.js. Documentation that is re-typed by hand
 * goes stale; this at least goes stale in one place.
 */

/**
 * Scenarios are chosen so that between them every rule that can fire against
 * this book does fire. A rules table listing six limits while the demo only
 * ever exercises three asserts the other half rather than showing it.
 */
const SCENARIOS = [
  {
    id: "clean",
    label: "Reasonable",
    sub: "BUY 2 ETH",
    quantity: 2,
    note: "6,000 USDT — 6% of equity. Inside every limit.",
    expect: "ALLOW",
  },
  {
    id: "reduced",
    label: "Oversized",
    sub: "BUY 5 ETH",
    quantity: 5,
    note: "15,000 — 15% of equity. Past the 10% soft limit, under the 25% hard one.",
    expect: "ALLOW_REDUCED",
  },
  {
    id: "blocked",
    label: "Reckless",
    sub: "BUY 12 ETH",
    quantity: 12,
    note: "36,000 — 36% of equity. Past the hard ceiling, and it drags concentration and correlation over too.",
    expect: "BLOCK",
  },
  {
    id: "levered",
    label: "Levered 20x",
    sub: "BUY 2 ETH",
    quantity: 2,
    leverage: 20,
    note: "The same size that was allowed above — but at 20x. Liquidation sits ~4.5% away against a 15% floor.",
    expect: "BLOCK",
  },
  {
    id: "strict",
    label: "Stricter caller",
    sub: "BUY 2 ETH",
    quantity: 2,
    thresholds: { totalExposure: { soft: 0.35, hard: 0.5 } },
    note: "The same clean order, from a caller running a 0.35x book-wide cap instead of the default 1.5x.",
    expect: "ALLOW_REDUCED",
  },
];

/** Mirrors DEFAULT_THRESHOLDS in src/config.js. */
const RULES = [
  {
    n: "01",
    code: "position_size",
    measure: "resulting position ÷ equity",
    soft: "10%",
    hard: "25%",
    owner: "engine",
    protects:
      "One bad call ending the account. A model that has been right nine times sizes the tenth trade like it will also be right.",
  },
  {
    n: "02",
    code: "total_exposure",
    measure: "book notional ÷ equity",
    soft: "1.5x",
    hard: "3.0x",
    owner: "engine",
    protects:
      "Leverage accumulating across many individually reasonable positions. No single trade looks wrong; the book does.",
  },
  {
    n: "03",
    code: "concentration",
    measure: "one symbol ÷ total exposure",
    soft: "35%",
    hard: "60%",
    owner: "engine",
    protects:
      "A book that looks diversified by position count while being a single bet by size.",
  },
  {
    n: "04",
    code: "correlation",
    measure: "one cluster ÷ total exposure",
    soft: "55%",
    hard: "80%",
    owner: "clusters.js",
    protects:
      "Correlation blindness. Five L1s in a risk-off move are one position wearing five hats. Deliberately looser than the single-symbol limit, or a book diversified within majors would always block.",
  },
  {
    n: "05",
    code: "liquidation_distance",
    measure: "mark → liquidation ÷ mark",
    soft: "—",
    hard: "15%",
    owner: "exchange / estimate",
    protects:
      "Positions that survive on paper but not through an ordinary overnight candle. Blocks rather than reduces: a smaller size does not move an isolated-margin liquidation price.",
  },
  {
    n: "06",
    code: "activity_rate",
    measure: "checks per rolling hour",
    soft: "20",
    hard: "40",
    owner: "activity.js",
    protects:
      "A looping or malfunctioning agent. Runaway behaviour shows up as frequency long before it shows up as size.",
  },
];

/** Gates that run before any exposure arithmetic. */
const GATES = [
  {
    code: "market_data",
    when: "no usable mark price for the symbol",
    result: "BLOCK",
    why: "A rule that silently does not run is indistinguishable from a rule that passed.",
  },
  {
    code: "stale_account_state",
    when: "account state older than 60s",
    result: "BLOCK",
    why: "Approving against a portfolio that may no longer exist is worse than refusing.",
  },
  {
    code: "source_unavailable",
    when: "a source could not be read at all",
    result: "BLOCK",
    why: "“No permission” and “no positions” are different facts. Confusing them understates exposure.",
  },
];

/** Mirrors REJECTIONS in src/approval.js. */
const REJECTIONS = [
  ["BAD_SIGNATURE", "not issued by this guardrail"],
  ["EXPIRED", "past its 60-second window"],
  ["ALREADY_USED", "approvals are single-use"],
  ["QUANTITY_EXCEEDED", "larger than the approved maximum"],
  ["SYMBOL_MISMATCH", "a different symbol"],
  ["SIDE_MISMATCH", "a different side"],
  ["TYPE_MISMATCH", "a different order type"],
  ["MALFORMED", "not a well-formed token"],
];

const NEVER = [
  ["Place an order", "No execution code exists. The only exchange connection is read-only."],
  ["Hold trade permissions", "OAuth requests market-data and account-read scope. Trading scopes are never asked for."],
  ["Let a model reach a verdict", "The engine is a pure function. Narration is written after the verdict, from a frozen copy."],
  ["Guess at stale data", "Account state past 60s blocks with a reason rather than being used."],
  ["Guess at a missing price", "An unpriceable symbol blocks. It is never valued at zero."],
  ["Read an error as an empty book", "An unreadable source is recorded as degraded and blocks."],
  ["Block a trade that reduces risk", "Exposure is measured on the resulting position, so closing is never charged for."],
  ["Approve more than it permitted", "An ALLOW_REDUCED approval binds the reduced size, not the requested one."],
];

const TOOLS = [
  {
    name: "check_action",
    phase: "check",
    desc: "Evaluate one proposed order. Returns ALLOW, ALLOW_REDUCED or BLOCK, every rule it breached, and a signed approval when permitted.",
  },
  {
    name: "account_risk",
    phase: "read",
    desc: "Current exposure with no action proposed: equity, notional, per-position share, cluster concentration, mark prices, staleness. No verdict.",
  },
  {
    name: "verify_approval",
    phase: "verify",
    desc: "For whatever places the order. Confirms this guardrail authorized exactly that order, once, and recently. Consumes the approval.",
  },
];

const REPO = [
  ["src/engine/rules.js", "the six rules; pure, no I/O, no clock"],
  ["src/engine/clusters.js", "static correlation clusters"],
  ["src/approval.js", "HMAC-signed single-use approvals"],
  ["src/guardrail.js", "orchestration: fetch, evaluate, narrate, validate"],
  ["src/agentos/", "MCP client, OAuth flow, account normalisation"],
  ["src/mcp/server.js", "the three MCP tools"],
  ["agent/", "the trading agent and its tool layer"],
  ["fixtures/accounts.js", "canned books, tuned per rule"],
  ["test/", "92 tests, no network, no API key"],
];

const FAQ = [
  [
    "Is this trading with real money?",
    "No. This service has no execution code at all, and the account it reads is fixture state until an Agent OS client ID is issued. It cannot place an order in any mode, because no such mode exists.",
  ],
  [
    "Why does it refuse so often?",
    "The demo book is deliberately close to its limits, so that four of the six rules can be seen firing without inventing a second account. On a book with room, most orders pass.",
  ],
  [
    "Can the model talk its way past a limit?",
    "It has no route to. The engine is a pure function with no model in it, and the agent has no tool that acts without calling it. The model writes the explanation after the fact, from a frozen copy of the verdict.",
  ],
  [
    "What stops a third party ignoring the verdict?",
    "Nothing can, and pretending otherwise would be dishonest — this service never touches the exchange, so it has no gate to stand in. What it does is sign what it approved, so an unapproved order is provably unapproved afterwards.",
  ],
  [
    "Why is Agent OS showing 401?",
    "It is an OAuth-protected resource and Binance issues client IDs out of band. The transport, discovery and authorization-code flow are implemented and live; the credential is not. /agentos reports that rather than hiding it.",
  ],
  [
    "Are the thresholds adjustable?",
    "Every one of them, per request. A caller can run stricter limits than the defaults without redeploying — the last demo scenario does exactly that.",
  ],
];

export function landingPage({ narrationEnabled, provider }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>lyp — risk guardrail for Binance Agent OS</title>
<meta name="description" content="A read-only risk guardrail between a trading agent and Binance Agent OS. Six deterministic rules, signed single-use approvals, and a verdict no model can reach.">
<meta name="color-scheme" content="dark">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --bg:        #07070a;
    --bg-raise:  #0e0e13;
    --bg-card:   #12121a;
    --bg-inset:  #0a0a10;
    --line:      #21212c;
    --line-soft: #17171f;
    --fg:        #eeedea;
    --fg-dim:    #9b99a4;
    --fg-faint:  #605e6b;
    --allow:     #4ade80;
    --reduce:    #fbbf24;
    --block:     #fb7185;
    --accent:    #5eead4;
    --violet:    #a78bfa;
    --sans: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    --mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    --col: 1140px;
  }

  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; scroll-behavior: smooth; scroll-padding-top: 76px; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font-family: var(--sans); font-size: 16px; line-height: 1.65;
    -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
    overflow-x: hidden;
  }

  /* Drifting colour behind everything. Three orbs on long, offset loops so the
     background never quite repeats. */
  .orb { position: fixed; border-radius: 50%; filter: blur(90px); pointer-events: none; z-index: 0; opacity: .5; }
  .orb-1 { width: 620px; height: 620px; top: -190px; left: -130px;
           background: radial-gradient(circle, rgba(94,234,212,.16), transparent 68%);
           animation: drift1 26s ease-in-out infinite; }
  .orb-2 { width: 540px; height: 540px; top: 8%; right: -170px;
           background: radial-gradient(circle, rgba(167,139,250,.14), transparent 68%);
           animation: drift2 32s ease-in-out infinite; }
  .orb-3 { width: 460px; height: 460px; top: 46%; left: 32%;
           background: radial-gradient(circle, rgba(74,222,128,.07), transparent 70%);
           animation: drift3 38s ease-in-out infinite; }
  @keyframes drift1 { 0%,100%{transform:translate(0,0) scale(1)} 50%{transform:translate(70px,50px) scale(1.09)} }
  @keyframes drift2 { 0%,100%{transform:translate(0,0) scale(1)} 50%{transform:translate(-60px,70px) scale(.93)} }
  @keyframes drift3 { 0%,100%{transform:translate(0,0)} 50%{transform:translate(50px,-60px)} }

  .shell { position: relative; z-index: 1; max-width: var(--col); margin: 0 auto; padding: 0 28px; }
  a { color: inherit; }
  h1,h2,h3 { margin: 0; font-weight: 600; letter-spacing: -0.024em; line-height: 1.18; }
  p { margin: 0; }
  .mono { font-family: var(--mono); }

  /* ------------------------------------------------------------------ nav */
  nav { position: sticky; top: 0; z-index: 50;
        background: rgba(7,7,10,.76); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
        border-bottom: 1px solid var(--line-soft); }
  .nav-in { max-width: var(--col); margin: 0 auto; padding: 0 28px; height: 62px;
            display: flex; align-items: center; justify-content: space-between; gap: 20px; }
  .brand { font-family: var(--mono); font-size: 16px; font-weight: 600; letter-spacing: .05em;
           display: flex; align-items: center; gap: 10px; flex: 0 0 auto; }
  .brand .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--allow);
                box-shadow: 0 0 12px rgba(74,222,128,.9); animation: pulse 2.6s ease-in-out infinite; }
  @keyframes pulse { 0%,100%{opacity:1;box-shadow:0 0 12px rgba(74,222,128,.9)} 50%{opacity:.55;box-shadow:0 0 5px rgba(74,222,128,.5)} }
  .nav-links { display: flex; align-items: center; gap: 22px; font-size: 13.5px; color: var(--fg-dim); overflow-x: auto; }
  .nav-links::-webkit-scrollbar { display: none; }
  .nav-links a { text-decoration: none; transition: color .16s; white-space: nowrap; }
  .nav-links a:hover { color: var(--fg); }
  @media (max-width: 900px) { .nav-links .opt { display: none; } }

  /* ----------------------------------------------------------------- hero */
  header { padding: 96px 0 76px; }
  .pills { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 28px; }
  .pill { font-family: var(--mono); font-size: 11.5px; letter-spacing: .03em; padding: 5px 12px;
          border-radius: 999px; border: 1px solid var(--line); background: var(--bg-raise);
          color: var(--fg-dim); display: inline-flex; align-items: center; gap: 7px; }
  .pill b { font-weight: 500; color: var(--fg); }
  .pill.key { border-color: rgba(94,234,212,.34); background: rgba(94,234,212,.07); color: var(--accent); }
  .pill .led { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }

  h1.hero { font-size: clamp(42px, 7.6vw, 76px); font-weight: 700; letter-spacing: -.045em;
            line-height: 1.03; margin-bottom: 22px; }
  h1.hero .grad { background: linear-gradient(103deg, var(--accent) 0%, var(--violet) 58%, var(--fg) 100%);
                  -webkit-background-clip: text; background-clip: text; color: transparent; }
  .lede { font-size: clamp(16.5px, 2vw, 19.5px); color: var(--fg-dim); max-width: 660px; line-height: 1.58; }
  .lede strong { color: var(--fg); font-weight: 500; }
  .vchips { display: inline-flex; gap: 6px; flex-wrap: wrap; }
  .vchip { font-family: var(--mono); font-size: .82em; padding: 1px 8px; border-radius: 5px;
           border: 1px solid currentColor; font-weight: 500; }
  .vchip.a { color: var(--allow); } .vchip.r { color: var(--reduce); } .vchip.b { color: var(--block); }

  .cta { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 34px; }
  .btn { font-size: 14.5px; font-weight: 500; padding: 11px 21px; border-radius: 10px; cursor: pointer;
         text-decoration: none; display: inline-flex; align-items: center; gap: 9px;
         transition: transform .18s cubic-bezier(.34,1.4,.64,1), border-color .18s, background .18s, box-shadow .18s;
         border: 1px solid var(--line); background: var(--bg-card); color: var(--fg); }
  .btn:hover { border-color: #363642; transform: translateY(-2px); box-shadow: 0 10px 26px rgba(0,0,0,.45); }
  .btn.primary { background: var(--fg); color: #07070a; border-color: var(--fg); font-weight: 600; }
  .btn.primary:hover { background: #fff; box-shadow: 0 10px 30px rgba(238,237,234,.16); }

  .stats { display: flex; flex-wrap: wrap; gap: 34px; margin-top: 52px; padding-top: 30px;
           border-top: 1px solid var(--line-soft); }
  .stat .v { font-family: var(--mono); font-size: 26px; font-weight: 600; letter-spacing: -.02em; }
  .stat .k { font-size: 12.5px; color: var(--fg-faint); margin-top: 1px; }

  /* -------------------------------------------------------------- sections */
  section { padding: 78px 0; border-top: 1px solid var(--line-soft); position: relative; }
  .eyebrow { font-family: var(--mono); font-size: 11.5px; letter-spacing: .15em; text-transform: uppercase;
             color: var(--accent); margin-bottom: 15px; }
  h2.sec { font-size: clamp(25px, 3.4vw, 33px); margin-bottom: 16px; letter-spacing: -.032em; }
  .sec-lede { color: var(--fg-dim); max-width: 680px; font-size: 16.5px; }

  /* Scroll reveal.
     Gated on a "js" class that an inline script sets before the body renders.
     Content is therefore visible by default and only hidden when JavaScript is
     definitely running to reveal it again -- otherwise a failed observer, a
     blocked script or a stalled frame leaves the entire page blank, which is a
     far worse outcome than no animation. */
  .js .rv { opacity: 0; transform: translateY(18px); transition: opacity .6s ease, transform .6s cubic-bezier(.22,1,.36,1); }
  .js .rv.in { opacity: 1; transform: none; }
  @media (prefers-reduced-motion: reduce) {
    .js .rv { opacity: 1; transform: none; transition: none; }
    .orb { animation: none; }
    .float { animation: none !important; }
  }

  /* Idle float for feature cards */
  .float { animation: bob 7s ease-in-out infinite; }
  .float:nth-child(2) { animation-delay: -1.6s; }
  .float:nth-child(3) { animation-delay: -3.2s; }
  .float:nth-child(4) { animation-delay: -4.8s; }
  @keyframes bob { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-7px)} }

  .grid4 { display: grid; grid-template-columns: repeat(auto-fit, minmax(238px,1fr)); gap: 16px; margin-top: 38px; }
  .card { background: var(--bg-card); border: 1px solid var(--line); border-radius: 14px; padding: 24px;
          transition: border-color .2s, transform .2s, box-shadow .2s; }
  .card:hover { border-color: #33333f; transform: translateY(-4px); box-shadow: 0 14px 34px rgba(0,0,0,.42); }
  .card h3 { font-size: 15.5px; margin-bottom: 9px; }
  .card p { font-size: 14px; color: var(--fg-dim); line-height: 1.58; }
  .card .num { font-family: var(--mono); font-size: 11.5px; color: var(--accent); margin-bottom: 11px; letter-spacing: .1em; }

  /* ---------------------------------------------------------------- steps */
  .steps { display: grid; grid-template-columns: repeat(auto-fit, minmax(215px,1fr)); gap: 0; margin-top: 40px;
           border: 1px solid var(--line-soft); border-radius: 14px; overflow: hidden; }
  .step { padding: 24px; border-right: 1px solid var(--line-soft); background: var(--bg); }
  .step:last-child { border-right: 0; }
  .step .n { font-family: var(--mono); font-size: 11px; color: var(--accent); letter-spacing: .12em; margin-bottom: 10px; }
  .step h3 { font-size: 14.5px; margin-bottom: 7px; }
  .step p { font-size: 13.5px; color: var(--fg-dim); line-height: 1.55; }
  @media (max-width: 760px) { .step { border-right: 0; border-bottom: 1px solid var(--line-soft); } }

  /* ----------------------------------------------------------------- demo */
  .demo { display: grid; grid-template-columns: 340px 1fr; gap: 18px; margin-top: 38px; align-items: start; }
  @media (max-width: 940px) { .demo { grid-template-columns: 1fr; } }
  .panel { background: var(--bg-card); border: 1px solid var(--line); border-radius: 15px; overflow: hidden; }
  .panel-head { padding: 13px 18px; border-bottom: 1px solid var(--line); background: var(--bg-inset);
                font-family: var(--mono); font-size: 11.5px; letter-spacing: .09em; text-transform: uppercase;
                color: var(--fg-faint); display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .panel-body { padding: 18px; }

  .scn { width: 100%; text-align: left; display: block; cursor: pointer; background: transparent; color: var(--fg);
         font-family: var(--sans); border: 1px solid var(--line); border-radius: 11px; padding: 13px 15px;
         margin-bottom: 9px; transition: all .17s; }
  .scn:last-of-type { margin-bottom: 0; }
  .scn:hover:not(:disabled) { border-color: #3b3b48; background: var(--bg-raise); transform: translateX(3px); }
  .scn.active { border-color: var(--accent); background: rgba(94,234,212,.07); }
  .scn:disabled { opacity: .45; cursor: default; }
  .scn-top { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; margin-bottom: 3px; }
  .scn-label { font-size: 14.5px; font-weight: 500; }
  .scn-q { font-family: var(--mono); font-size: 12px; color: var(--fg-faint); }
  .scn-note { font-size: 12.5px; color: var(--fg-dim); line-height: 1.45; }

  .book { margin-top: 16px; padding-top: 15px; border-top: 1px solid var(--line-soft);
          font-family: var(--mono); font-size: 11.5px; color: var(--fg-faint); line-height: 1.9; }
  .book .r { display: flex; justify-content: space-between; gap: 10px; }
  .book .r b { color: var(--fg-dim); font-weight: 500; }

  #out { min-height: 340px; }
  .empty { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 340px;
           color: var(--fg-faint); font-size: 14px; text-align: center; gap: 10px; padding: 30px; }
  .empty .glyph { font-family: var(--mono); font-size: 26px; color: var(--line); }
  .vhead { display: flex; align-items: center; gap: 13px; flex-wrap: wrap; margin-bottom: 4px; }
  .vbig { font-family: var(--mono); font-size: 27px; font-weight: 600; letter-spacing: -.02em; }
  .vbig.ALLOW{color:var(--allow)} .vbig.ALLOW_REDUCED{color:var(--reduce)} .vbig.BLOCK{color:var(--block)}
  .vsuggest { font-family: var(--mono); font-size: 13px; color: var(--reduce); border: 1px solid currentColor;
              border-radius: 6px; padding: 3px 10px; }
  .vmeta { font-family: var(--mono); font-size: 11.5px; color: var(--fg-faint); margin-bottom: 18px; }
  .viol { border-left: 2px solid var(--line); padding: 2px 0 2px 15px; margin-bottom: 16px; }
  .viol.block{border-color:var(--block)} .viol.reduce{border-color:var(--reduce)} .viol.warn{border-color:var(--fg-faint)}
  .viol-top { display: flex; align-items: center; gap: 9px; margin-bottom: 5px; flex-wrap: wrap; }
  .sev { font-family: var(--mono); font-size: 10px; font-weight: 600; letter-spacing: .09em; padding: 2px 7px; border-radius: 4px; }
  .sev.block{color:var(--block);background:rgba(251,113,133,.12)}
  .sev.reduce{color:var(--reduce);background:rgba(251,191,36,.12)}
  .sev.warn{color:var(--fg-faint);background:rgba(255,255,255,.05)}
  .viol-rule { font-family: var(--mono); font-size: 13px; font-weight: 500; }
  .viol-num { font-family: var(--mono); font-size: 11.5px; color: var(--fg-faint); margin-left: auto; }
  .viol-why { font-size: 14px; color: var(--fg-dim); line-height: 1.58; }
  .appr { margin-top: 16px; padding: 14px 16px; border-radius: 10px; background: rgba(94,234,212,.055);
          border: 1px solid rgba(94,234,212,.22); }
  .appr .t { font-family: var(--mono); font-size: 10px; letter-spacing: .11em; text-transform: uppercase;
             color: var(--accent); margin-bottom: 7px; }
  .appr .tok { font-family: var(--mono); font-size: 11.5px; color: var(--fg-dim); word-break: break-all; }
  .narr { margin-top: 16px; padding: 15px 17px; border-radius: 10px; background: var(--bg-inset); border: 1px solid var(--line-soft); }
  .narr-tag { font-family: var(--mono); font-size: 10px; letter-spacing: .11em; text-transform: uppercase;
              color: var(--fg-faint); margin-bottom: 7px; }
  .narr p { font-size: 14px; color: var(--fg-dim); line-height: 1.62; }
  .fadein { animation: fade .34s ease both; }
  @keyframes fade { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:none} }

  /* --------------------------------------------------------------- tables */
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th { text-align: left; padding: 10px 12px 10px 0; border-bottom: 1px solid var(--line);
       color: var(--fg-faint); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .09em; }
  td { padding: 13px 12px 13px 0; border-bottom: 1px solid var(--line-soft); vertical-align: top; color: var(--fg-dim); }
  td.k { font-family: var(--mono); font-size: 12.5px; color: var(--fg); white-space: nowrap; }
  td.n { font-family: var(--mono); font-size: 12px; color: var(--fg-faint); white-space: nowrap; }
  .tbl-wrap { margin-top: 34px; overflow-x: auto; }
  tr.rule-row:hover td { background: rgba(255,255,255,.017); }
  .soft { color: var(--reduce); } .hard { color: var(--block); }

  /* ---------------------------------------------------------------- flow */
  .flow { display: flex; align-items: stretch; margin-top: 38px; flex-wrap: wrap; }
  .node { flex: 1 1 195px; background: var(--bg-card); border: 1px solid var(--line); border-radius: 13px; padding: 20px;
          transition: transform .2s, border-color .2s; }
  .node:hover { transform: translateY(-3px); border-color: #33333f; }
  .node.mid { border-color: rgba(94,234,212,.36); background: rgba(94,234,212,.05); }
  .node .n-name { font-family: var(--mono); font-size: 13.5px; font-weight: 600; margin-bottom: 6px; }
  .node.mid .n-name { color: var(--accent); }
  .node .n-desc { font-size: 13px; color: var(--fg-dim); line-height: 1.5; }
  .node.dashed { border-style: dashed; opacity: .72; }
  .arrow { flex: 0 0 76px; display: flex; flex-direction: column; align-items: center; justify-content: center;
           gap: 5px; padding: 0 6px; }
  .arrow .lbl { font-family: var(--mono); font-size: 10px; color: var(--fg-faint); white-space: nowrap; }
  .arrow .ln { width: 100%; height: 1px; background: linear-gradient(90deg, var(--line), #3d3d4a, var(--line)); }
  .arrow.unwired .ln { background: repeating-linear-gradient(90deg, #3d3d4a 0 4px, transparent 4px 8px); }
  @media (max-width: 800px) { .arrow { flex: 1 1 100%; padding: 12px 0; } .arrow .ln { width: 1px; height: 18px; } }

  /* --------------------------------------------------------------- tabs */
  .tabs { display: flex; gap: 6px; margin-top: 34px; flex-wrap: wrap; }
  .tab { font-size: 13.5px; padding: 8px 15px; border-radius: 9px; cursor: pointer; background: transparent;
         color: var(--fg-dim); border: 1px solid var(--line); font-family: var(--sans); transition: all .16s; }
  .tab:hover { color: var(--fg); border-color: #33333f; }
  .tab.on { background: var(--bg-card); color: var(--fg); border-color: var(--accent); }
  pre.snip { background: var(--bg-inset); border: 1px solid var(--line); border-radius: 12px; padding: 18px 20px;
             overflow-x: auto; margin-top: 14px; font-family: var(--mono); font-size: 12.5px; line-height: 1.75;
             color: var(--fg-dim); }
  pre.snip .c { color: var(--fg-faint); } pre.snip .k { color: var(--accent); }

  /* ---------------------------------------------------------------- misc */
  .never { display: grid; grid-template-columns: repeat(auto-fit, minmax(268px,1fr)); gap: 14px; margin-top: 36px; }
  .nv { background: var(--bg-card); border: 1px solid var(--line); border-radius: 12px; padding: 19px 20px;
        transition: transform .2s, border-color .2s; }
  .nv:hover { transform: translateY(-3px); border-color: rgba(251,113,133,.3); }
  .nv .t { font-size: 14.5px; font-weight: 600; margin-bottom: 7px; display: flex; align-items: center; gap: 8px; }
  .nv .t .x { color: var(--block); font-family: var(--mono); }
  .nv p { font-size: 13.5px; color: var(--fg-dim); line-height: 1.55; }

  .tools { display: grid; gap: 12px; margin-top: 34px; }
  .tool { display: grid; grid-template-columns: 190px 1fr; gap: 20px; background: var(--bg-card);
          border: 1px solid var(--line); border-radius: 12px; padding: 17px 20px; align-items: start;
          transition: transform .2s, border-color .2s; }
  .tool:hover { transform: translateX(4px); border-color: #33333f; }
  .tool code { font-family: var(--mono); font-size: 13px; color: var(--accent); }
  .tool .ph { font-family: var(--mono); font-size: 10px; letter-spacing: .1em; text-transform: uppercase;
              color: var(--fg-faint); display: block; margin-top: 3px; }
  .tool p { font-size: 13.5px; color: var(--fg-dim); line-height: 1.55; }
  @media (max-width: 700px) { .tool { grid-template-columns: 1fr; gap: 7px; } }

  details { border-bottom: 1px solid var(--line-soft); }
  details summary { cursor: pointer; padding: 17px 0; font-size: 15.5px; font-weight: 500; list-style: none;
                    display: flex; justify-content: space-between; align-items: center; gap: 16px; transition: color .16s; }
  details summary:hover { color: var(--accent); }
  details summary::-webkit-details-marker { display: none; }
  details summary::after { content: "+"; font-family: var(--mono); color: var(--fg-faint); font-size: 18px; flex: 0 0 auto; }
  details[open] summary::after { content: "\\2212"; }
  details p { padding: 0 0 19px; color: var(--fg-dim); font-size: 14.5px; max-width: 760px; line-height: 1.62; }

  footer { border-top: 1px solid var(--line-soft); padding: 46px 0 62px; }
  .foot { display: grid; grid-template-columns: 1.6fr 1fr 1fr; gap: 30px; }
  @media (max-width: 760px) { .foot { grid-template-columns: 1fr; } }
  .foot h4 { font-size: 11px; text-transform: uppercase; letter-spacing: .1em; color: var(--fg-faint);
             margin: 0 0 13px; font-weight: 600; }
  .foot a { color: var(--fg-dim); text-decoration: none; font-size: 14px; display: block; padding: 3px 0; transition: color .16s; }
  .foot a:hover { color: var(--fg); }
  .foot .note { font-size: 13.5px; color: var(--fg-faint); line-height: 1.62; max-width: 400px; }
</style>
</head>
<body>

<script>document.documentElement.className+=" js";</script>

<div class="orb orb-1"></div><div class="orb orb-2"></div><div class="orb orb-3"></div>

<nav>
  <div class="nav-in">
    <div class="brand"><span class="dot"></span>lyp</div>
    <div class="nav-links">
      <a href="#how">How it works</a>
      <a href="#demo">Demo</a>
      <a href="#rules" class="opt">Rules</a>
      <a href="#approvals" class="opt">Approvals</a>
      <a href="#architecture" class="opt">Architecture</a>
      <a href="#connect">Connect</a>
      <a href="#agentos" class="opt">Agent OS</a>
      <a href="#faq" class="opt">FAQ</a>
      <a href="https://github.com/0xileri/lyp">GitHub&nbsp;↗</a>
    </div>
  </div>
</nav>

<div class="shell">

  <header>
    <div class="pills">
      <span class="pill key"><span class="led"></span>Read-only · never places trades</span>
      <span class="pill">provider <b>${provider}</b></span>
      <span class="pill">narration <b>${narrationEnabled ? "on" : "off"}</b></span>
      <span class="pill">approvals <b>signed</b></span>
    </div>

    <h1 class="hero">The check that<br><span class="grad">says no.</span></h1>

    <p class="lede">A read-only risk guardrail between a trading agent and
      <strong>Binance Agent OS</strong>. Propose an action, get back
      <span class="vchips"><span class="vchip a">ALLOW</span><span class="vchip r">ALLOW_REDUCED</span><span class="vchip b">BLOCK</span></span>
      — with every limit the action breaches, the number that breached it, and a signed
      approval bound to exactly what was permitted.</p>

    <div class="cta">
      <a href="#demo" class="btn primary">Run a live check →</a>
      <a href="https://github.com/0xileri/lyp" class="btn">View source</a>
    </div>

    <div class="stats">
      <div class="stat"><div class="v">6</div><div class="k">deterministic rules</div></div>
      <div class="stat"><div class="v">92</div><div class="k">tests passing</div></div>
      <div class="stat"><div class="v">3</div><div class="k">MCP tools</div></div>
      <div class="stat"><div class="v">0</div><div class="k">orders it can place</div></div>
    </div>
  </header>

  <section id="why" class="rv">
    <div class="eyebrow">The gap</div>
    <h2 class="sec">The model deciding the trade<br>should not also approve it.</h2>
    <p class="sec-lede">An autonomous trading agent has a model choosing what to trade and an
      exchange executing it. Between those two there is usually nothing — the model's judgment
      is also the risk check. That holds until it doesn't, and it fails in specific ways.</p>

    <div class="grid4">
      <div class="card float"><div class="num">01</div><h3>Nobody owns "how much"</h3>
        <p>The model sizes the position. A model that has been right nine times sizes the tenth trade like it will also be right.</p></div>
      <div class="card float"><div class="num">02</div><h3>Correlation is invisible per-trade</h3>
        <p>Every individual buy looks diversified. The book is one bet, and you find out when everything moves together.</p></div>
      <div class="card float"><div class="num">03</div><h3>Loops don't look like errors</h3>
        <p>An agent placing the same order forty times is placing forty individually valid orders. Size never catches it. Frequency does.</p></div>
      <div class="card float"><div class="num">04</div><h3>A prompt is not a constraint</h3>
        <p>"Never risk more than 10%" in a system prompt is a suggestion a model can talk itself out of, leaving no record of what was violated.</p></div>
    </div>
  </section>

  <section id="how" class="rv">
    <div class="eyebrow">How it works</div>
    <h2 class="sec">One evaluation, four stages.</h2>
    <p class="sec-lede">Every check follows the same path, and the verdict is complete before
      any model is involved.</p>

    <div class="steps">
      <div class="step"><div class="n">01 · READ</div><h3>Fetch state</h3>
        <p>Balances, positions, open orders and marks. Account state cached 15s, market data 30s. A failed refresh serves the last known value with its true age.</p></div>
      <div class="step"><div class="n">02 · GATE</div><h3>Pre-checks</h3>
        <p>Missing price, stale state or an unreadable source each block outright. A rule that silently does not run is indistinguishable from one that passed.</p></div>
      <div class="step"><div class="n">03 · EVALUATE</div><h3>Six rules</h3>
        <p>Pure function, no I/O, no clock, no model. Rules collect every violation rather than stopping at the first, then fold into the worst outcome.</p></div>
      <div class="step"><div class="n">04 · SIGN</div><h3>Mint approval</h3>
        <p>A permitted verdict is signed and bound to symbol, side, type and a maximum quantity. Single-use, 60s. A BLOCK mints nothing.</p></div>
    </div>
  </section>

  <section id="demo" class="rv">
    <div class="eyebrow">Live</div>
    <h2 class="sec">Try it against the real deployment.</h2>
    <p class="sec-lede">Each scenario sends an actual <span class="mono">POST /check</span> to this
      service — the same endpoint an agent calls. Nothing here is canned.</p>

    <div class="demo">
      <div class="panel">
        <div class="panel-head"><span>Proposed action</span></div>
        <div class="panel-body">
          ${SCENARIOS.map(
            (s) => `<button class="scn" data-id="${s.id}">
            <div class="scn-top"><span class="scn-label">${s.label}</span><span class="scn-q">${s.sub}${s.leverage ? " @" + s.leverage + "x" : ""}</span></div>
            <div class="scn-note">${s.note}</div>
          </button>`,
          ).join("\n          ")}
          <div class="book">
            <div class="r"><span>equity</span><b>100,000 USDT</b></div>
            <div class="r"><span>exposure</span><b>30,000 · 0.30x</b></div>
            <div class="r"><span>positions</span><b>BTC · SOL · ADA · DOGE</b></div>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head"><span>Verdict</span><span id="lat"></span></div>
        <div class="panel-body" id="out">
          <div class="empty"><div class="glyph">{ }</div><div>Select a scenario to send a live request.</div></div>
        </div>
      </div>
    </div>
  </section>

  <section id="rules" class="rv">
    <div class="eyebrow">The rules</div>
    <h2 class="sec">Six limits. Every breach reported.</h2>
    <p class="sec-lede">Rules collect violations rather than short-circuiting, so one response
      carries every limit an action breaches — not just the first. The verdict is the worst
      outcome across all of them. Every threshold is overridable per request.</p>

    <div class="tbl-wrap">
      <table>
        <tr><th>#</th><th>rule</th><th>measure</th><th>soft</th><th>hard</th><th>protects against</th></tr>
        ${RULES.map(
          (r) => `<tr class="rule-row"><td class="n">${r.n}</td><td class="k">${r.code}</td>
          <td class="n">${r.measure}</td><td class="n soft">${r.soft}</td><td class="n hard">${r.hard}</td>
          <td>${r.protects}</td></tr>`,
        ).join("\n        ")}
      </table>
    </div>

    <h3 style="margin-top:52px;font-size:17px">Gates that run first</h3>
    <p class="sec-lede" style="margin-top:9px">Before any exposure arithmetic. Each one fails closed.</p>
    <div class="tbl-wrap">
      <table>
        <tr><th>gate</th><th>fires when</th><th>result</th><th>why</th></tr>
        ${GATES.map(
          (g) => `<tr class="rule-row"><td class="k">${g.code}</td><td class="n">${g.when}</td>
          <td class="n hard">${g.result}</td><td>${g.why}</td></tr>`,
        ).join("\n        ")}
      </table>
    </div>
  </section>

  <section id="approvals" class="rv">
    <div class="eyebrow">Approvals</div>
    <h2 class="sec">Advisory, or verifiable.</h2>
    <p class="sec-lede">A verdict on its own is advice. A caller can ask about one ETH, receive
      ALLOW, and trade a hundred — nothing about the answer contradicts them. So a permitted
      verdict is signed.</p>

    <div class="steps" style="margin-top:34px">
      <div class="step"><div class="n">01</div><h3>check_action</h3><p>Returns the verdict and, when permitted, an HMAC-signed token bound to symbol, side, type and a maximum quantity.</p></div>
      <div class="step"><div class="n">02</div><h3>60-second window</h3><p>Long enough to place the order, short enough that it cannot be banked. Account state is only fresh for 60s anyway.</p></div>
      <div class="step"><div class="n">03</div><h3>verify_approval</h3><p>Whatever places the order presents it. 200 means this guardrail authorized exactly that order.</p></div>
      <div class="step"><div class="n">04</div><h3>Consumed</h3><p>Single-use. A second redemption is refused. A failed verification does not burn it.</p></div>
    </div>

    <div class="tbl-wrap">
      <table>
        <tr><th>rejection</th><th>meaning</th></tr>
        ${REJECTIONS.map(([c, m]) => `<tr class="rule-row"><td class="k">${c}</td><td>${m}</td></tr>`).join("\n        ")}
      </table>
    </div>

    <p class="sec-lede" style="margin-top:34px"><strong style="color:var(--fg)">What this does not do.</strong>
      It cannot force an executor to check. This service never touches the exchange, so it has
      no chokepoint to stand in. What it converts is <em>"the guardrail said yes, trust me"</em>
      into <em>"here is proof it said yes, to this order, at this time, once"</em> — making an
      unapproved order visibly unapproved afterwards.</p>
  </section>

  <section id="architecture" class="rv">
    <div class="eyebrow">Architecture</div>
    <h2 class="sec">One read-only hop.</h2>
    <p class="sec-lede">lyp holds market-data and account-read scope and nothing else. It wires
      no order tools and refuses to call one even if the endpoint offers it — enforced by an
      allowlist and a denylist, checked before every call.</p>

    <div class="flow">
      <div class="node"><div class="n-name">trading agent</div><div class="n-desc">Decides what to trade. Its only action tool calls the guardrail first.</div></div>
      <div class="arrow"><span class="lbl">check_action</span><span class="ln"></span><span class="lbl">verdict + approval</span></div>
      <div class="node mid"><div class="n-name">lyp</div><div class="n-desc">Six rules, three gates, pure evaluation. Mints signed approvals.</div></div>
      <div class="arrow unwired"><span class="lbl">read-only</span><span class="ln"></span><span class="lbl">401 — pending client ID</span></div>
      <div class="node dashed"><div class="n-name">Binance Agent OS</div><div class="n-desc">Balances, positions, orders, marks. OAuth-gated; not yet authorized.</div></div>
    </div>
    <p class="sec-lede" style="margin-top:18px;font-size:14px">The dashed hop is not connected. The
      transport, OAuth discovery and authorization-code flow are implemented and live; the
      client ID is issued by Binance out of band. Until then the book is fixture state, and
      <span class="mono">/health</span> says so.</p>
  </section>

  <section id="never" class="rv">
    <div class="eyebrow">Safety</div>
    <h2 class="sec">What lyp never does.</h2>
    <div class="never">
      ${NEVER.map(([t, d]) => `<div class="nv"><div class="t"><span class="x">✕</span>${t}</div><p>${d}</p></div>`).join("\n      ")}
    </div>
  </section>

  <section id="connect" class="rv">
    <div class="eyebrow">Connect</div>
    <h2 class="sec">Point any MCP client at it.</h2>
    <p class="sec-lede">The repo also ships <span class="mono">.mcp.json</span> at project scope,
      which wires both lyp and Binance Agent OS in one step.</p>

    <div class="tabs">
      <button class="tab on" data-tab="cc">Claude Code</button>
      <button class="tab" data-tab="json">.mcp.json</button>
      <button class="tab" data-tab="rest">REST</button>
      <button class="tab" data-tab="agent">Run the agent</button>
    </div>

<pre class="snip" data-panel="cc">claude mcp add --transport http lyp https://lyp.up.railway.app/mcp
<span class="c"># then /mcp and pick lyp</span></pre>

<pre class="snip" data-panel="json" hidden>{
  <span class="k">"mcpServers"</span>: {
    <span class="k">"lyp"</span>: { <span class="k">"type"</span>: "http", <span class="k">"url"</span>: "https://lyp.up.railway.app/mcp" },
    <span class="k">"binance-agent-os"</span>: { <span class="k">"type"</span>: "http", <span class="k">"url"</span>: "https://agent.binance.com/mcp/agentic" }
  }
}</pre>

<pre class="snip" data-panel="rest" hidden><span class="c"># every threshold is overridable per request</span>
curl -X POST https://lyp.up.railway.app<span class="k">/check</span> \\
  -H <span class="k">'content-type: application/json'</span> \\
  -d <span class="k">'{"action":{"symbol":"ETHUSDT","side":"BUY","quantity":5,"orderType":"MARKET"},
       "thresholds":{"positionSize":{"soft":0.05}}}'</span></pre>

<pre class="snip" data-panel="agent" hidden>npm run agent:dry     <span class="c"># the full loop, no API key needed</span>
npm run demo:approval <span class="c"># mint one approval, spend it four ways</span>
npm run agent <span class="k">"Open an ETH position worth about 15% of equity."</span></pre>

    <div class="tools">
      ${TOOLS.map(
        (t) => `<div class="tool"><div><code>${t.name}</code><span class="ph">${t.phase}</span></div><p>${t.desc}</p></div>`,
      ).join("\n      ")}
    </div>
  </section>

  <section id="agentos" class="rv">
    <div class="eyebrow">Binance Agent OS</div>
    <h2 class="sec">Reported honestly.</h2>
    <p class="sec-lede"><a href="https://www.binance.com/en/agent-os" style="color:var(--accent)">Binance
      Agent OS</a> publishes one hosted endpoint,
      <span class="mono">agent.binance.com/mcp/agentic</span>, over MCP streamable HTTP. It is an
      OAuth 2.0 protected resource — discovered from its own 401 challenge rather than assumed.</p>

    <div class="tbl-wrap">
      <table>
        <tr><th>property</th><th>value</th></tr>
        <tr class="rule-row"><td class="k">endpoint</td><td class="n">agent.binance.com/mcp/agentic</td></tr>
        <tr class="rule-row"><td class="k">authorization</td><td class="n">accounts.binance.com/agentic-oauth/authorize</td></tr>
        <tr class="rule-row"><td class="k">token</td><td class="n">accounts.binance.com/oauth-agentic/token</td></tr>
        <tr class="rule-row"><td class="k">grant</td><td class="n">authorization_code + PKCE S256</td></tr>
        <tr class="rule-row"><td class="k">registration</td><td class="n">none — client IDs issued out of band</td></tr>
        <tr class="rule-row"><td class="k">status</td><td class="n hard">401 — implemented, not yet authorized</td></tr>
      </table>
    </div>

    <p class="sec-lede" style="margin-top:26px">There is no API-key path, so "set a token" is not an
      instruction anyone can follow — a token only exists through consent. The flow is built:
      <span class="mono">/connect</span> starts it, <span class="mono">/callback</span> completes
      the exchange. Only market-data and account-read scopes are requested; trading scopes are
      never asked for, so the read-only guarantee does not rest on this service behaving well.
      Live state is at <a href="/agentos" class="mono" style="color:var(--accent)">/agentos</a>.</p>

    <h3 style="margin-top:50px;font-size:17px">Skills Hub</h3>
    <p class="sec-lede" style="margin-top:9px">Agent OS is more than the MCP gateway.
      <a href="https://github.com/binance/binance-skills-hub" style="color:var(--accent)">Binance
      Skills Hub</a> pairs with this service — <span class="mono">query-token-audit</span> and
      <span class="mono">check_action</span> answer the two halves of the same question: is this
      token safe, and is this position sized safely.</p>

<pre class="snip">npx skills add https://github.com/binance/binance-skills-hub</pre>

    <p class="sec-lede" style="margin-top:20px;font-size:14.5px">Six skills are installed, all of
      them query-only: <span class="mono">query-token-audit</span>,
      <span class="mono">query-token-info</span>, <span class="mono">query-address-info</span>,
      <span class="mono">crypto-market-rank</span>, <span class="mono">trading-signal</span> and
      <span class="mono">academy-skill</span>.</p>

    <p class="sec-lede" style="margin-top:14px;font-size:14.5px">The action-capable skills are
      deliberately not installed. Skills Hub also ships wallet, payment, P2P, fiat and spot-trading
      skills that can move funds or place orders, and they load into an agent's context with full
      permissions. A repository whose central claim is that it <em>cannot place a trade</em> has no
      business also carrying a <span class="mono">send.py</span>. Every endpoint the six call was
      checked to be a <span class="mono">/public/</span> query path.</p>

    <h3 style="margin-top:50px;font-size:17px">Repository</h3>
    <div class="tbl-wrap">
      <table>
        ${REPO.map(([p, d]) => `<tr class="rule-row"><td class="k">${p}</td><td>${d}</td></tr>`).join("\n        ")}
      </table>
    </div>
  </section>

  <section id="faq" class="rv">
    <div class="eyebrow">FAQ</div>
    <h2 class="sec">Questions judges ask.</h2>
    <div style="margin-top:26px">
      ${FAQ.map(([q, a]) => `<details><summary>${q}</summary><p>${a}</p></details>`).join("\n      ")}
    </div>
  </section>

</div>

<footer>
  <div class="shell">
    <div class="foot">
      <div>
        <div class="brand" style="margin-bottom:14px"><span class="dot"></span>lyp</div>
        <p class="note">A read-only risk guardrail for Binance Agent OS. Six deterministic rules,
          signed single-use approvals, and a verdict no model can reach. Running on fixture state
          until a client ID is issued — <span class="mono">/health</span> says which.</p>
      </div>
      <div>
        <h4>Product</h4>
        <a href="#demo">Live demo</a><a href="#rules">The rules</a>
        <a href="#approvals">Approvals</a><a href="#never">Safety</a>
      </div>
      <div>
        <h4>Ecosystem</h4>
        <a href="https://www.binance.com/en/agent-os">Binance Agent OS ↗</a>
        <a href="https://github.com/binance/binance-skills-hub">Binance Skills Hub ↗</a>
        <a href="https://agent.binance.com/mcp/agentic">MCP endpoint ↗</a>
        <a href="https://modelcontextprotocol.io">Model Context Protocol ↗</a>
        <a href="https://github.com/0xileri/lyp">Source on GitHub ↗</a>
      </div>
    </div>
  </div>
</footer>

<script>
  const SCENARIOS = ${JSON.stringify(
    SCENARIOS.map((s) => ({ id: s.id, quantity: s.quantity, leverage: s.leverage ?? null, thresholds: s.thresholds ?? null })),
  )};

  const out = document.getElementById("out");
  const lat = document.getElementById("lat");
  const buttons = [...document.querySelectorAll(".scn")];

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const fmt = (n) => Math.abs(n) < 10
    ? Number(n).toFixed(4).replace(/0+$/, "").replace(/\\.$/, "")
    : Math.round(n).toLocaleString("en-US");

  async function run(btn) {
    const scn = SCENARIOS.find((s) => s.id === btn.dataset.id);
    buttons.forEach((b) => { b.disabled = true; b.classList.toggle("active", b === btn); });
    lat.textContent = "";
    out.innerHTML = '<div class="empty"><div class="glyph">···</div><div>Evaluating…</div></div>';

    const action = { symbol: "ETHUSDT", side: "BUY", quantity: scn.quantity, orderType: "MARKET" };
    if (scn.leverage) action.leverage = scn.leverage;
    const body = { action, actor: "landing-page" };
    if (scn.thresholds) body.thresholds = scn.thresholds;

    const t0 = performance.now();
    try {
      const res = await fetch("/check", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const ms = Math.round(performance.now() - t0);
      const data = await res.json();
      lat.textContent = ms + "ms";
      render(data, scn.quantity);
    } catch (err) {
      out.innerHTML = '<div class="empty"><div class="glyph">!</div><div>Request failed: ' + esc(err.message) + "</div></div>";
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  }

  function render(r, quantity) {
    const snap = r.accountSnapshot || {};
    let h = '<div class="fadein">';

    h += '<div class="vhead"><span class="vbig ' + esc(r.verdict) + '">' + esc(r.verdict) + "</span>";
    if (r.suggestedQuantity) {
      h += '<span class="vsuggest">trade ' + esc(fmt(r.suggestedQuantity)) + " ETH instead of " + esc(quantity) + "</span>";
    }
    h += "</div>";

    h += '<div class="vmeta">equity ' + esc(fmt(snap.equity || 0)) + " USDT · exposure " +
         esc(fmt(snap.totalNotional || 0)) + " USDT · " + esc(snap.positionCount || 0) + " positions</div>";

    if (!r.violations || r.violations.length === 0) {
      h += '<div class="viol warn"><div class="viol-top"><span class="sev warn">CLEAR</span>' +
           '<span class="viol-rule">no limits breached</span></div>' +
           '<div class="viol-why">Every rule was evaluated and none objected.</div></div>';
    } else {
      for (const v of r.violations) {
        h += '<div class="viol ' + esc(v.severity) + '"><div class="viol-top"><span class="sev ' + esc(v.severity) + '">' +
             esc(v.severity.toUpperCase()) + '</span><span class="viol-rule">' + esc(v.rule) +
             '</span><span class="viol-num">' + esc(fmt(v.actual)) + " vs " + esc(fmt(v.threshold)) + "</span></div>" +
             '<div class="viol-why">' + esc(v.explanation) + "</div></div>";
      }
    }

    if (r.approval) {
      h += '<div class="appr"><div class="t">Signed approval · max ' + esc(fmt(r.approval.maxQuantity)) +
           " ETH · single-use</div><div class=\\"tok\\">" + esc(r.approval.token.slice(0, 64)) + "…</div></div>";
    }
    if (r.narration) {
      h += '<div class="narr"><div class="narr-tag">Narration · written after the verdict, never part of it</div><p>' +
           esc(r.narration) + "</p></div>";
    }
    h += "</div>";
    out.innerHTML = h;
  }

  buttons.forEach((b) => b.addEventListener("click", () => run(b)));

  // Connect tabs
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t === tab));
      document.querySelectorAll("[data-panel]").forEach((p) => {
        p.hidden = p.dataset.panel !== tab.dataset.tab;
      });
    });
  });

  // Scroll reveal.
  //
  // Two independent safety nets, because a section that never reveals is
  // invisible content rather than a missing animation:
  //   - anything already on screen at load is revealed immediately;
  //   - a timer reveals everything regardless after 2s, so a wedged observer
  //     costs the animation and nothing else.
  const revealables = [...document.querySelectorAll(".rv")];
  const reveal = (el) => el.classList.add("in");

  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) { reveal(e.target); io.unobserve(e.target); }
      }
    }, { rootMargin: "0px 0px -6% 0px", threshold: 0.02 });

    for (const el of revealables) {
      const box = el.getBoundingClientRect();
      if (box.top < innerHeight) reveal(el);
      else io.observe(el);
    }
    setTimeout(() => revealables.forEach(reveal), 2000);
  } else {
    revealables.forEach(reveal);
  }
</script>
</body>
</html>`;
}
