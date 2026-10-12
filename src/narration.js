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

/** Strip anything key-shaped before a message reaches a log or a response. */
const redact = (s) =>
  String(s ?? "")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .slice(0, 200);

/**
 * Whether narration is actually working, as opposed to merely configured.
 *
 * This exists because of a real failure that took a month to notice. The
 * Anthropic key stopped being accepted, every verdict came back with
 * `narration: null`, and nothing anywhere said so: the catch in Guardrail
 * swallowed the error without a log line, and /health reported "enabled"
 * because the environment variable was still set. The outage was invisible
 * until someone inferred it from response latency.
 *
 * Silence is the right behaviour for the caller — a model outage must not
 * change a verdict or surface an error to an agent. It is the wrong behaviour
 * for an operator. So the failure is swallowed as before, and recorded here.
 */
class NarrationHealth {
  #attempts = 0;
  #successes = 0;
  #consecutiveFailures = 0;
  #lastSuccessAt = null;
  #lastFailureAt = null;
  #lastError = null;

  recordSuccess(now = Date.now()) {
    this.#attempts += 1;
    this.#successes += 1;
    this.#consecutiveFailures = 0;
    this.#lastSuccessAt = now;
    this.#lastError = null;
  }

  recordFailure(err, now = Date.now()) {
    this.#attempts += 1;
    this.#consecutiveFailures += 1;
    this.#lastFailureAt = now;
    this.#lastError = redact(err?.message ?? err);
  }

  /**
   * "disabled" when no key is configured, "failing" when the last attempt
   * failed, "enabled" otherwise. The distinction between enabled and failing is
   * the whole point: the previous version could only report the former.
   */
  get state() {
    if (!NARRATION.enabled) return "disabled";
    return this.#consecutiveFailures > 0 ? "failing" : "enabled";
  }

  status() {
    return {
      state: this.state,
      model: NARRATION.enabled ? NARRATION.model : null,
      attempts: this.#attempts,
      successes: this.#successes,
      consecutiveFailures: this.#consecutiveFailures,
      lastSuccessAt: this.#lastSuccessAt ? new Date(this.#lastSuccessAt).toISOString() : null,
      lastFailureAt: this.#lastFailureAt ? new Date(this.#lastFailureAt).toISOString() : null,
      lastError: this.#lastError,
    };
  }

  reset() {
    this.#attempts = 0;
    this.#successes = 0;
    this.#consecutiveFailures = 0;
    this.#lastSuccessAt = null;
    this.#lastFailureAt = null;
    this.#lastError = null;
  }
}

export const narrationHealth = new NarrationHealth();

/** A Narrator when one is configured, otherwise null. Never throws. */
export function createNarrator() {
  if (!NARRATION.enabled) return null;
  try {
    return new Narrator();
  } catch {
    return null;
  }
}
