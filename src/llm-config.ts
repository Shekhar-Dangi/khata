// Every setting this app takes for its local models, in ONE place, validated once.
//
// The machine's numbers are settings, not constants. The app talks to a local model for two
// jobs, and each is a
// PROFILE with its own variables:
//
//   RECEIPT_LLM_*    reading an invoice — a long, structured extraction (receipt-llm.ts)
//   CATEGORY_LLM_*   naming a category for a merchant — a one-word enum pick (llm.ts)
//
// Both fall back to the shared OLLAMA_MODEL and OLLAMA_HOST, so a person with one model sets one
// variable. They are separate profiles because the jobs are: a 30-line extraction needs a window
// of thousands of tokens and minutes on a CPU, a category pick needs forty tokens and seconds,
// and a person may reasonably want a bigger model for one of them.
//
// WHY SETTINGS AT ALL. Every number here used to be a constant, and the first real run showed
// they were properties of ONE MACHINE: a 16,384-token window ran a 31.5 GB, GPU-less laptop out
// of memory and is trivial on a 24 GB card; a 600-second timeout is necessary on a CPU and
// absurd on a GPU. Constants made the app correct for exactly one computer.
//
// THE PURE HALF (`parseLlmConfig`) takes an env object and returns either both profiles or
// EVERY problem it found across both — fixing a .env one error per restart is how an evening
// disappears. THE LOADER (bottom) fails the server at startup if anything is wrong: a typo found
// in the first second beats one found an hour into a batch, one failed document at a time.

/** What `think` may be. `unset` omits the field for models whose API rejects it entirely. */
export type ThinkSetting = boolean | "low" | "medium" | "high" | "unset";

/** One job's settings. */
export type LlmProfile = {
  /** Which variables this came from — used to name the one to change in an error message. */
  prefix: "RECEIPT_LLM" | "CATEGORY_LLM";
  host: string;
  model: string;
  /** The context window, or null to OMIT it and take Ollama's default. */
  numCtx: number | null;
  numPredict: number;
  timeoutMs: number;
  think: ThinkSetting;
  temperature: number;
  /** Ollama's own duration syntax ("30m", "-1"), or null to leave Ollama's default. */
  keepAlive: string | null;
  /** Anything else Ollama accepts under `options` — num_thread, num_gpu, top_k, seed... */
  extraOptions: Record<string, string | number | boolean>;
};

/** The receipt profile, which ALWAYS sets its window, plus what only reading documents needs. */
export type ReceiptLlmConfig = LlmProfile & {
  numCtx: number;
  extractTimeoutMs: number;
  /** DERIVED, never set: how much document fits beside the instructions and the answer. */
  maxMarkdownChars: number;
};

export type CategoryLlmConfig = LlmProfile;

/**
 * Characters per token for the markdown docling produces, MEASURED at 2.99 on a real invoice
 * (2026-09-19) and rounded DOWN, so the derived budget errs on the side
 * of refusing a document rather than admitting one the model then silently truncates. A model
 * with a different tokenizer will differ; `readInvoice`'s token-count check is the backstop
 * that makes being wrong here safe in both directions.
 */
export const CHARS_PER_TOKEN = 2.9;

/** The receipt instructions plus a margin. The prefix measured ~250 tokens. */
export const PROMPT_OVERHEAD_TOKENS = 300;

/**
 * The smallest document budget worth running. The smallest real invoice is ~2,150 characters;
 * a window that cannot hold that cannot read anything, and saying so at startup beats refusing
 * every document with `too_large` one at a time.
 */
export const MIN_MARKDOWN_CHARS = 2_000;

/** Keys with their own variable. Setting them in *_OPTIONS too is refused — see below. */
const DEDICATED_OPTIONS = new Set(["num_ctx", "num_predict", "temperature"]);

type Env = Record<string, string | undefined>;

type ProfileDefaults = {
  /** null means OMIT num_ctx unless the person sets it. */
  numCtx: number | null;
  numPredict: number;
  timeoutMs: number;
};

/**
 * The defaults are what each job did BEFORE it was configurable, so nothing changes for anyone
 * who sets nothing. The receipt numbers were measured on real runs; the category numbers are the
 * ones llm.ts always sent — 40 output tokens because the answer is one enum value, no window
 * because the prompt is a few hundred tokens, and 60s because that is what it has always waited.
 */
const DEFAULTS: Record<LlmProfile["prefix"], ProfileDefaults> = {
  RECEIPT_LLM: { numCtx: 8_192, numPredict: 2_048, timeoutMs: 600_000 },
  CATEGORY_LLM: { numCtx: null, numPredict: 40, timeoutMs: 60_000 },
};

/**
 * Read one profile's variables, pushing every problem into `errors`.
 *
 * An EMPTY value means unset, because `KEY=` is how a .env line gets switched off and treating
 * it as the string "" would make a blank line an error.
 */
function parseProfile(env: Env, prefix: LlmProfile["prefix"], errors: string[]): LlmProfile {
  const d = DEFAULTS[prefix];
  const get = (key: string): string | undefined => {
    const v = env[key];
    return v === undefined || v.trim() === "" ? undefined : v.trim();
  };

  // STRICT INTEGERS. /^\d+$/ and not Number(): Number("8k") is NaN, Number("") is 0,
  // Number("1e4") is 10000 and Number(" 8192 ") is 8192, and none of them throws. The same
  // test `intParam` uses for route ids, for the same reason.
  const int = (key: string, fallback: number, min: number, max: number): number => {
    const raw = get(key);
    if (raw === undefined) return fallback;
    if (!/^\d+$/.test(raw)) {
      errors.push(`${key} must be a whole number, got "${raw}"`);
      return fallback;
    }
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < min || n > max) {
      errors.push(`${key} must be between ${min} and ${max}, got ${raw}`);
      return fallback;
    }
    return n;
  };

  const host = get("OLLAMA_HOST") ?? "http://127.0.0.1:11434";

  // The profile's own model, then the one the whole app shares, then llm.ts's historic default.
  const model = get(`${prefix}_MODEL`) ?? get("OLLAMA_MODEL") ?? "qwen3:4b";

  const numCtx: number | null =
    get(`${prefix}_NUM_CTX`) === undefined && d.numCtx === null
      ? null
      : int(`${prefix}_NUM_CTX`, d.numCtx ?? 8_192, 1_024, 1_048_576);
  const numPredict = int(`${prefix}_NUM_PREDICT`, d.numPredict, 1, 1_048_576);
  const timeoutMs = int(`${prefix}_TIMEOUT_MS`, d.timeoutMs, 1_000, 86_400_000);

  // THINK. `false` is the default and it is not arbitrary: it was measured
  // producing BETTER answers on this project, and with a grammar-constrained schema a reasoning
  // preamble has nowhere to go anyway. `unset` exists because some models' APIs reject the field
  // outright rather than ignoring it; `low|medium|high` are the levels some models take instead
  // of a boolean.
  let think: ThinkSetting = false;
  const rawThink = get(`${prefix}_THINK`)?.toLowerCase();
  if (rawThink !== undefined) {
    if (rawThink === "true" || rawThink === "1") think = true;
    else if (rawThink === "false" || rawThink === "0") think = false;
    else if (rawThink === "low" || rawThink === "medium" || rawThink === "high" || rawThink === "unset") {
      think = rawThink;
    } else {
      errors.push(`${prefix}_THINK must be true, false, low, medium, high or unset, got "${rawThink}"`);
    }
  }

  let temperature = 0;
  const rawTemp = get(`${prefix}_TEMPERATURE`);
  if (rawTemp !== undefined) {
    // Anchored and decimal-only for the same reason as `int`: "1e0", "0x1" and ".5 " all
    // survive Number(), and a setting that means something other than what it says is worse
    // than one that fails.
    if (!/^\d+(\.\d+)?$/.test(rawTemp) || Number(rawTemp) > 2) {
      errors.push(`${prefix}_TEMPERATURE must be a number from 0 to 2, got "${rawTemp}"`);
    } else {
      temperature = Number(rawTemp);
    }
  }

  // KEEP_ALIVE, in Ollama's own syntax. Worth setting for a big batch on a slow machine: the
  // model took 65s to load here, and every reload between documents pays that again.
  let keepAlive: string | null = null;
  const rawKeep = get(`${prefix}_KEEP_ALIVE`);
  if (rawKeep !== undefined) {
    if (!/^-?\d+(\.\d+)?(ms|s|m|h)?$/.test(rawKeep)) {
      errors.push(`${prefix}_KEEP_ALIVE must look like 30m, 1h, 300 or -1, got "${rawKeep}"`);
    } else {
      keepAlive = rawKeep;
    }
  }

  // THE ESCAPE HATCH: any other Ollama option, as JSON. General on purpose — num_thread,
  // num_gpu, top_k, seed, min_p — because the list of options is Ollama's to grow, not ours to
  // mirror one variable at a time.
  const extraOptions: Record<string, string | number | boolean> = {};
  const rawOpts = get(`${prefix}_OPTIONS`);
  if (rawOpts !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawOpts);
    } catch {
      errors.push(`${prefix}_OPTIONS must be a JSON object, e.g. {"num_thread": 8} — could not parse it`);
    }
    if (parsed !== undefined) {
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        errors.push(`${prefix}_OPTIONS must be a JSON object, not an array or a value`);
      } else {
        for (const [k, v] of Object.entries(parsed)) {
          // A key with its own variable is REFUSED here rather than silently overridden. Two
          // places to set one number, with a precedence rule to remember, is how somebody
          // raises the window, sees nothing change, and loses an afternoon.
          if (DEDICATED_OPTIONS.has(k)) {
            errors.push(`${prefix}_OPTIONS sets "${k}" — use ${prefix}_${k.toUpperCase()} instead`);
          } else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
            extraOptions[k] = v;
          } else {
            errors.push(`${prefix}_OPTIONS.${k} must be a string, number or boolean`);
          }
        }
      }
    }
  }

  // CROSS-FIELD. The answer is written into the same window as the prompt, so an output cap at
  // or above the window leaves no room for the prompt at all.
  if (numCtx !== null && numPredict >= numCtx) {
    errors.push(
      `${prefix}_NUM_PREDICT (${numPredict}) must be smaller than ${prefix}_NUM_CTX (${numCtx}) — ` +
        "the answer is written into the same window as the prompt",
    );
  }

  return {
    prefix, host, model, numCtx, numPredict, timeoutMs, think, temperature, keepAlive, extraOptions,
  };
}

type Parsed =
  | { ok: true; receipt: ReceiptLlmConfig; category: CategoryLlmConfig }
  | { ok: false; errors: string[] };

/** Read and validate both profiles. Every problem in either is reported, together. */
export function parseLlmConfig(env: Env): Parsed {
  const errors: string[] = [];

  const host = env.OLLAMA_HOST?.trim();
  if (host && !/^https?:\/\/[^\s]+$/.test(host)) {
    errors.push(`OLLAMA_HOST must be an http(s) URL, got "${host}"`);
  }

  const receiptBase = parseProfile(env, "RECEIPT_LLM", errors);
  const category = parseProfile(env, "CATEGORY_LLM", errors);

  // The receipt profile ALWAYS has a window: its document budget is derived from it, and the
  // truncation guard in readInvoice compares against it. `parseProfile` guarantees this because
  // its default is non-null; the fallback only satisfies the type.
  const numCtx = receiptBase.numCtx ?? 8_192;
  const extractTimeoutMs = (() => {
    const raw = env.RECEIPT_EXTRACT_TIMEOUT_MS?.trim();
    if (!raw) return 120_000;
    if (!/^\d+$/.test(raw) || Number(raw) < 1_000 || Number(raw) > 3_600_000) {
      errors.push(`RECEIPT_EXTRACT_TIMEOUT_MS must be a whole number from 1000 to 3600000, got "${raw}"`);
      return 120_000;
    }
    return Number(raw);
  })();

  // DERIVED, NOT SET. The markdown budget follows from the window, so raising the window admits
  // bigger documents without anyone having to find and change a second number in Python.
  const maxMarkdownChars = Math.floor(
    Math.max(0, numCtx - receiptBase.numPredict - PROMPT_OVERHEAD_TOKENS) * CHARS_PER_TOKEN,
  );
  if (receiptBase.numPredict < numCtx && maxMarkdownChars < MIN_MARKDOWN_CHARS) {
    errors.push(
      `RECEIPT_LLM_NUM_CTX ${numCtx} leaves room for only ${maxMarkdownChars} characters of ` +
        "document (the smallest real invoice is ~2,150) — raise it, or lower RECEIPT_LLM_NUM_PREDICT",
    );
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    receipt: { ...receiptBase, numCtx, extractTimeoutMs, maxMarkdownChars },
    category,
  };
}

/** Parse, or throw with every problem listed. */
export function loadLlmConfig(env: Env): { receipt: ReceiptLlmConfig; category: CategoryLlmConfig } {
  const parsed = parseLlmConfig(env);
  if (parsed.ok) return { receipt: parsed.receipt, category: parsed.category };
  throw new Error(
    "Invalid local-model settings in .env:\n" +
      parsed.errors.map((e) => `  - ${e}`).join("\n") +
      "\nSee .env.example for every setting and its default.",
  );
}

const loaded = loadLlmConfig(process.env);

/** Reading invoices. Loaded once at startup; a bad setting stops the server here, loudly. */
export const RECEIPT_LLM: ReceiptLlmConfig = loaded.receipt;

/** Naming a category for a merchant (llm.ts). Same loader, same rules. */
export const CATEGORY_LLM: CategoryLlmConfig = loaded.category;

/**
 * The body both jobs send, minus what is specific to each (prompt, format).
 *
 * ONE implementation of how a profile becomes an Ollama request, so `think: unset`, a bare
 * keep_alive and the extra options mean the same thing for both jobs.
 */
export function ollamaRequestBase(p: LlmProfile): Record<string, unknown> {
  const options: Record<string, unknown> = {
    // The free-form options first and the dedicated settings on top. The parser already refuses
    // a clash between the two, so this order is a second guard, not the only one.
    ...p.extraOptions,
    temperature: p.temperature,
    num_predict: p.numPredict,
  };
  // Omitted rather than sent as a default when unset: sending ANY num_ctx makes Ollama reload a
  // model that is already loaded with a different one, 65s on the machine this was built on.
  if (p.numCtx !== null) options.num_ctx = p.numCtx;

  const body: Record<string, unknown> = { model: p.model, stream: false, options };
  // `unset` OMITS the field. Some models' APIs reject `think` outright instead of ignoring it,
  // so "do not send it" has to be a real choice and not the same thing as `false`.
  if (p.think !== "unset") body.think = p.think;
  // Ollama takes a bare number as SECONDS and anything with a unit as a duration string.
  if (p.keepAlive !== null) {
    body.keep_alive = /^-?\d+(\.\d+)?$/.test(p.keepAlive) ? Number(p.keepAlive) : p.keepAlive;
  }
  return body;
}
