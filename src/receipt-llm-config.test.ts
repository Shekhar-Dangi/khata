import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CHARS_PER_TOKEN,
  PROMPT_OVERHEAD_TOKENS,
  parseReceiptLlmConfig,
  type ReceiptLlmConfig,
} from "./receipt-llm-config.ts";
import { buildRequest, classifyHttpFailure } from "./receipt-llm.ts";

const ok = (env: Record<string, string>): ReceiptLlmConfig => {
  const r = parseReceiptLlmConfig(env);
  assert.ok(r.ok, r.ok ? "" : r.errors.join("; "));
  return r.config;
};
const errors = (env: Record<string, string>): string[] => {
  const r = parseReceiptLlmConfig(env);
  assert.ok(!r.ok, "expected the config to be refused");
  return r.errors;
};

describe("receipt model settings — defaults", () => {
  it("runs with nothing set, on the values measured on the machine it was built on", () => {
    const c = ok({});
    assert.equal(c.numCtx, 8192);
    assert.equal(c.numPredict, 2048);
    assert.equal(c.timeoutMs, 600_000);
    assert.equal(c.think, false);
    assert.equal(c.temperature, 0);
    assert.equal(c.keepAlive, null);
    assert.deepEqual(c.extraOptions, {});
  });

  it("treats an empty value as unset, because KEY= is how a .env line is switched off", () => {
    assert.equal(ok({ RECEIPT_LLM_NUM_CTX: "", RECEIPT_LLM_THINK: "  " }).numCtx, 8192);
  });
});

describe("receipt model settings — which model", () => {
  it("prefers the receipt-specific model", () => {
    assert.equal(ok({ RECEIPT_LLM_MODEL: "big:70b", OLLAMA_MODEL: "small:4b" }).model, "big:70b");
  });

  it("falls back to the model the rest of the app uses", () => {
    assert.equal(ok({ OLLAMA_MODEL: "gemma4:26b" }).model, "gemma4:26b");
  });

  it("falls back to llm.ts's own default when neither is set", () => {
    assert.equal(ok({}).model, "qwen3:4b");
  });
});

describe("receipt model settings — numbers are validated, not coerced", () => {
  // Every one of these survives Number() and means something other than what was typed.
  for (const bad of ["8k", "8192.5", "-1", "1e4", "0x2000", "8 192"]) {
    it(`refuses RECEIPT_LLM_NUM_CTX="${bad}"`, () => {
      assert.ok(errors({ RECEIPT_LLM_NUM_CTX: bad }).some((e) => e.includes("RECEIPT_LLM_NUM_CTX")));
    });
  }

  it("refuses a window smaller than anything could use", () => {
    assert.ok(errors({ RECEIPT_LLM_NUM_CTX: "512" }).some((e) => e.includes("between")));
  });

  it("refuses an output cap that fills the whole window", () => {
    const e = errors({ RECEIPT_LLM_NUM_CTX: "4096", RECEIPT_LLM_NUM_PREDICT: "4096" });
    assert.ok(e.some((x) => x.includes("must be smaller than")), e.join("; "));
  });

  it("refuses a window with no room left for a document", () => {
    // 2048 - 1536 - 300 = 212 tokens, about 600 characters. No real invoice fits.
    const e = errors({ RECEIPT_LLM_NUM_CTX: "2048", RECEIPT_LLM_NUM_PREDICT: "1536" });
    assert.ok(e.some((x) => x.includes("leaves room for only")), e.join("; "));
  });

  it("reports EVERY problem at once, not one per restart", () => {
    const e = errors({
      RECEIPT_LLM_NUM_CTX: "lots",
      RECEIPT_LLM_TIMEOUT_MS: "soon",
      RECEIPT_LLM_THINK: "maybe",
      RECEIPT_LLM_TEMPERATURE: "hot",
    });
    assert.equal(e.length, 4, e.join("; "));
  });
});

describe("receipt model settings — the document budget follows the window", () => {
  it("is ~17,000 characters at the defaults", () => {
    const c = ok({});
    assert.equal(c.maxMarkdownChars, Math.floor((8192 - 2048 - PROMPT_OVERHEAD_TOKENS) * CHARS_PER_TOKEN));
    assert.ok(c.maxMarkdownChars > 16_000 && c.maxMarkdownChars < 18_000, String(c.maxMarkdownChars));
  });

  it("grows when the window grows, with nothing else to change", () => {
    assert.ok(ok({ RECEIPT_LLM_NUM_CTX: "32768" }).maxMarkdownChars > 80_000);
  });
});

describe("receipt model settings — thinking", () => {
  it("accepts true/false in the forms people type", () => {
    assert.equal(ok({ RECEIPT_LLM_THINK: "TRUE" }).think, true);
    assert.equal(ok({ RECEIPT_LLM_THINK: "0" }).think, false);
  });

  it("accepts the levels some models take instead of a boolean", () => {
    assert.equal(ok({ RECEIPT_LLM_THINK: "high" }).think, "high");
  });

  it("OMITS the field when unset, for models whose API rejects it", () => {
    const body = buildRequest("doc", ok({ RECEIPT_LLM_THINK: "unset" }));
    assert.ok(!("think" in body));
    assert.equal(buildRequest("doc", ok({})).think, false);
  });
});

describe("receipt model settings — other Ollama options", () => {
  it("passes anything Ollama accepts through to the request", () => {
    const c = ok({ RECEIPT_LLM_OPTIONS: '{"num_thread": 8, "seed": 42, "use_mmap": false}' });
    const opts = buildRequest("doc", c).options as Record<string, unknown>;
    assert.equal(opts.num_thread, 8);
    assert.equal(opts.seed, 42);
    assert.equal(opts.use_mmap, false);
    // The dedicated settings are still there alongside them.
    assert.equal(opts.num_ctx, 8192);
  });

  it("refuses a key that has its own variable, rather than picking a winner silently", () => {
    const e = errors({ RECEIPT_LLM_OPTIONS: '{"num_ctx": 32768}' });
    assert.ok(e.some((x) => x.includes("RECEIPT_LLM_NUM_CTX")), e.join("; "));
  });

  it("refuses JSON that is not an object", () => {
    assert.ok(errors({ RECEIPT_LLM_OPTIONS: "[1,2]" }).length > 0);
    assert.ok(errors({ RECEIPT_LLM_OPTIONS: "{not json" }).length > 0);
  });

  it("sends keep_alive as seconds when bare, and as a duration otherwise", () => {
    assert.equal(buildRequest("doc", ok({ RECEIPT_LLM_KEEP_ALIVE: "300" })).keep_alive, 300);
    assert.equal(buildRequest("doc", ok({ RECEIPT_LLM_KEEP_ALIVE: "30m" })).keep_alive, "30m");
    assert.equal(buildRequest("doc", ok({ RECEIPT_LLM_KEEP_ALIVE: "-1" })).keep_alive, -1);
    assert.ok(!("keep_alive" in buildRequest("doc", ok({}))));
  });
});

describe("what Ollama's refusals mean", () => {
  const cfg = ok({ OLLAMA_MODEL: "gemma4:26b" });

  it("a model that is not pulled is a SETTING, and says how to fix it", () => {
    const f = classifyHttpFailure(404, `{"error":"model 'qwen3:4b' not found"}`, cfg);
    assert.equal(f.kind, "llm_misconfigured");
    assert.match(f.message, /ollama pull gemma4:26b/);
  });

  it("running out of memory names the window, not the document", () => {
    // The exact shape Ollama sent on the machine this was built on, at num_ctx 16384.
    const body = `{"error":"llama-server startup failed before projector CPU offload retry: llama-server reported out-of-memory during startup"}`;
    const f = classifyHttpFailure(500, body, cfg);
    assert.equal(f.kind, "llm_misconfigured");
    assert.match(f.message, /RECEIPT_LLM_NUM_CTX/);
  });

  it("a model that rejects the thinking flag points at RECEIPT_LLM_THINK", () => {
    const f = classifyHttpFailure(400, `{"error":"\\"llama3\\" does not support thinking"}`, cfg);
    assert.equal(f.kind, "llm_misconfigured");
    assert.match(f.message, /RECEIPT_LLM_THINK=unset/);
  });

  it("anything else stays retryable", () => {
    assert.equal(classifyHttpFailure(503, "busy", cfg).kind, "llm_unavailable");
  });
});
