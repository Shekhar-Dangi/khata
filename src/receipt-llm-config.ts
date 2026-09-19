// Every setting the receipt model path takes from the environment, in ONE place, validated once.
//
// the design. These numbers used to be constants, and the first real run
// showed why that was wrong: every one of them was a property of ONE MACHINE. 16,384 tokens of
// context ran a 31.5 GB, GPU-less laptop out of memory; the same window is trivial on a card
// with 24 GB of VRAM. A 600-second timeout is necessary on a CPU and absurd on a GPU. Hardcoding
// them made the app correct for exactly one computer.
//
// So they are settings, with defaults MEASURED on the machine this was built on, and this
// module is the only thing that reads them. Everything else imports `RECEIPT_LLM`.
//
// THE PURE HALF (`parseReceiptLlmConfig`) takes an env object and returns either a config or
// EVERY problem it found — not just the first, because fixing a .env one error per restart is
// how an evening disappears. Same split as rules.ts / filters.ts, and it is where the tests are.
//
// THE LOADER (`RECEIPT_LLM`, bottom) fails the server at startup if anything is wrong. A typo in
// a setting is a mistake the owner made a minute ago and can fix in a minute; the alternative —
// discovering it one failed document at a time, an hour into a batch — is strictly worse.

/** What `think` may be. `unset` omits the field for models whose API rejects it entirely. */
export type ThinkSetting = boolean | "low" | "medium" | "high" | "unset";

export type ReceiptLlmConfig = {
  host: string;
  model: string;
  numCtx: number;
  numPredict: number;
  timeoutMs: number;
  extractTimeoutMs: number;
  think: ThinkSetting;
  temperature: number;
  /** Ollama's own duration syntax ("30m", "-1"), or null to leave Ollama's default. */
  keepAlive: string | null;
  /** Anything else Ollama accepts under `options` — num_thread, num_gpu, top_k, seed... */
  extraOptions: Record<string, string | number | boolean>;
  /** DERIVED, never set: how much document fits beside the instructions and the answer. */
  maxMarkdownChars: number;
};

/**
 * Characters per token for the markdown docling produces, MEASURED at 2.99 on a real invoice
 * and rounded DOWN, so the derived budget errs on the side
 * of refusing a document rather than admitting one the model then silently truncates. A model
 * with a different tokenizer will differ; `readInvoice`'s token-count check is the backstop
 * that makes being wrong here safe in both directions.
 */
export const CHARS_PER_TOKEN = 2.9;

/** The instructions plus a margin. The prefix measured ~250 tokens. */
export const PROMPT_OVERHEAD_TOKENS = 300;

/**
 * The smallest document budget worth running. The smallest real invoice is ~2,150 characters;
 * a window that cannot hold that cannot read anything, and saying so at startup beats refusing
 * every document with `too_large` one at a time.
 */
export const MIN_MARKDOWN_CHARS = 2_000;

/** Keys with their own variable. Setting them in RECEIPT_LLM_OPTIONS too is refused — see below. */
const DEDICATED_OPTIONS = new Set(["num_ctx", "num_predict", "temperature"]);

type Env = Record<string, string | undefined>;
type Parsed = { ok: true; config: ReceiptLlmConfig } | { ok: false; errors: string[] };

/**
 * Read and validate every receipt-model setting.
 *
 * An EMPTY value means unset, because `KEY=` is how a .env line gets switched off and treating
 * it as the string "" would make a blank line an error.
 */
export function parseReceiptLlmConfig(env: Env): Parsed {
  const errors: string[] = [];
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
  if (!/^https?:\/\/[^\s]+$/.test(host)) {
    errors.push(`OLLAMA_HOST must be an http(s) URL, got "${host}"`);
  }

  // RECEIPT_LLM_MODEL first, then the model the rest of the app already uses. Reading an invoice
  // and picking one category from a list are different jobs — a 30-line structured extraction
  // against a one-word enum — and a person may reasonably want a bigger model for one of them.
  const model = get("RECEIPT_LLM_MODEL") ?? get("OLLAMA_MODEL") ?? "qwen3:4b";

  const numCtx = int("RECEIPT_LLM_NUM_CTX", 8_192, 1_024, 1_048_576);
  const numPredict = int("RECEIPT_LLM_NUM_PREDICT", 2_048, 128, 1_048_576);
  const timeoutMs = int("RECEIPT_LLM_TIMEOUT_MS", 600_000, 1_000, 86_400_000);
  const extractTimeoutMs = int("RECEIPT_EXTRACT_TIMEOUT_MS", 120_000, 1_000, 3_600_000);

  // THINK. `false` is the default and it is not arbitrary: the design measured it
  // producing BETTER answers on this project, and with a grammar-constrained schema a reasoning
  // preamble has nowhere to go anyway. `unset` exists because some models' APIs reject the field
  // outright rather than ignoring it; `low|medium|high` are the levels some models take instead
  // of a boolean.
  let think: ThinkSetting = false;
  const rawThink = get("RECEIPT_LLM_THINK")?.toLowerCase();
  if (rawThink !== undefined) {
    if (rawThink === "true" || rawThink === "1") think = true;
    else if (rawThink === "false" || rawThink === "0") think = false;
    else if (rawThink === "low" || rawThink === "medium" || rawThink === "high" || rawThink === "unset") {
      think = rawThink;
    } else {
      errors.push(`RECEIPT_LLM_THINK must be true, false, low, medium, high or unset, got "${rawThink}"`);
    }
  }

  let temperature = 0;
  const rawTemp = get("RECEIPT_LLM_TEMPERATURE");
  if (rawTemp !== undefined) {
    // Anchored and decimal-only for the same reason as `int`: "1e0", "0x1" and ".5 " all
    // survive Number(), and a setting that means something other than what it says is worse
    // than one that fails.
    if (!/^\d+(\.\d+)?$/.test(rawTemp) || Number(rawTemp) > 2) {
      errors.push(`RECEIPT_LLM_TEMPERATURE must be a number from 0 to 2, got "${rawTemp}"`);
    } else {
      temperature = Number(rawTemp);
    }
  }

  // KEEP_ALIVE, in Ollama's own syntax. Worth setting for a big batch on a slow machine: the
  // model took 65s to load here, and a document that takes longer than Ollama's default five
  // minutes to convert would otherwise pay that again for the next one.
  let keepAlive: string | null = null;
  const rawKeep = get("RECEIPT_LLM_KEEP_ALIVE");
  if (rawKeep !== undefined) {
    if (!/^-?\d+(\.\d+)?(ms|s|m|h)?$/.test(rawKeep)) {
      errors.push(`RECEIPT_LLM_KEEP_ALIVE must look like 30m, 1h, 300 or -1, got "${rawKeep}"`);
    } else {
      keepAlive = rawKeep;
    }
  }

  // THE ESCAPE HATCH: any other Ollama option, as JSON. General on purpose — num_thread,
  // num_gpu, top_k, seed, min_p — because the list of options is Ollama's to grow, not ours to
  // mirror one variable at a time.
  let extraOptions: Record<string, string | number | boolean> = {};
  const rawOpts = get("RECEIPT_LLM_OPTIONS");
  if (rawOpts !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawOpts);
    } catch {
      errors.push(`RECEIPT_LLM_OPTIONS must be a JSON object, e.g. {"num_thread": 8} — could not parse it`);
    }
    if (parsed !== undefined) {
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        errors.push("RECEIPT_LLM_OPTIONS must be a JSON object, not an array or a value");
      } else {
        for (const [k, v] of Object.entries(parsed)) {
          // A key with its own variable is REFUSED here rather than silently overridden. Two
          // places to set one number, with a precedence rule to remember, is how somebody
          // raises the window, sees nothing change, and loses an afternoon.
          if (DEDICATED_OPTIONS.has(k)) {
            errors.push(
              `RECEIPT_LLM_OPTIONS sets "${k}" — use RECEIPT_LLM_${k.toUpperCase()} instead`,
            );
          } else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
            extraOptions[k] = v;
          } else {
            errors.push(`RECEIPT_LLM_OPTIONS.${k} must be a string, number or boolean`);
          }
        }
      }
    }
  }

  // CROSS-FIELD. The answer is written into the same window as the prompt, so an output cap at
  // or above the window leaves no room for the document at all.
  if (numPredict >= numCtx) {
    errors.push(
      `RECEIPT_LLM_NUM_PREDICT (${numPredict}) must be smaller than RECEIPT_LLM_NUM_CTX (${numCtx}) — ` +
        "the answer is written into the same window as the document",
    );
  }

  // DERIVED, NOT SET. The markdown budget follows from the window, so raising the window admits
  // bigger documents without anyone having to find and change a second number in Python.
  const maxMarkdownChars = Math.floor(
    Math.max(0, numCtx - numPredict - PROMPT_OVERHEAD_TOKENS) * CHARS_PER_TOKEN,
  );
  if (numPredict < numCtx && maxMarkdownChars < MIN_MARKDOWN_CHARS) {
    errors.push(
      `RECEIPT_LLM_NUM_CTX ${numCtx} leaves room for only ${maxMarkdownChars} characters of ` +
        `document (the smallest real invoice is ~2,150) — raise it, or lower RECEIPT_LLM_NUM_PREDICT`,
    );
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    config: {
      host, model, numCtx, numPredict, timeoutMs, extractTimeoutMs,
      think, temperature, keepAlive, extraOptions, maxMarkdownChars,
    },
  };
}

/** Parse, or throw with every problem listed. Exported so a script can reuse the message. */
export function loadReceiptLlmConfig(env: Env): ReceiptLlmConfig {
  const parsed = parseReceiptLlmConfig(env);
  if (parsed.ok) return parsed.config;
  throw new Error(
    "Invalid receipt-model settings in .env:\n" +
      parsed.errors.map((e) => `  - ${e}`).join("\n") +
      "\nSee the design.",
  );
}

/** The one loaded config. Read once at startup; a bad setting stops the server here, loudly. */
export const RECEIPT_LLM: ReceiptLlmConfig = loadReceiptLlmConfig(process.env);
