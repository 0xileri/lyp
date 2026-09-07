import Anthropic from "@anthropic-ai/sdk";
import { NARRATION } from "./config.js";

/**
 * Optional plain-language narration of a finished verdict.
 *
 * Scope, stated once so it cannot drift: the model is handed a completed,
 * validated verdict object and writes one paragraph about it. It does not
 * compute a verdict, set or read a threshold, or influence a suggested
 * quantity. Remove this file entirely and the service still returns correct
 * verdicts -- `test/narration.test.js` asserts exactly that.
 *
 * Downstream callers should treat `narration` as display text. It is model
 * output, and an agent that parsed it for a decision would be reintroducing
 * the non-determinism this whole service exists to remove.
 */

const SYSTEM_PROMPT = [
  "You explain risk decisions that have already been made by a deterministic rules engine.",
  "",
  "You will receive a finished verdict object and the action it judged.",
  "Write one paragraph, 2-4 sentences, in plain language, for a trader reading a rejection.",
  "",
  "Rules:",
  "- Never contradict, soften, or second-guess the verdict. It is final.",
  "- Never introduce numbers that are not in the object you were given.",
  "- Never suggest a different quantity, threshold, or course of action.",
  "- Lead with what happened and why, not with a restatement of the request.",
  "- No preamble, no bullet points, no markdown. Just the paragraph.",
].join("\n");

export class Narrator {
  constructor({ apiKey = process.env.ANTHROPIC_API_KEY, model = NARRATION.model, timeoutMs = NARRATION.timeoutMs } = {}) {
    if (!apiKey) throw new Error("Narrator requires an API key; construct it only when one is configured");
    this.client = new Anthropic({ apiKey });
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  /**
   * @param {object} verdict a frozen, already-validated response object
   * @param {object} action  the proposed action it judged
   * @returns {Promise<string>} one paragraph
   */
  async narrate(verdict, action) {
    const message = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              "Proposed action:",
              JSON.stringify(action, null, 2),
              "",
              "Verdict reached by the rules engine:",
              JSON.stringify(
                {
                  verdict: verdict.verdict,
                  suggestedQuantity: verdict.suggestedQuantity,
                  violations: verdict.violations,
                  accountSnapshot: verdict.accountSnapshot,
                },
                null,
                2,
              ),
            ].join("\n"),
          },
        ],
      },
      // Both a request timeout and no retries: narration must never be the
      // reason a verdict is slow to return.
      { timeout: this.timeoutMs, maxRetries: 0 },
    );

    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();

    if (!text) throw new Error("narrator returned no text");
    return text;
  }
}

/** A Narrator when one is configured, otherwise null. Never throws. */
export function createNarrator() {
  if (!NARRATION.enabled) return null;
  try {
    return new Narrator();
  } catch {
    return null;
  }
}
