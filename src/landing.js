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
 */

const SCENARIOS = [
  {
    id: "clean",
    label: "Reasonable",
    sub: "BUY 2 ETH",
    quantity: 2,
    note: "6% of equity into a diversified book.",
  },
  {
    id: "reduced",
    label: "Oversized",
    sub: "BUY 5 ETH",
    quantity: 5,
    note: "15% of equity, past the 10% soft limit.",
  },
  {
    id: "blocked",
    label: "Reckless",
    sub: "BUY 12 ETH",
    quantity: 12,
    note: "36% of equity, past the 25% hard ceiling.",
  },
];

const RULES = [
  ["position_size", "Resulting position ÷ equity", "One bad call ending the account. A model that has been right nine times sizes the tenth trade like it will also be right."],
  ["total_exposure", "Book notional ÷ equity", "Leverage accumulating across many individually reasonable positions. No single trade looks wrong; the book does."],
  ["concentration", "One symbol ÷ total exposure", "A book that looks diversified by position count while being a single bet by size."],
  ["correlation", "One cluster ÷ total exposure", "Correlation blindness. Five L1s in a risk-off move are one position wearing five hats."],
  ["liquidation_distance", "Mark-to-liquidation ÷ mark", "Positions that survive on paper but not through an ordinary overnight candle."],
  ["activity_rate", "Checks per rolling hour", "A looping or malfunctioning agent. Runaway behaviour shows up as frequency long before size."],
];

export function landingPage({ narrationEnabled, provider }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>lyp — risk guardrail for Binance Agent OS</title>
<meta name="description" content="A read-only risk guardrail that sits between a trading agent and Binance Agent OS. Returns ALLOW, ALLOW_REDUCED or BLOCK with a reason for every limit breached. Never places trades.">
<meta name="color-scheme" content="dark">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --bg:        #0a0a0c;
    --bg-raise:  #101014;
    --bg-card:   #131318;
    --bg-inset:  #0d0d11;
    --line:      #22222b;
    --line-soft: #1a1a21;
    --fg:        #ecebe8;
    --fg-dim:    #9d9b95;
    --fg-faint:  #63615c;
    --allow:     #4ade80;
    --reduce:    #fbbf24;
    --block:     #f87171;
    --accent:    #7dd3a0;
    --sans: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    --mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    --col: 1120px;
  }

  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; scroll-behavior: smooth; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font-family: var(--sans);
    font-size: 16px;
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  /* A very soft wash behind the hero so the page does not read as a flat slab. */
  body::before {
    content: "";
    position: fixed; inset: 0; pointer-events: none; z-index: 0;
    background:
      radial-gradient(900px 480px at 12% -8%, rgba(125,211,160,0.055), transparent 62%),
      radial-gradient(760px 420px at 92% 4%, rgba(120,150,255,0.04), transparent 60%);
  }
  .shell { position: relative; z-index: 1; max-width: var(--col); margin: 0 auto; padding: 0 28px; }

  a { color: inherit; }
  h1, h2, h3 { margin: 0; font-weight: 600; letter-spacing: -0.022em; line-height: 1.2; }
  p { margin: 0; }
  .mono { font-family: var(--mono); }

  /* ---------------------------------------------------------------- nav */
  nav {
    position: sticky; top: 0; z-index: 20;
    background: rgba(10,10,12,0.72);
    backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
    border-bottom: 1px solid var(--line-soft);
  }
  .nav-in { max-width: var(--col); margin: 0 auto; padding: 0 28px;
            height: 60px; display: flex; align-items: center; justify-content: space-between; }
  .brand { font-family: var(--mono); font-size: 16px; font-weight: 600; letter-spacing: 0.04em;
           display: flex; align-items: center; gap: 9px; }
  .brand .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--allow);
                box-shadow: 0 0 11px rgba(74,222,128,0.75); }
  .nav-links { display: flex; align-items: center; gap: 26px; font-size: 14px; color: var(--fg-dim); }
  .nav-links a { text-decoration: none; transition: color .15s; }
  .nav-links a:hover { color: var(--fg); }
  @media (max-width: 620px) { .nav-links .hide-sm { display: none; } }

  /* --------------------------------------------------------------- hero */
  header { padding: 104px 0 84px; }
  .pills { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 30px; }
  .pill {
    font-family: var(--mono); font-size: 11.5px; letter-spacing: 0.03em;
    padding: 5px 12px; border-radius: 999px;
    border: 1px solid var(--line); background: var(--bg-raise); color: var(--fg-dim);
    display: inline-flex; align-items: center; gap: 7px;
  }
  .pill b { font-weight: 500; color: var(--fg); }
  .pill.key { border-color: rgba(74,222,128,0.32); background: rgba(74,222,128,0.06); color: var(--allow); }
  .pill .led { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }

  h1.hero {
    font-size: clamp(44px, 8.2vw, 82px); font-weight: 700; letter-spacing: -0.045em;
    line-height: 1.02; margin-bottom: 24px;
  }
  h1.hero .fade { color: var(--fg-faint); }
  .lede { font-size: clamp(17px, 2.1vw, 20px); color: var(--fg-dim); max-width: 640px; line-height: 1.55; }
  .lede strong { color: var(--fg); font-weight: 500; }

  .verdict-inline { display: inline-flex; gap: 7px; flex-wrap: wrap; margin: 0 2px; }
  .vchip { font-family: var(--mono); font-size: 0.86em; padding: 1px 8px; border-radius: 5px;
           border: 1px solid currentColor; font-weight: 500; }
  .vchip.a { color: var(--allow); } .vchip.r { color: var(--reduce); } .vchip.b { color: var(--block); }

  .cta { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 38px; }
  .btn {
    font-family: var(--sans); font-size: 14.5px; font-weight: 500;
    padding: 11px 20px; border-radius: 9px; cursor: pointer; text-decoration: none;
    display: inline-flex; align-items: center; gap: 9px; transition: all .16s;
    border: 1px solid var(--line); background: var(--bg-card); color: var(--fg);
  }
  .btn:hover { border-color: #35353f; background: var(--bg-raise); transform: translateY(-1px); }
  .btn.primary { background: var(--fg); color: #0a0a0c; border-color: var(--fg); font-weight: 600; }
  .btn.primary:hover { background: #fff; border-color: #fff; }

  /* ------------------------------------------------------------ sections */
  section { padding: 76px 0; border-top: 1px solid var(--line-soft); }
  .eyebrow {
    font-family: var(--mono); font-size: 11.5px; letter-spacing: 0.14em; text-transform: uppercase;
    color: var(--fg-faint); margin-bottom: 16px;
  }
  h2.sec { font-size: clamp(26px, 3.6vw, 34px); margin-bottom: 18px; letter-spacing: -0.03em; }
  .sec-lede { color: var(--fg-dim); max-width: 660px; font-size: 16.5px; }

  /* -------------------------------------------------------------- stakes */
  .stakes { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1px;
            background: var(--line-soft); border: 1px solid var(--line-soft);
            border-radius: 14px; overflow: hidden; margin-top: 38px; }
  .stake { background: var(--bg); padding: 26px 24px; }
  .stake h3 { font-size: 15.5px; margin-bottom: 9px; letter-spacing: -0.01em; }
  .stake p { font-size: 14.5px; color: var(--fg-dim); line-height: 1.58; }

  /* ---------------------------------------------------------------- demo */
  .demo { display: grid; grid-template-columns: 350px 1fr; gap: 18px; margin-top: 40px; align-items: start; }
  @media (max-width: 900px) { .demo { grid-template-columns: 1fr; } }

  .panel { background: var(--bg-card); border: 1px solid var(--line); border-radius: 14px; overflow: hidden; }
  .panel-head {
    padding: 13px 18px; border-bottom: 1px solid var(--line); background: var(--bg-inset);
    font-family: var(--mono); font-size: 11.5px; letter-spacing: 0.09em; text-transform: uppercase;
    color: var(--fg-faint); display: flex; justify-content: space-between; align-items: center; gap: 12px;
  }
  .panel-body { padding: 18px; }

  .scn { width: 100%; text-align: left; display: block; cursor: pointer;
         background: transparent; color: var(--fg); font-family: var(--sans);
         border: 1px solid var(--line); border-radius: 10px;
         padding: 13px 15px; margin-bottom: 9px; transition: all .15s; }
  .scn:last-child { margin-bottom: 0; }
  .scn:hover:not(:disabled) { border-color: #3a3a45; background: var(--bg-raise); }
  .scn.active { border-color: var(--accent); background: rgba(125,211,160,0.06); }
  .scn:disabled { opacity: .45; cursor: default; }
  .scn-top { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; margin-bottom: 3px; }
  .scn-label { font-size: 14.5px; font-weight: 500; }
  .scn-q { font-family: var(--mono); font-size: 12px; color: var(--fg-faint); }
  .scn-note { font-size: 12.5px; color: var(--fg-dim); line-height: 1.45; }

  .book { margin-top: 16px; padding-top: 15px; border-top: 1px solid var(--line-soft);
          font-family: var(--mono); font-size: 11.5px; color: var(--fg-faint); line-height: 1.85; }
  .book .r { display: flex; justify-content: space-between; gap: 10px; }
  .book .r b { color: var(--fg-dim); font-weight: 500; }

  #out { min-height: 320px; }
  .empty { display: flex; flex-direction: column; align-items: center; justify-content: center;
           min-height: 320px; color: var(--fg-faint); font-size: 14px; text-align: center; gap: 10px; padding: 30px; }
  .empty .glyph { font-family: var(--mono); font-size: 26px; color: var(--line); }

  .vhead { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 4px; }
  .vbig { font-family: var(--mono); font-size: 27px; font-weight: 600; letter-spacing: -0.02em; }
  .vbig.ALLOW { color: var(--allow); } .vbig.ALLOW_REDUCED { color: var(--reduce); } .vbig.BLOCK { color: var(--block); }
  .vsuggest { font-family: var(--mono); font-size: 13px; color: var(--reduce);
              border: 1px solid currentColor; border-radius: 6px; padding: 3px 10px; }
  .vmeta { font-family: var(--mono); font-size: 11.5px; color: var(--fg-faint); margin-bottom: 20px; }

  .viol { border-left: 2px solid var(--line); padding: 2px 0 2px 15px; margin-bottom: 17px; }
  .viol.block { border-color: var(--block); } .viol.reduce { border-color: var(--reduce); }
  .viol.warn { border-color: var(--fg-faint); }
  .viol-top { display: flex; align-items: center; gap: 9px; margin-bottom: 5px; flex-wrap: wrap; }
  .sev { font-family: var(--mono); font-size: 10px; font-weight: 600; letter-spacing: 0.09em;
         padding: 2px 7px; border-radius: 4px; }
  .sev.block { color: var(--block); background: rgba(248,113,113,0.11); }
  .sev.reduce { color: var(--reduce); background: rgba(251,191,36,0.11); }
  .sev.warn { color: var(--fg-faint); background: rgba(255,255,255,0.045); }
  .viol-rule { font-family: var(--mono); font-size: 13px; font-weight: 500; }
  .viol-num { font-family: var(--mono); font-size: 11.5px; color: var(--fg-faint); margin-left: auto; }
  .viol-why { font-size: 14px; color: var(--fg-dim); line-height: 1.58; }

  .narr { margin-top: 22px; padding: 16px 18px; border-radius: 10px;
          background: var(--bg-inset); border: 1px solid var(--line-soft); }
  .narr-tag { font-family: var(--mono); font-size: 10px; letter-spacing: 0.11em; text-transform: uppercase;
              color: var(--fg-faint); margin-bottom: 8px; }
  .narr p { font-size: 14px; color: var(--fg-dim); line-height: 1.62; }
  .fadein { animation: fade .32s ease both; }
  @keyframes fade { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }

  /* ---------------------------------------------------------------- flow */
  .flow { display: flex; align-items: stretch; gap: 0; margin-top: 40px; flex-wrap: wrap; }
  .node { flex: 1 1 200px; background: var(--bg-card); border: 1px solid var(--line);
          border-radius: 12px; padding: 20px; }
  .node.mid { border-color: rgba(125,211,160,0.34); background: rgba(125,211,160,0.045); }
  .node .n-name { font-family: var(--mono); font-size: 13.5px; font-weight: 600; margin-bottom: 6px; }
  .node.mid .n-name { color: var(--accent); }
  .node .n-desc { font-size: 13px; color: var(--fg-dim); line-height: 1.5; }
  .arrow { flex: 0 0 74px; display: flex; flex-direction: column; align-items: center;
           justify-content: center; gap: 5px; padding: 0 6px; }
  .arrow .lbl { font-family: var(--mono); font-size: 10px; color: var(--fg-faint); white-space: nowrap; }
  .arrow .ln { width: 100%; height: 1px; background: linear-gradient(90deg, var(--line), #3a3a45, var(--line)); }
  @media (max-width: 780px) { .arrow { flex: 1 1 100%; padding: 12px 0; } .arrow .ln { width: 1px; height: 18px; background: var(--line); } }

  /* --------------------------------------------------------------- rules */
  .rules { margin-top: 38px; border: 1px solid var(--line-soft); border-radius: 14px; overflow: hidden; }
  .rule { display: grid; grid-template-columns: 200px 190px 1fr; gap: 20px;
          padding: 19px 22px; border-bottom: 1px solid var(--line-soft); align-items: start; }
  .rule:last-child { border-bottom: 0; }
  .rule:nth-child(odd) { background: rgba(255,255,255,0.012); }
  .rule .rn { font-family: var(--mono); font-size: 13px; font-weight: 500; color: var(--fg); }
  .rule .rm { font-family: var(--mono); font-size: 12px; color: var(--fg-faint); }
  .rule .rp { font-size: 14px; color: var(--fg-dim); line-height: 1.55; }
  @media (max-width: 860px) {
    .rule { grid-template-columns: 1fr; gap: 6px; }
    .rule .rm { order: 3; }
  }

  /* ---------------------------------------------------------- guarantees */
  .guards { display: grid; grid-template-columns: repeat(auto-fit, minmax(255px, 1fr)); gap: 16px; margin-top: 38px; }
  .guard { background: var(--bg-card); border: 1px solid var(--line); border-radius: 13px; padding: 24px; }
  .guard .g-t { font-size: 15px; font-weight: 600; margin-bottom: 9px; display: flex; align-items: center; gap: 9px; }
  .guard .g-t .mk { color: var(--allow); font-family: var(--mono); }
  .guard p { font-size: 14px; color: var(--fg-dim); line-height: 1.58; }

  /* ------------------------------------------------------------ endpoints */
  .eps { margin-top: 38px; display: grid; gap: 12px; }
  .ep { display: grid; grid-template-columns: 210px 1fr; gap: 20px; align-items: center;
        background: var(--bg-card); border: 1px solid var(--line); border-radius: 11px; padding: 16px 20px; }
  .ep code { font-family: var(--mono); font-size: 13px; color: var(--accent); }
  .ep span { font-size: 14px; color: var(--fg-dim); }
  @media (max-width: 700px) { .ep { grid-template-columns: 1fr; gap: 7px; } }

  pre.snip { background: var(--bg-inset); border: 1px solid var(--line); border-radius: 11px;
             padding: 18px 20px; overflow-x: auto; margin-top: 20px;
             font-family: var(--mono); font-size: 12.5px; line-height: 1.7; color: var(--fg-dim); }
  pre.snip .c { color: var(--fg-faint); }
  pre.snip .k { color: var(--accent); }

  /* --------------------------------------------------------------- footer */
  footer { border-top: 1px solid var(--line-soft); padding: 44px 0 64px; }
  .foot { display: flex; justify-content: space-between; gap: 22px; flex-wrap: wrap; align-items: flex-start; }
  .foot .note { font-size: 13.5px; color: var(--fg-faint); max-width: 560px; line-height: 1.6; }
  .foot a { color: var(--fg-dim); text-decoration: none; font-size: 14px; }
  .foot a:hover { color: var(--fg); }
</style>
</head>
<body>

<nav>
  <div class="nav-in">
    <div class="brand"><span class="dot"></span>lyp</div>
    <div class="nav-links">
      <a href="#demo">Demo</a>
      <a href="#rules" class="hide-sm">Rules</a>
      <a href="#api" class="hide-sm">API</a>
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
    </div>

    <h1 class="hero">The check that<br>says no.<span class="fade"></span></h1>

    <p class="lede">A read-only risk guardrail between a trading agent and
      <strong>Binance Agent OS</strong>. Propose an action, get back
      <span class="verdict-inline"><span class="vchip a">ALLOW</span><span class="vchip r">ALLOW_REDUCED</span><span class="vchip b">BLOCK</span></span>
      — with every limit the action breaches, and why each one exists.</p>

    <div class="cta">
      <a href="#demo" class="btn primary">Run a live check →</a>
      <a href="https://github.com/0xileri/lyp" class="btn">View source</a>
    </div>
  </header>

  <section id="why">
    <div class="eyebrow">The gap</div>
    <h2 class="sec">The model deciding the trade<br>should not also be approving it.</h2>
    <p class="sec-lede">An autonomous trading agent has a model choosing what to trade and an
      exchange executing it. Between those two there is usually nothing — the model's judgment
      is also the risk check. That holds until it doesn't, and it fails in specific ways.</p>

    <div class="stakes">
      <div class="stake">
        <h3>Nobody owns "how much"</h3>
        <p>The model sizes the position. A model that has been right nine times sizes the tenth
           trade like it will also be right.</p>
      </div>
      <div class="stake">
        <h3>Correlation is invisible per-trade</h3>
        <p>Every individual buy looks diversified. The book is one bet, and you only find out
           when everything moves together.</p>
      </div>
      <div class="stake">
        <h3>Loops don't look like errors</h3>
        <p>An agent placing the same order forty times is placing forty individually valid
           orders. Size never catches it. Frequency does.</p>
      </div>
      <div class="stake">
        <h3>A prompt is not a constraint</h3>
        <p>"Never risk more than 10%" in a system prompt is a suggestion a model can talk
           itself out of, leaving no record of what was violated.</p>
      </div>
    </div>
  </section>

  <section id="demo">
    <div class="eyebrow">Live</div>
    <h2 class="sec">Try it against a real deployment.</h2>
    <p class="sec-lede">Each scenario sends an actual <span class="mono">POST /check</span> to this
      service — the same endpoint an agent calls. Nothing here is canned.</p>

    <div class="demo">
      <div class="panel">
        <div class="panel-head"><span>Proposed action</span></div>
        <div class="panel-body">
          ${SCENARIOS.map(
            (s) => `<button class="scn" data-q="${s.quantity}" data-id="${s.id}">
            <div class="scn-top"><span class="scn-label">${s.label}</span><span class="scn-q">${s.sub}</span></div>
            <div class="scn-note">${s.note}</div>
          </button>`,
          ).join("\n          ")}
          <div class="book">
            <div class="r"><span>equity</span><b>100,000 USDT</b></div>
            <div class="r"><span>exposure</span><b>30,000 USDT · 0.30x</b></div>
            <div class="r"><span>positions</span><b>BTC · SOL · ADA · DOGE</b></div>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head"><span>Verdict</span><span id="lat"></span></div>
        <div class="panel-body" id="out">
          <div class="empty">
            <div class="glyph">{ }</div>
            <div>Select a scenario to send a live request.</div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <section id="how">
    <div class="eyebrow">Architecture</div>
    <h2 class="sec">One read-only hop.</h2>
    <p class="sec-lede">lyp holds market-data and account-read scope, and nothing else. It wires no
      order tools and refuses to call one even if the endpoint offers it.</p>

    <div class="flow">
      <div class="node">
        <div class="n-name">trading agent</div>
        <div class="n-desc">Decides what to trade, then asks before acting.</div>
      </div>
      <div class="arrow"><span class="lbl">check_action</span><span class="ln"></span><span class="lbl">verdict</span></div>
      <div class="node mid">
        <div class="n-name">lyp</div>
        <div class="n-desc">Deterministic rules engine. Six limits, evaluated in code.</div>
      </div>
      <div class="arrow"><span class="lbl">read-only</span><span class="ln"></span><span class="lbl">balances, marks</span></div>
      <div class="node">
        <div class="n-name">Binance Agent OS</div>
        <div class="n-desc">Balances, positions, open orders, mark prices.</div>
      </div>
    </div>
  </section>

  <section id="rules">
    <div class="eyebrow">The rules</div>
    <h2 class="sec">Six limits. Every breach reported.</h2>
    <p class="sec-lede">Rules collect violations rather than short-circuiting, so one response
      carries every limit an action breaches — not just the first. The verdict is the worst
      outcome across all of them.</p>

    <div class="rules">
      ${RULES.map(
        ([name, measure, protects]) => `<div class="rule">
        <div class="rn">${name}</div><div class="rm">${measure}</div><div class="rp">${protects}</div>
      </div>`,
      ).join("\n      ")}
    </div>
  </section>

  <section id="guarantees">
    <div class="eyebrow">Guarantees</div>
    <h2 class="sec">What holds, regardless.</h2>

    <div class="guards">
      <div class="guard">
        <div class="g-t"><span class="mk">→</span>It cannot trade</div>
        <p>Read-only is enforced twice: an allowlist of the four tools it calls, and a denylist
           refusing any order-shaped tool name, checked before every call.</p>
      </div>
      <div class="guard">
        <div class="g-t"><span class="mk">→</span>The model never decides</div>
        <p>Verdicts come from a pure function with no I/O and no clock. The narration you see is
           written after the verdict is final, from a frozen copy of it.</p>
      </div>
      <div class="guard">
        <div class="g-t"><span class="mk">→</span>It fails closed</div>
        <p>Stale account state, a missing mark price, or an unreachable exchange all produce
           BLOCK with a reason — never a guess, and never silence.</p>
      </div>
      <div class="guard">
        <div class="g-t"><span class="mk">→</span>It improves, never traps</div>
        <p>An action that moves a breached limit back toward compliance is reported and allowed.
           Blocking the trade that fixes the problem is worse than the problem.</p>
      </div>
    </div>
  </section>

  <section id="api">
    <div class="eyebrow">Interface</div>
    <h2 class="sec">MCP, or plain HTTP.</h2>

    <div class="eps">
      <div class="ep"><code>POST /mcp</code><span>MCP server — <span class="mono">check_action</span> and <span class="mono">account_risk</span>, both read-only.</span></div>
      <div class="ep"><code>POST /check</code><span>The same evaluation over REST, for callers that are not MCP clients.</span></div>
      <div class="ep"><code>GET&nbsp; /health</code><span>Status, provider mode, narration state, declared exchange scope.</span></div>
    </div>

<pre class="snip"><span class="c"># every threshold is overridable per request, so a caller can run stricter limits</span>
curl -X POST https://lyp-production.up.railway.app<span class="k">/check</span> \\
  -H <span class="k">'content-type: application/json'</span> \\
  -d <span class="k">'{"action":{"symbol":"ETHUSDT","side":"BUY","quantity":5,"orderType":"MARKET"},
       "thresholds":{"positionSize":{"soft":0.05}}}'</span></pre>
  </section>

</div>

<footer>
  <div class="shell">
    <div class="foot">
      <p class="note">Running against fixture state — the Agent OS endpoint is not wired yet, and
        <span class="mono">/health</span> says so rather than passing canned data off as a live
        book. The rules engine is identical either way.</p>
      <a href="https://github.com/0xileri/lyp">github.com/0xileri/lyp ↗</a>
    </div>
  </div>
</footer>

<script>
  const out = document.getElementById("out");
  const lat = document.getElementById("lat");
  const buttons = [...document.querySelectorAll(".scn")];

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const fmt = (n) => Math.abs(n) < 10
    ? Number(n).toFixed(4).replace(/0+$/, "").replace(/\\.$/, "")
    : Math.round(n).toLocaleString("en-US");

  async function run(btn) {
    const quantity = Number(btn.dataset.q);
    buttons.forEach((b) => { b.disabled = true; b.classList.toggle("active", b === btn); });
    lat.textContent = "";
    out.innerHTML = '<div class="empty"><div class="glyph">···</div><div>Evaluating…</div></div>';

    const t0 = performance.now();
    try {
      const res = await fetch("/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: { symbol: "ETHUSDT", side: "BUY", quantity, orderType: "MARKET" },
          actor: "landing-page",
        }),
      });
      const ms = Math.round(performance.now() - t0);
      const data = await res.json();
      lat.textContent = ms + "ms";
      render(data, quantity);
    } catch (err) {
      out.innerHTML = '<div class="empty"><div class="glyph">!</div><div>Request failed: '
        + esc(err.message) + "</div></div>";
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  }

  function render(r, quantity) {
    const snap = r.accountSnapshot || {};
    let h = '<div class="fadein">';

    h += '<div class="vhead"><span class="vbig ' + esc(r.verdict) + '">' + esc(r.verdict) + "</span>";
    if (r.suggestedQuantity) {
      h += '<span class="vsuggest">trade ' + esc(fmt(r.suggestedQuantity)) +
           " ETH instead of " + esc(quantity) + "</span>";
    }
    h += "</div>";

    h += '<div class="vmeta">equity ' + esc(fmt(snap.equity || 0)) + " USDT · exposure " +
         esc(fmt(snap.totalNotional || 0)) + " USDT · " + esc(snap.positionCount || 0) +
         " positions</div>";

    if (!r.violations || r.violations.length === 0) {
      h += '<div class="viol warn"><div class="viol-top"><span class="sev warn">CLEAR</span>' +
           '<span class="viol-rule">no limits breached</span></div>' +
           '<div class="viol-why">Every rule was evaluated and none objected.</div></div>';
    } else {
      for (const v of r.violations) {
        h += '<div class="viol ' + esc(v.severity) + '">' +
             '<div class="viol-top"><span class="sev ' + esc(v.severity) + '">' +
             esc(v.severity.toUpperCase()) + '</span><span class="viol-rule">' + esc(v.rule) +
             '</span><span class="viol-num">' + esc(fmt(v.actual)) + " vs " +
             esc(fmt(v.threshold)) + "</span></div>" +
             '<div class="viol-why">' + esc(v.explanation) + "</div></div>";
      }
    }

    if (r.narration) {
      h += '<div class="narr"><div class="narr-tag">Narration · written after the verdict, ' +
           'never part of it</div><p>' + esc(r.narration) + "</p></div>";
    }
    h += "</div>";
    out.innerHTML = h;
  }

  buttons.forEach((b) => b.addEventListener("click", () => run(b)));
</script>
</body>
</html>`;
}
