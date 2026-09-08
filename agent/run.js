import Anthropic from "@anthropic-ai/sdk";
import { McpConnection, createTools, RunLog, DEFAULT_GUARDRAIL_URL } from "./tools.js";

/**
 * A trading agent that cannot outrun its own risk limits.
 *
 * The model reads the book, forms a view, and proposes trades. Every proposal
 * goes through the guardrail before it counts, and the guardrail's answer is
 * final — enforced in tools.js rather than requested in the prompt.
 *
 * Nothing here places an order. The agent produces a decision record: what it
 * wanted to do, what it was permitted to do, and why those differ.
 */

const MODEL = process.env.AGENT_MODEL ?? "claude-sonnet-5";
const MAX_TURNS = Number(process.env.AGENT_MAX_TURNS ?? 12);

const SYSTEM_PROMPT = `You are a crypto trading agent operating on Binance Agent OS.

Your job on each run:
1. Call get_account_risk to see the current book before forming any view.
2. Check prices for symbols you are considering.
3. Propose trades with propose_trade, one at a time, each with your reasoning.
4. Finish with a short plain-language summary of what you did and what was refused.

About the guardrail, so that its answers do not surprise you:

- Every proposal is checked against risk limits before it counts. You cannot skip
  this and there is no other way to act.
- BLOCK means the trade does not happen. Accept it and move on. Do not retry the
  same trade at a slightly smaller size hoping to slip under a limit.
- ALLOW_REDUCED means it happens, but only at suggestedQuantity. That is not a
  negotiation, and the reduced size is what gets recorded.
- The violations you get back name the limit and the numbers. Read them. They
  tell you what the book will actually accept, which is more useful than guessing.

You are not being graded on how much you trade. A run that proposes one
well-sized position, or correctly decides to do nothing, is a good run. Sizing
into a limit until something blocks is a bad one.

Be concise. Think in terms of the whole book, not one symbol at a time.`;

/** Anthropic tool-use loop. Returns the run log. */
export async function runAgent({
  instruction,
  guardrailUrl = DEFAULT_GUARDRAIL_URL,
  marketUrl = process.env.AGENT_OS_MCP_URL ?? null,
  marketToken = process.env.AGENT_OS_TOKEN ?? null,
  apiKey = process.env.ANTHROPIC_API_KEY,
  onEvent = () => {},
} = {}) {
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required to run the agent");

  const guardrail = new McpConnection(guardrailUrl, { name: "lyp-agent" });
  const market = marketUrl
    ? new McpConnection(marketUrl, { name: "lyp-agent", token: marketToken })
    : null;

  const log = new RunLog();
  const { definitions, handlers } = createTools({ guardrail, market, log });
  const client = new Anthropic({ apiKey });

  const messages = [{ role: "user", content: instruction }];

  try {
    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        tools: definitions,
        messages,
      });

      for (const block of response.content) {
        if (block.type === "text" && block.text.trim()) onEvent({ type: "say", text: block.text });
      }

      messages.push({ role: "assistant", content: response.content });

      const calls = response.content.filter((b) => b.type === "tool_use");
      if (calls.length === 0) {
        onEvent({ type: "done", reason: response.stop_reason });
        break;
      }

      const results = [];
      for (const call of calls) {
        onEvent({ type: "tool", name: call.name, input: call.input });
        let payload;
        try {
          payload = await handlers[call.name](call.input ?? {});
        } catch (err) {
          // A tool failure is reported to the model rather than crashing the
          // run: the agent should be able to reason about a source it cannot
          // read, which is exactly the situation the guardrail blocks on.
          payload = { error: err.message };
        }
        onEvent({ type: "result", name: call.name, output: payload });
        results.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(payload) });
      }
      messages.push({ role: "user", content: results });
    }
  } finally {
    await guardrail.close().catch(() => {});
    await market?.close().catch(() => {});
  }

  return log;
}

// --------------------------------------------------------------------- CLI

const DIM = "[2m";
const BOLD = "[1m";
const RESET = "[0m";
const COLOR = { ALLOW: "[32m", ALLOW_REDUCED: "[33m", BLOCK: "[31m" };

function render(event) {
  switch (event.type) {
    case "say":
      console.log(`\n${event.text.trim()}\n`);
      break;
    case "tool":
      console.log(`${DIM}  → ${event.name}(${compact(event.input)})${RESET}`);
      break;
    case "result": {
      if (event.name !== "propose_trade") return;
      const v = event.output.verdict;
      console.log(
        `${COLOR[v] ?? ""}${BOLD}    ${v}${RESET}` +
          (event.output.effectiveQuantity ? ` — size ${event.output.effectiveQuantity}` : "") ,
      );
      for (const violation of event.output.violations ?? []) {
        console.log(`${DIM}      [${violation.severity}] ${violation.rule}${RESET}`);
      }
      break;
    }
  }
}

const compact = (obj) =>
  Object.entries(obj ?? {})
    .filter(([k]) => k !== "reasoning")
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join(", ");

if (process.argv[1]?.endsWith("run.js")) {
  const instruction =
    process.argv.slice(2).join(" ") ||
    "Review the book and propose any trades you think are worth making today.";

  console.log(`${BOLD}lyp agent${RESET} ${DIM}· model ${MODEL}${RESET}`);
  console.log(`${DIM}· guardrail ${DEFAULT_GUARDRAIL_URL}${RESET}`);
  console.log(
    `${DIM}· market data ${process.env.AGENT_OS_MCP_URL ? "Binance Agent OS" : "guardrail marks (Agent OS not configured)"}${RESET}`,
  );
  console.log(`${DIM}· no order is placed by this program${RESET}\n`);

  const log = await runAgent({ instruction, onEvent: render });

  console.log(`${BOLD}Decision record${RESET}`);
  if (log.proposals.length === 0) {
    console.log("  no trades proposed");
  }
  for (const p of log.proposals) {
    const c = COLOR[p.verdict] ?? "";
    console.log(
      `  ${c}${p.verdict.padEnd(14)}${RESET} ${p.requested.side} ${p.effectiveQuantity || p.requested.quantity} ${p.requested.symbol}` +
        (p.verdict === "ALLOW_REDUCED" ? `${DIM} (asked for ${p.requested.quantity})${RESET}` : ""),
    );
    console.log(`${DIM}                 ${p.reasoning}${RESET}`);
  }
  console.log(
    `\n${DIM}${log.permitted.length} permitted, ${log.blocked.length} refused. Nothing was executed.${RESET}`,
  );
}
