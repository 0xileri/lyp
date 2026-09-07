/**
 * The page served at GET /.
 *
 * An API with no root route answers a browser with "Cannot GET /", which reads
 * as a broken deployment to anyone who has not seen the README. This page
 * exists so the URL is self-explanatory: what the service is, what it refuses
 * to do, and a way to get a real verdict out of it without reaching for curl.
 *
 * It calls the same POST /check endpoint an agent would. No separate demo path,
 * so nothing here can drift from what the service actually does.
 */

const SCENARIOS = {
  clean: { label: "Clean buy", quantity: 2, note: "6% of equity into a diversified book" },
  reduced: { label: "Oversized", quantity: 5, note: "15% of equity, over the 10% soft limit" },
  blocked: { label: "Way oversized", quantity: 12, note: "36% of equity, past the 25% hard ceiling" },
};

export function landingPage({ narrationEnabled, provider }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>lyp — risk guardrail for Binance Agent OS</title>
<style>
  :root {
    --bg: #fbfaf8; --fg: #1a1a19; --muted: #6b6b66; --line: #e2e0db;
    --card: #ffffff; --accent: #2f6f4f; --warn: #8a6416; --block: #9b3226;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #16161a; --fg: #e8e6e1; --muted: #9a978f; --line: #2c2c33;
      --card: #1d1d22; --accent: #6cc08b; --warn: #d9a84a; --block: #e0705f;
    }
  }
  :root[data-theme="dark"] {
    --bg: #16161a; --fg: #e8e6e1; --muted: #9a978f; --line: #2c2c33;
    --card: #1d1d22; --accent: #6cc08b; --warn: #d9a84a; --block: #e0705f;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 760px; margin: 0 auto; padding: 56px 24px 80px; }
  h1 { font-size: 34px; letter-spacing: -0.02em; margin: 0 0 6px; font-weight: 600; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em;
       color: var(--muted); margin: 44px 0 14px; font-weight: 600; }
  p { margin: 0 0 14px; }
  .lede { font-size: 17px; color: var(--fg); margin-bottom: 18px; }
  .muted { color: var(--muted); }
  code, pre, .mono { font-family: var(--mono); font-size: 13px; }
  a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }

  .tags { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 26px; }
  .tag { font-family: var(--mono); font-size: 11.5px; padding: 3px 9px;
         border: 1px solid var(--line); border-radius: 999px; color: var(--muted); }
  .tag.on { color: var(--accent); border-color: currentColor; }

  pre.flow { background: var(--card); border: 1px solid var(--line); border-radius: 8px;
             padding: 16px; overflow-x: auto; margin: 0 0 8px; line-height: 1.5; }

  .row { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
  button { font: inherit; font-size: 13.5px; padding: 8px 14px; cursor: pointer;
           background: var(--card); color: var(--fg);
           border: 1px solid var(--line); border-radius: 7px; }
  button:hover:not(:disabled) { border-color: var(--muted); }
  button:disabled { opacity: 0.5; cursor: default; }

  .out { background: var(--card); border: 1px solid var(--line); border-radius: 8px;
         padding: 18px; min-height: 76px; }
  .verdict { font-family: var(--mono); font-size: 19px; font-weight: 600; letter-spacing: -0.01em; }
  .ALLOW { color: var(--accent); } .ALLOW_REDUCED { color: var(--warn); } .BLOCK { color: var(--block); }
  .v { border-top: 1px solid var(--line); padding-top: 11px; margin-top: 13px; }
  .v-head { font-family: var(--mono); font-size: 12px; margin-bottom: 4px; }
  .sev-block { color: var(--block); } .sev-reduce { color: var(--warn); } .sev-warn { color: var(--muted); }
  .narr { margin-top: 14px; padding-top: 13px; border-top: 1px dashed var(--line);
          color: var(--muted); font-size: 14px; font-style: italic; }

  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  td, th { text-align: left; padding: 7px 10px 7px 0; border-bottom: 1px solid var(--line);
           vertical-align: top; }
  th { color: var(--muted); font-weight: 600; font-size: 12px;
       text-transform: uppercase; letter-spacing: 0.06em; }
  footer { margin-top: 52px; padding-top: 20px; border-top: 1px solid var(--line);
           color: var(--muted); font-size: 13.5px; }
</style>
</head>
<body>
<div class="wrap">

  <h1>lyp</h1>
  <p class="lede">A read-only risk guardrail for Binance Agent OS. It sits between a trading
  agent and the exchange: propose an action, get back <strong>ALLOW</strong>,
  <strong>ALLOW_REDUCED</strong> or <strong>BLOCK</strong>, with every limit the action
  breaches and why each one exists.</p>

  <div class="tags">
    <span class="tag on">read-only — never places trades</span>
    <span class="tag">provider: ${provider}</span>
    <span class="tag">narration: ${narrationEnabled ? "on" : "off"}</span>
  </div>

  <pre class="flow">  trading agent  ──check_action──▶  lyp  ──read-only──▶  Binance Agent OS
                 ◀──── verdict ───       ◀── balances, positions, marks</pre>
  <p class="muted mono">Verdicts come from a deterministic rules engine. No model is involved in reaching one.</p>

  <h2>Try it</h2>
  <p class="muted">Each button sends a real request to <code>POST /check</code> — the same
  endpoint an agent calls. The book is fixture state: 100,000 USDT equity, 30,000 USDT
  exposure across BTC, SOL, ADA and DOGE.</p>
  <div class="row">
    ${Object.entries(SCENARIOS)
      .map(
        ([k, s]) =>
          `<button data-q="${s.quantity}" title="${s.note}">${s.label} — BUY ${s.quantity} ETH</button>`,
      )
      .join("\n    ")}
  </div>
  <div class="out" id="out"><span class="muted">Pick a scenario above.</span></div>

  <h2>Endpoints</h2>
  <table>
    <tr><th>Route</th><th>Purpose</th></tr>
    <tr><td class="mono">POST /mcp</td><td>MCP server — <code>check_action</code>, <code>account_risk</code>. Both read-only.</td></tr>
    <tr><td class="mono">POST /check</td><td>The same evaluation over plain REST.</td></tr>
    <tr><td class="mono">GET&nbsp;&nbsp;/health</td><td>Status, provider mode, narration state.</td></tr>
  </table>

  <h2>The rules</h2>
  <table>
    <tr><th>Rule</th><th>Protects against</th></tr>
    <tr><td class="mono">position_size</td><td>One bad call ending the account.</td></tr>
    <tr><td class="mono">total_exposure</td><td>Leverage accumulating across reasonable-looking positions.</td></tr>
    <tr><td class="mono">concentration</td><td>A book diversified by count but not by size.</td></tr>
    <tr><td class="mono">correlation</td><td>Correlated names counted as one position, not five.</td></tr>
    <tr><td class="mono">liquidation_distance</td><td>Positions that survive on paper, not through a real candle.</td></tr>
    <tr><td class="mono">activity_rate</td><td>A looping or malfunctioning agent.</td></tr>
  </table>

  <footer>
    Running on fixture state — the Agent OS endpoint is not wired yet, and
    <code>/health</code> says so rather than passing canned data off as a live book.
    The rules engine is identical either way.
    <br><br>
    <a href="https://github.com/0xileri/lyp">github.com/0xileri/lyp</a>
  </footer>
</div>

<script>
  const out = document.getElementById("out");
  const buttons = [...document.querySelectorAll("button[data-q]")];

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  async function run(quantity) {
    buttons.forEach((b) => (b.disabled = true));
    out.innerHTML = '<span class="muted">Checking…</span>';
    try {
      const res = await fetch("/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: { symbol: "ETHUSDT", side: "BUY", quantity, orderType: "MARKET" },
          actor: "landing-page",
        }),
      });
      render(await res.json(), quantity);
    } catch (err) {
      out.innerHTML = '<span class="muted">Request failed: ' + esc(err.message) + "</span>";
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  }

  function render(r, quantity) {
    let html = '<div class="verdict ' + esc(r.verdict) + '">' + esc(r.verdict);
    if (r.suggestedQuantity) {
      html += ' <span class="muted" style="font-size:14px;font-weight:400">' +
        "— trade " + esc(Number(r.suggestedQuantity).toFixed(4)) + " ETH instead of " +
        esc(quantity) + "</span>";
    }
    html += "</div>";

    if (!r.violations || r.violations.length === 0) {
      html += '<div class="v muted">No limits breached.</div>';
    } else {
      for (const v of r.violations) {
        html += '<div class="v"><div class="v-head sev-' + esc(v.severity) + '">[' +
          esc(v.severity.toUpperCase()) + "] " + esc(v.rule) + "</div>" +
          '<div class="muted" style="font-size:13.5px">' + esc(v.explanation) + "</div></div>";
      }
    }
    if (r.narration) html += '<div class="narr">' + esc(r.narration) + "</div>";
    out.innerHTML = html;
  }

  buttons.forEach((b) => b.addEventListener("click", () => run(Number(b.dataset.q))));
</script>
</body>
</html>`;
}
