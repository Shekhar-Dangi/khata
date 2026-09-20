import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CHARS_PER_TOKEN,
  PROMPT_OVERHEAD_TOKENS,
  type CategoryLlmConfig,
  type ReceiptLlmConfig,
  ollamaRequestBase,
  parseLlmConfig,
} from "./config.ts";
import { diagnoseOllamaRefusal } from "./ollama.ts";
import { buildRequest, classifyHttpFailure } from "../receipts/model/read.ts";

const parsed = (env: Record<string, string>) => {
  const r = parseLlmConfig(env);
  assert.ok(r.ok, r.ok ? "" : r.errors.join("; "));
  return r;
};
const receipt = (env: Record<string, string>): ReceiptLlmConfig => parsed(env).receipt;
const category = (env: Record<string, string>): CategoryLlmConfig => parsed(env).category;
const errors = (env: Record<string, string>): string[] => {
  const r = parseLlmConfig(env);
  assert.ok(!r.ok, "expected the config to be refused");
  return r.errors;
};

describe("model settings — defaults change nothing for someone who sets nothing", () => {
  it("receipts run on the values measured on the machine they were built on", () => {
    const c = receipt({});
    assert.equal(c.numCtx, 8192);
    assert.equal(c.numPredict, 2048);
    assert.equal(c.timeoutMs, 600_000);
    assert.equal(c.think, false);
    assert.equal(c.temperature, 0);
    assert.equal(c.keepAlive, null);
    assert.deepEqual(c.extraOptions, {});
  });

  it("category suggestions send exactly what llm.ts always sent", () => {
    const c = category({});
    assert.equal(c.numPredict, 40);
    assert.equal(c.timeoutMs, 60_000);
    assert.equal(c.think, false);
    // No window unless one is asked for: sending ANY num_ctx makes Ollama reload a model that is
    // already loaded with a different one.
    assert.equal(c.numCtx, null);
    assert.ok(!("num_ctx" in (ollamaRequestBase(c).options as object)));
  });

  it("treats an empty value as unset, because KEY= is how a .env line is switched off", () => {
    assert.equal(receipt({ RECEIPT_LLM_NUM_CTX: "", RECEIPT_LLM_THINK: "  " }).numCtx, 8192);
  });
});

describe("model settings — which model", () => {
  it("each job prefers its own model", () => {
    const r = parsed({ RECEIPT_LLM_MODEL: "big:70b", CATEGORY_LLM_MODEL: "tiny:1b", OLLAMA_MODEL: "mid:8b" });
    assert.equal(r.receipt.model, "big:70b");
    assert.equal(r.category.model, "tiny:1b");
  });

  it("both fall back to the shared OLLAMA_MODEL, so one model is one variable", () => {
    const r = parsed({ OLLAMA_MODEL: "gemma4:26b" });
    assert.equal(r.receipt.model, "gemma4:26b");
    assert.equal(r.category.model, "gemma4:26b");
  });

  it("falls back to llm.ts's historic default when nothing is set", () => {
    assert.equal(receipt({}).model, "qwen3:4b");
  });
});

describe("model settings — numbers are validated, not coerced", () => {
  // Every one of these survives Number() and means something other than what was typed.
  for (const bad of ["8k", "8192.5", "-1", "1e4", "0x2000", "8 192"]) {
    it(`refuses RECEIPT_LLM_NUM_CTX="${bad}"`, () => {
      assert.ok(errors({ RECEIPT_LLM_NUM_CTX: bad }).some((e) => e.includes("RECEIPT_LLM_NUM_CTX")));
    });
  }

  it("validates the category profile by the same rules, and names ITS variable", () => {
    assert.ok(errors({ CATEGORY_LLM_TIMEOUT_MS: "1m" }).some((e) => e.startsWith("CATEGORY_LLM_TIMEOUT_MS")));
  });

  it("refuses a window smaller than anything could use", () => {
    assert.ok(errors({ RECEIPT_LLM_NUM_CTX: "512" }).some((e) => e.includes("between")));
  });

  it("refuses an output cap that fills the whole window", () => {
    const e = errors({ RECEIPT_LLM_NUM_CTX: "4096", RECEIPT_LLM_NUM_PREDICT: "4096" });
    assert.ok(e.some((x) => x.includes("must be smaller than")), e.join("; "));
  });

  it("refuses a receipt window with no room left for a document", () => {
    // 2048 - 1536 - 300 = 212 tokens, about 600 characters. No real invoice fits.
    const e = errors({ RECEIPT_LLM_NUM_CTX: "2048", RECEIPT_LLM_NUM_PREDICT: "1536" });
    assert.ok(e.some((x) => x.includes("leaves room for only")), e.join("; "));
  });

  it("reports EVERY problem, across BOTH profiles, at once — not one per restart", () => {
    const e = errors({
      RECEIPT_LLM_NUM_CTX: "lots",
      RECEIPT_LLM_THINK: "maybe",
      CATEGORY_LLM_TEMPERATURE: "hot",
      CATEGORY_LLM_KEEP_ALIVE: "forever",
    });
    assert.equal(e.length, 4, e.join("; "));
  });

  it("refuses an OLLAMA_HOST that is not a URL", () => {
    assert.ok(errors({ OLLAMA_HOST: "localhost:11434" }).some((e) => e.includes("OLLAMA_HOST")));
  });
});

describe("model settings — the document budget follows the window", () => {
  it("is ~17,000 characters at the defaults", () => {
    const c = receipt({});
    assert.equal(c.maxMarkdownChars, Math.floor((8192 - 2048 - PROMPT_OVERHEAD_TOKENS) * CHARS_PER_TOKEN));
    assert.ok(c.maxMarkdownChars > 16_000 && c.maxMarkdownChars < 18_000, String(c.maxMarkdownChars));
  });

  it("grows when the window grows, with nothing else to change", () => {
    assert.ok(receipt({ RECEIPT_LLM_NUM_CTX: "32768" }).maxMarkdownChars > 80_000);
  });
});

describe("model settings — thinking", () => {
  it("accepts true/false in the forms people type", () => {
    assert.equal(receipt({ RECEIPT_LLM_THINK: "TRUE" }).think, true);
    assert.equal(receipt({ RECEIPT_LLM_THINK: "0" }).think, false);
  });

  it("accepts the levels some models take instead of a boolean", () => {
    assert.equal(receipt({ RECEIPT_LLM_THINK: "high" }).think, "high");
  });

  it("OMITS the field when unset, for models whose API rejects it", () => {
    assert.ok(!("think" in buildRequest("doc", receipt({ RECEIPT_LLM_THINK: "unset" }))));
    assert.equal(buildRequest("doc", receipt({})).think, false);
    assert.ok(!("think" in ollamaRequestBase(category({ CATEGORY_LLM_THINK: "unset" }))));
  });
});

describe("model settings — other Ollama options", () => {
  it("passes anything Ollama accepts through to the request", () => {
    const c = receipt({ RECEIPT_LLM_OPTIONS: '{"num_thread": 8, "seed": 42, "use_mmap": false}' });
    const opts = buildRequest("doc", c).options as Record<string, unknown>;
    assert.equal(opts.num_thread, 8);
    assert.equal(opts.seed, 42);
    assert.equal(opts.use_mmap, false);
    // The dedicated settings are still there alongside them.
    assert.equal(opts.num_ctx, 8192);
  });

  it("refuses a key that has its own variable, rather than picking a winner silently", () => {
    const e = errors({ CATEGORY_LLM_OPTIONS: '{"num_ctx": 32768}' });
    assert.ok(e.some((x) => x.includes("CATEGORY_LLM_NUM_CTX")), e.join("; "));
  });

  it("refuses JSON that is not an object", () => {
    assert.ok(errors({ RECEIPT_LLM_OPTIONS: "[1,2]" }).length > 0);
    assert.ok(errors({ RECEIPT_LLM_OPTIONS: "{not json" }).length > 0);
  });

  it("sends keep_alive as seconds when bare, and as a duration otherwise", () => {
    assert.equal(buildRequest("doc", receipt({ RECEIPT_LLM_KEEP_ALIVE: "300" })).keep_alive, 300);
    assert.equal(buildRequest("doc", receipt({ RECEIPT_LLM_KEEP_ALIVE: "30m" })).keep_alive, "30m");
    assert.equal(buildRequest("doc", receipt({ RECEIPT_LLM_KEEP_ALIVE: "-1" })).keep_alive, -1);
    assert.ok(!("keep_alive" in buildRequest("doc", receipt({}))));
  });
});

describe("what Ollama's refusals mean", () => {
  const r = receipt({ OLLAMA_MODEL: "gemma4:26b" });
  const c = category({ OLLAMA_MODEL: "gemma4:26b" });

  it("a model that is not pulled is a SETTING, and says how to fix it", () => {
    const f = classifyHttpFailure(404, `{"error":"model 'qwen3:4b' not found"}`, r);
    assert.equal(f.kind, "llm_misconfigured");
    assert.match(f.message, /ollama pull gemma4:26b/);
  });

  it("running out of memory names the window, not the document", () => {
    // The exact shape Ollama sent on the machine this was built on, at num_ctx 16384.
    const body = `{"error":"llama-server startup failed before projector CPU offload retry: llama-server reported out-of-memory during startup"}`;
    const f = classifyHttpFailure(500, body, r);
    assert.equal(f.kind, "llm_misconfigured");
    assert.match(f.message, /RECEIPT_LLM_NUM_CTX/);
  });

  it("names the variable of the job that failed, not the other one", () => {
    const d = diagnoseOllamaRefusal(500, "reported out-of-memory during startup", c);
    assert.ok(d.misconfigured);
    assert.match(d.message, /CATEGORY_LLM_NUM_CTX/);
    // The category job sets no window by default, and the message must not invent one.
    assert.match(d.message, /Ollama's default window/);
  });

  it("a model that rejects the thinking flag points at the THINK variable", () => {
    const f = classifyHttpFailure(400, `{"error":"\\"llama3\\" does not support thinking"}`, r);
    assert.equal(f.kind, "llm_misconfigured");
    assert.match(f.message, /RECEIPT_LLM_THINK=unset/);
  });

  it("anything else stays retryable, with Ollama's own words attached", () => {
    const f = classifyHttpFailure(503, "busy", r);
    assert.equal(f.kind, "llm_unavailable");
    assert.match(f.message, /busy/);
  });
});
