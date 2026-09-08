import { McpConnection, createTools, DEFAULT_GUARDRAIL_URL } from "./tools.js";

/**
 * The agent loop, with the model removed.
 *
 * `npm run agent` needs an Anthropic key, which means anyone without one cannot
 * see the thing this project is actually about. This runs the identical tool
 * layer against the same live guardrail, driving it through a fixed sequence of
 * proposals instead of a model's choices.
 *
 * Everything here except the choice of what to propose is exactly what the real
 * agent does: same `createTools`, same MCP client, same guardrail, same
 * verdicts. What you lose is the model's reasoning and its freedom to pick
 * different trades. What you keep is the part that matters — that a proposal
 * cannot become a trade without passing the gate.
 */

// Colour only when writing to a real terminal. Piped or redirected output
// stays plain, so escape codes never end up pasted into an issue or a doc.
const TTY = process.stdout.isTTY && !process.env.NO_COLOR;
const esc = (code) => (TTY ? code : "");

const DIM = esc("[2m");
const BOLD = esc("[1m");
const RESET = esc("[0m");
const COLOR = { ALLOW: esc("[32m"), ALLOW_REDUCED: esc("[33m"), BLOCK: esc("[31m") };

/**
 * What a reasonable agent might try on this book, chosen so that between them
 * the verdicts cover allow, reduce and two different blocks.
 */
const SEQUENCE = [
  {
    say: "A modest position. Six percent of equity into ETH.",
    trade: { symbol: "ETHUSDT", side: "BUY", quantity: 2, orderType: "MARKET" },
    reasoning: "Small add, well inside every limit.",
  },
  {
    say: "Bigger — fifteen percent of equity.",
    trade: { symbol: "ETHUSDT", side: "BUY", quantity: 5, orderType: "MARKET" },
    reasoning: "Sizing up on conviction.",
  },
  {
    say: "Much bigger. Thirty-six percent of equity.",
    trade: { symbol: "ETHUSDT", side: "BUY", quantity: 12, orderType: "MARKET" },
    reasoning: "High conviction, large position.",
  },
  {
    say: "Small again, but at twenty times leverage.",
    trade: { symbol: "ETHUSDT", side: "BUY", quantity: 2, orderType: "MARKET", leverage: 20 },
    reasoning: "Small notional, large leverage.",
  },
];

async function main() {
  const guardrail = new McpConnection(process.env.LYP_MCP_URL ?? DEFAULT_GUARDRAIL_URL);
  const tools = createTools({ guardrail });

  console.log(`${BOLD}lyp agent${RESET} ${DIM}· dry run, no model${RESET}`);
  console.log(`${DIM}· guardrail ${guardrail.url}${RESET}`);
  console.log(`${DIM}· no order is placed by this program${RESET}\n`);

  try {
    console.log(`${DIM}  → get_account_risk()${RESET}`);
    const book = await tools.handlers.get_account_risk();
    console.log(
      `    equity ${fmt(book.equity)} USDT · exposure ${fmt(book.totalNotional)} USDT · ` +
        `${book.positionCount} positions\n`,
    );

    console.log(`${DIM}  → get_market_price("ETHUSDT")${RESET}`);
    const price = await tools.handlers.get_market_price({ symbol: "ETHUSDT" });
    console.log(`    ${fmt(price.price)} USDT ${DIM}(${price.source})${RESET}\n`);

    for (const step of SEQUENCE) {
      console.log(`  ${step.say}`);
      console.log(
        `${DIM}  → propose_trade(${step.trade.side} ${step.trade.quantity} ${step.trade.symbol}` +
          `${step.trade.leverage ? ` @${step.trade.leverage}x` : ""})${RESET}`,
      );

      const result = await tools.handlers.propose_trade({ ...step.trade, reasoning: step.reasoning });
      const color = COLOR[result.verdict] ?? "";

      console.log(
        `    ${color}${BOLD}${result.verdict}${RESET}` +
          (result.verdict === "ALLOW_REDUCED"
            ? ` — ${step.trade.quantity} requested, ${trim(result.effectiveQuantity)} permitted`
            : "") +
          `${DIM}   executed=${result.executed}${RESET}`,
      );
      for (const v of result.violations ?? []) {
        console.log(`${DIM}      [${v.severity}] ${v.rule}${RESET}`);
      }
      console.log();
    }

    console.log(`${BOLD}Decision record${RESET}`);
    for (const p of tools.log.proposals) {
      const color = COLOR[p.verdict] ?? "";
      console.log(
        `  ${color}${p.verdict.padEnd(14)}${RESET} ${p.requested.side} ` +
          `${trim(p.effectiveQuantity || p.requested.quantity)} ${p.requested.symbol}` +
          (p.verdict === "ALLOW_REDUCED" ? `${DIM}  (asked for ${p.requested.quantity})${RESET}` : "") +
          (p.verdict === "BLOCK" ? `${DIM}  (nothing traded)${RESET}` : ""),
      );
    }
    console.log(
      `\n${DIM}${tools.log.permitted.length} permitted, ${tools.log.blocked.length} refused, ` +
        `0 executed. Run \`npm run agent\` with an Anthropic key to let a model choose instead.${RESET}`,
    );
  } finally {
    await guardrail.close().catch(() => {});
  }
}

const fmt = (n) =>
  typeof n === "number" ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "n/a";
const trim = (n) => Number(Number(n).toFixed(4));

main().catch((err) => {
  console.error(`dry run failed: ${err.message}`);
  process.exit(1);
});
