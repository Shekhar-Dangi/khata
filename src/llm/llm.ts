// The ONE place this codebase talks to a model.
//
// It is a local model — Ollama on loopback — and that is the design, not a deployment
// detail: bank narrations do not leave the machine. There is no cloud fallback and there
// must never be one: the privacy constraint IS the design.
//
// Everything here follows from measurements on this hardware (2026-08-30, qwen3:4b):
//
//  1. THE OUTPUT SCHEMA IS THE LATENCY CONTROL. A free-text field in the schema let the
//     model spend 501 SECONDS reasoning inside it. `think:false` does not stop a reasoning
//     model reasoning — it relocates the reasoning into whatever unconstrained string you
//     offer. So: an enum, nothing else, and `num_predict` capped as the backstop.
//
//  2. THE ENUM IS A MECHANICAL GUARANTEE, not a request. Grammar-constrained decoding
//     gives an out-of-list category ZERO probability of being emitted, so the model
//     cannot invent a category. We still validate the answer, because a truncated
//     generation is a different failure from an invented one.
//
//  3. PREFIX FIRST, VARIABLE LAST. The instruction block and the category list are
//     byte-identical across a batch, so the runtime replays them from cache: ~40 tok/s
//     cold prefill becomes ~460. Reordering these costs ~4x per row.

import { createHash } from "node:crypto";

import { CATEGORY_LLM, ollamaRequestBase } from "./config.ts";
import { diagnoseOllamaRefusal } from "./ollama.ts";

// The model, host, timeout, thinking flag and every Ollama option come from the CATEGORY_LLM_*
// settings (src/llm-config.ts), falling back to the shared OLLAMA_MODEL / OLLAMA_HOST. They were
// constants here, correct for the machine this was written on and for no other. The defaults are
// exactly what this file always sent, so nothing changes for anyone who sets nothing.
export const LLM_MODEL = CATEGORY_LLM.model;
// v2 (2026-09-05): the merchant line said "Merchxant" — a typo, on every call this feature
// ever made. It is part of the memo key precisely so a prompt change cannot serve answers
// produced by the old one; bumping it discards every cached answer that saw the misspelling.
export const PROMPT_VERSION = "v2";

/** The answer that means "I don't know", which is a CORRECT and useful answer here. */
export const UNKNOWN = "Unknown";

// Cache by input hash.
//
// A model is not a function — `temperature: 0` narrows the output but does not make it
// bit-identical. Memoising on (model, prompt version, merchant, label set) is what makes
// the pipeline deterministic AT THE APPLICATION LAYER: ask twice, get the same answer,
// because the second answer comes from here. It also makes a re-run free.
//
// In-process and unbounded-until-restart, which is right for a batch of 25 rows on a
// single-user local tool. A persistent `suggestions` table is the upgrade, and it buys
// one thing this does not: a record of what the user REJECTED.
const cache = new Map<string, string>();

function key(merchant: string, labels: string[]): string {
  // Every setting that can change the ANSWER is part of the key — with settings in .env, a
  // change of model, temperature or thinking would otherwise serve answers from before it.
  const { model, think, temperature, numCtx, numPredict, extraOptions } = CATEGORY_LLM;
  const settings = JSON.stringify({ think, temperature, numCtx, numPredict, extraOptions });
  return createHash("sha256")
    .update([model, PROMPT_VERSION, settings, merchant, labels.length, labels.join("|")].join("\u0000"))
    .digest("hex");
}

/** Byte-identical across every call in a batch — that is what keeps it cached. */
function buildPrefix(labels: string[]): string {
  return (
    "You categorise Indian bank transactions. Choose exactly one category.\n\nCategories:\n" +
    labels.map((l) => "- " + l).join("\n") +
    "\n\nThe text is a merchant fragment taken from a UPI narration. Choose " + UNKNOWN +
    "\nwhen you do not recognise the merchant — " + UNKNOWN + " is a correct answer and is\n" +
    "better than a guess.\n\n"
  );
}

export class LlmUnavailable extends Error {}

async function ask(merchant: string, labels: string[], prefix: string): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CATEGORY_LLM.timeoutMs);
  try {
    const res = await fetch(CATEGORY_LLM.host + "/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        // model, think, temperature, num_predict (40) and anything in CATEGORY_LLM_OPTIONS.
        //
        // `think` DEFAULTS TO FALSE, and that default is KEPT on measurement rather than on the
        // original reasoning. It was here because qwen3 would not stop reasoning. That is not
        // why it stays: the `format` grammar below forces the first token to be `{`, so a
        // reasoning preamble has nowhere to go either way, and both modes answer in 7-9 tokens
        // on gemma4:26b. The flag costs nothing and buys nothing in TIME.
        //
        // It stays because of the ANSWERS. A/B over 10 merchants (2026-09-05, gemma4:26b,
        // this prompt): 8 identical, and both that differed were worse with reasoning on —
        // BLINKIT went Groceries -> Food delivery, MYGATE went Rent -> Unknown. Ten merchants
        // is a smell rather than a verdict, so re-measure before trusting it further; it is
        // recorded here so the next person knows it was measured and not assumed.
        //
        // Turning it on (CATEGORY_LLM_THINK=true) also needs CATEGORY_LLM_NUM_PREDICT raised:
        // 40 tokens is enough for `{"category": "..."}` and nowhere near enough for a
        // reasoning preamble, which would be cut off and read as Unknown.
        ...ollamaRequestBase(CATEGORY_LLM),
        prompt: prefix + 'Merchant: "' + merchant + '"\n',
        format: {
          type: "object",
          properties: { category: { type: "string", enum: labels } },
          required: ["category"],
        },
      }),
      signal: ctl.signal,
    });
    if (!res.ok) {
      // Ollama's body says WHY, and the 503 this becomes is shown to a person as-is: "the model
      // is not pulled — run ollama pull X" is actionable where "answered 404" is not. Same
      // reading as the receipt path, from the one shared function.
      const body = (await res.text().catch(() => "")).slice(0, 300);
      throw new LlmUnavailable(diagnoseOllamaRefusal(res.status, body, CATEGORY_LLM).message);
    }
    const out = (await res.json()) as { response?: unknown };
    if (typeof out.response !== "string") throw new LlmUnavailable("malformed model response");

    // Model output is UNTRUSTED INPUT, the same class as req.body. The grammar makes an
    // invalid category unrepresentable, not impossible to receive — an aborted generation
    // truncates the JSON mid-string.
    let parsed: { category?: unknown };
    try {
      parsed = JSON.parse(out.response);
    } catch {
      return UNKNOWN;
    }
    const category = parsed.category;
    if (typeof category !== "string" || !labels.includes(category)) return UNKNOWN;
    return category;
  } catch (err) {
    if (err instanceof LlmUnavailable) throw err;
    if (ctl.signal.aborted) {
      throw new LlmUnavailable(
        `the local model took longer than ${Math.round(CATEGORY_LLM.timeoutMs / 1000)}s — ` +
          "raise CATEGORY_LLM_TIMEOUT_MS on a slow machine",
      );
    }
    // A refused connection is the ordinary case: Ollama is not running. Say so plainly
    // rather than surfacing a 500 with a fetch stack trace.
    throw new LlmUnavailable(
      "could not reach the local model at " + CATEGORY_LLM.host + " — is Ollama running?",
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Classify merchant fragments against a CLOSED list of category labels.
 *
 * Returns a label per input id, omitting anything the model did not recognise — an
 * Unknown is not a suggestion and has nothing to show. Sequential on purpose: the model
 * serves one request at a time on this hardware, so concurrency would only queue inside
 * Ollama while making the failure modes harder to reason about.
 */
export async function suggestCategories(
  items: { id: string; merchant: string }[],
  labels: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (items.length === 0 || labels.length === 0) return out;

  const withUnknown = labels.includes(UNKNOWN) ? labels : [...labels, UNKNOWN];
  const prefix = buildPrefix(withUnknown);

  for (const item of items) {
    // An empty hint means the narration was nothing but payment rail. There is no
    // question to ask, and asking it anyway would spend 2s to be told Unknown.
    if (item.merchant.trim() === "") continue;

    const cacheKey = key(item.merchant, withUnknown);
    let answer = cache.get(cacheKey);
    if (answer === undefined) {
      answer = await ask(item.merchant, withUnknown, prefix);
      cache.set(cacheKey, answer);
    }
    if (answer !== UNKNOWN) out.set(item.id, answer);
  }
  return out;
}
