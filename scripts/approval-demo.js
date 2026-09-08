/**
 * The approval demo, as one command.
 *
 * Asks the guardrail for a size it will not fully permit, then tries to spend the
 * resulting approval four ways: the size originally wanted, a different symbol, the
 * size actually approved, and a replay. Only the third succeeds.
 *
 * Runs against the live deployment by default; point LYP_URL elsewhere to use your own.
 *
 *   node scripts/approval-demo.js
 */

const BASE = process.env.LYP_URL ?? "https://lyp.up.railway.app";

// Colour only when writing to a real terminal. Piped or redirected output
// stays plain, so escape codes never end up pasted into an issue or a doc.
const TTY = process.stdout.isTTY && !process.env.NO_COLOR;
const esc = (code) => (TTY ? code : "");

const DIM = esc("[2m");
const BOLD = esc("[1m");
const GREEN = esc("[32m");
const RED = esc("[31m");
const YELLOW = esc("[33m");
const RESET = esc("[0m");

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const order = (over = {}) => ({
  symbol: "ETHUSDT",
  side: "BUY",
  quantity: 5,
  orderType: "MARKET",
  ...over,
});

async function main() {
  console.log(`${BOLD}Signed approvals${RESET} ${DIM}· ${BASE}${RESET}\n`);

  console.log(`${DIM}The agent asks to buy 5 ETH.${RESET}`);
  const checked = await post("/check", { action: order(), actor: "approval-demo" });
  const { verdict, suggestedQuantity, approval } = checked.body;

  if (!approval) {
    console.log(`${RED}${verdict}${RESET} — no approval was minted. Nothing to demonstrate.`);
    return;
  }

  console.log(
    `  verdict   ${YELLOW}${verdict}${RESET}\n` +
      `  asked for ${BOLD}5${RESET} ETH\n` +
      `  approved  ${BOLD}${suggestedQuantity ?? 5}${RESET} ETH\n` +
      `  expires   ${approval.expiresAt}\n` +
      `  token     ${DIM}${approval.token.slice(0, 48)}…${RESET}\n`,
  );

  const approved = approval.maxQuantity;

  const attempts = [
    ["the 5 it originally wanted", order({ quantity: 5 })],
    ["a different symbol", order({ symbol: "BTCUSDT", quantity: 1 })],
    ["the size actually approved", order({ quantity: Number(approved.toFixed(4)) })],
    ["the same approval again", order({ quantity: Number(approved.toFixed(4)) })],
  ];

  console.log(`${DIM}Spending that approval four ways:${RESET}\n`);
  for (const [label, attempt] of attempts) {
    const res = await post("/verify", { approval: approval.token, order: attempt });
    const ok = res.status === 200;
    console.log(
      `  ${ok ? GREEN + "AUTHORIZED  " : RED + "REFUSED     "}${RESET}` +
        `${label.padEnd(30)} ${DIM}${res.status} ${res.body.code ?? ""}${RESET}`,
    );
  }

  console.log(
    `\n${DIM}The approval commits to one symbol, one side, and a maximum size,` +
      `\nand it is redeemable once. A BLOCK mints no approval at all.${RESET}`,
  );
}

main().catch((err) => {
  console.error(`${RED}demo failed:${RESET} ${err.message}`);
  process.exit(1);
});
