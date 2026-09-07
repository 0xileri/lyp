#!/usr/bin/env node
/**
 * Four canned scenarios, run in order against fixture state.
 *
 *   1. a clean action, allowed
 *   2. an oversized position, reduced
 *   3. a buy into an already-dominant correlation cluster, blocked
 *   4. new risk added while a position sits near liquidation, blocked
 *
 * No network calls and no exchange connection. Narration is included only if
 * ANTHROPIC_API_KEY happens to be set; the verdicts are identical either way,
 * which is the point worth watching for.
 *
 *   npm run demo
 */

import { Guardrail } from "../src/guardrail.js";
import { AccountStateService, FixtureProvider } from "../src/agentos/account.js";
import { createNarrator } from "../src/narration.js";
import { clusterOf } from "../src/engine/clusters.js";
import { DIVERSIFIED, CLUSTER_HEAVY, LEVERED_NEAR_LIQ } from "../fixtures/accounts.js";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const ESC = String.fromCharCode(27);
const c = (code, s) => (useColor ? `${ESC}[${code}m${s}${ESC}[0m` : s);
const bold = (s) => c("1", s);
const dim = (s) => c("2", s);
const green = (s) => c("32", s);
const yellow = (s) => c("33", s);
const red = (s) => c("31", s);
const cyan = (s) => c("36", s);

const VERDICT_STYLE = {
  ALLOW: green,
  ALLOW_REDUCED: yellow,
  BLOCK: red,
};

const SCENARIOS = [
  {
    title: "Clean allow",
    premise: "A modest buy into a diversified book. Nothing to object to.",
    fixture: DIVERSIFIED,
    action: { symbol: "ETHUSDT", side: "BUY", quantity: 2, orderType: "MARKET" },
  },
  {
    title: "Oversized position, reduced",
    premise: "The same book, but the agent asks for 2.5x the size limit on a single name.",
    fixture: DIVERSIFIED,
    action: { symbol: "ETHUSDT", side: "BUY", quantity: 5, orderType: "MARKET" },
  },
  {
    title: "Correlated cluster, blocked",
    premise:
      "A tiny ETH buy -- 3% of equity, 7% of the book. Every single-symbol rule passes. " +
      "But 86% of this book is already BTC, and BTC and ETH are one position in a drawdown.",
    fixture: CLUSTER_HEAVY,
    action: { symbol: "ETHUSDT", side: "BUY", quantity: 1, orderType: "MARKET" },
  },
  {
    title: "Liquidation proximity, blocked",
    premise:
      "An unremarkable buy on a lightly-loaded book -- except a 10x SOL position is sitting " +
      "8% from liquidation. No new risk goes on while that is true.",
    fixture: LEVERED_NEAR_LIQ,
    action: { symbol: "ETHUSDT", side: "BUY", quantity: 1, orderType: "MARKET" },
  },
];

const money = (x) => Math.round(x).toLocaleString("en-US");
const pct = (x) => `${(x * 100).toFixed(1)}%`;

function printBook(fixture) {
  const total = fixture.positions.reduce((s, p) => s + p.quantity * fixture.markPrices[p.symbol], 0);
  console.log(
    dim(
      `  book   ${money(fixture.equity)} USDT equity, ${money(total)} USDT exposure ` +
        `(${(total / fixture.equity).toFixed(2)}x)`,
    ),
  );
  for (const p of fixture.positions) {
    const notional = p.quantity * fixture.markPrices[p.symbol];
    const tags = [clusterOf(p.symbol), p.leverage > 1 ? `${p.leverage}x` : null].filter(Boolean).join(", ");
    console.log(
      dim(
        `         ${p.symbol.padEnd(9)} ${String(p.quantity).padStart(8)} ` +
          `= ${money(notional).padStart(7)} USDT  ${tags ? `[${tags}]` : ""}` +
          (p.liquidationPrice ? dim(`  liq ${p.liquidationPrice}`) : ""),
      ),
    );
  }
}

function printVerdict(result) {
  const style = VERDICT_STYLE[result.verdict] ?? ((s) => s);
  const suffix =
    result.verdict === "ALLOW_REDUCED" ? `  ->  trade ${round(result.suggestedQuantity)} instead` : "";

  console.log(`  ${bold(style(result.verdict))}${suffix}`);

  if (result.violations.length === 0) {
    console.log(dim("         no limits breached"));
  }
  for (const v of result.violations) {
    const tag = v.severity === "block" ? red("BLOCK ") : v.severity === "reduce" ? yellow("REDUCE") : dim("WARN  ");
    console.log(`         ${tag} ${bold(v.rule)}`);
    console.log(dim(`                ${wrap(v.explanation, 78, 16)}`));
    console.log(
      dim(`                measured ${fmt(v.actual)} against limit ${fmt(v.threshold)}`),
    );
  }
  if (result.narration) {
    console.log();
    console.log(cyan(`         ${wrap(result.narration, 78, 9)}`));
  }
}

const round = (x) => Number(x.toFixed(8));
const fmt = (x) => (Math.abs(x) < 10 ? x.toFixed(4).replace(/0+$/, "").replace(/\.$/, "") : String(Math.round(x)));

/** Naive greedy wrap; the text here is short and plain. */
function wrap(text, width, indent) {
  const pad = " ".repeat(indent);
  const words = text.split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    if (line.length + w.length + 1 > width) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines.join(`\n${pad}`);
}

async function main() {
  const narrator = createNarrator();

  console.log();
  console.log(bold("  Risk guardrail demo"));
  console.log(
    dim(
      `  fixture state, no exchange connection. narration ${narrator ? "on" : "off"}` +
        `${narrator ? "" : " (set ANTHROPIC_API_KEY to enable)"}.`,
    ),
  );
  console.log(dim("  verdicts below are produced entirely in code, with no model involvement."));

  for (const [i, s] of SCENARIOS.entries()) {
    // A fresh guardrail per scenario: each starts from a clean activity
    // counter, so scenario 4 is not answering for scenario 1's traffic.
    const guardrail = new Guardrail({
      stateService: new AccountStateService(new FixtureProvider({ ...s.fixture, fetchedAt: Date.now() })),
      narrator,
    });

    console.log();
    console.log(bold(`  ${i + 1}. ${s.title}`));
    console.log(dim(`     ${wrap(s.premise, 76, 5)}`));
    console.log();
    printBook(s.fixture);
    console.log(
      `  action ${bold(`${s.action.side} ${s.action.quantity} ${s.action.symbol}`)} ` +
        dim(
          `= ${money(s.action.quantity * s.fixture.markPrices[s.action.symbol])} USDT ` +
            `(${pct((s.action.quantity * s.fixture.markPrices[s.action.symbol]) / s.fixture.equity)} of equity)`,
        ),
    );
    console.log();

    printVerdict(await guardrail.check({ action: s.action, actor: `demo-${i}` }));
  }
  console.log();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
