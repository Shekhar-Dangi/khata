// Reading an invoice with a model, and refusing to believe it without evidence.
//
// This is the SECOND way to turn a document into an
// `OrderRecord`; `ingest/receipts/*` is the first and stays the preferred one. What is new here
// is not the shape of the answer — it is that the answer arrives from something that can be
// confidently wrong, so most of this file is about not trusting it.
//
// EVERY LESSON IN `llm.ts` APPLIES AND IS APPLIED:
//
//  1. THE OUTPUT SCHEMA IS THE LATENCY CONTROL. A free-text field let a reasoning model spend
//     501 seconds inside it. Here the schema is a closed object with typed fields and no prose
//     anywhere, and `num_predict` is the backstop.
//  2. GRAMMAR-CONSTRAINED DECODING IS A MECHANICAL GUARANTEE. A field the schema does not
//     describe has zero probability of being emitted. We still validate, because a TRUNCATED
//     generation is a different failure from an invented one and only validation catches it.
//  3. PREFIX FIRST, VARIABLE LAST. The instructions and the schema are byte-identical across
//     every document in a batch, so the runtime replays them from cache. Measured at ~4x on
//     this project. The document goes LAST, always.
//
// AND THE ONE THAT SHAPES EVERYTHING ELSE: an earlier experiment measured self-reported
// confidence at 0.95 on a correct answer, 0.95 on "Unknown" and 0.80 on a wrong one. **The
// model is never asked how sure it is.** Confidence here is DERIVED, from four checks against
// the document, in `verify()` below.

import { createHash } from "node:crypto";

import type { ErrorKind } from "./queue-policy.ts";
import { RECEIPT_LLM, type ReceiptLlmConfig, ollamaRequestBase } from "../../llm/config.ts";
import { diagnoseOllamaRefusal } from "../../llm/ollama.ts";

/** Bump to discard every cached answer produced by an older prompt. Same rule as `llm.ts`. */
export const RECEIPT_PROMPT_VERSION = "r1";

// THE MODEL, THE WINDOW, THE OUTPUT CAP AND THE TIMEOUT ARE SETTINGS, not constants — they are
// properties of the machine, not of the app. See `llm-config.ts` for every variable and
// the measurements behind the defaults. Two facts from that
// history are worth keeping in view here, because this file is where they bite:
//
//  - The window is SET EXPLICITLY, always. Ollama defaults `num_ctx` to 4096 whatever the model
//    supports, and a prompt that does not fit is silently truncated AT THE FRONT — the answer
//    can be well-formed and even reconcile over the half the model saw. `readInvoice` now
//    CHECKS for that using the token counts Ollama reports back, rather than hoping.
//  - The first values were wrong for the machine they were written on: a 16,384 window ran it
//    out of memory, and a 180s timeout would have killed every read on a CPU. A setting that is
//    wrong for a machine is now a NAMED failure pointing at the variable to change.

/** What the model is asked to produce. Mirrors `shapes.py`, which is the canonical shape. */
export type LlmLine = {
  kind: "goods" | "fee";
  description: string;
  sku: string | null;
  qty: number;
  amount_paise: number;
};

export type LlmInvoice = {
  invoice_number: string;
  seller_name: string | null;
  invoice_date: string | null;
  total_paise: number;
  lines: LlmLine[];
};

export type LlmRecord = {
  is_invoice: boolean;
  is_credit_note: boolean;
  merchant: string;
  external_ref: string;
  order_date: string | null;
  total_paise: number;
  invoices: LlmInvoice[];
};

/**
 * The JSON schema handed to Ollama as a grammar.
 *
 * MONEY IS INTEGER PAISE, and the schema says so. Asking for rupees as a number invites a
 * float, and a float cannot hold 0.1 — a few hundred line items summing in float drift off the
 * stated total by a paise or two, and `verify()` would then reject correct invoices while the
 * real bug sat in the arithmetic. `shapes.py` makes the same argument at length.
 *
 * There is NO confidence field, NO notes field and NO free-text anywhere. Every string is
 * something copied off the document.
 */
const SCHEMA = {
  type: "object",
  properties: {
    is_invoice: { type: "boolean" },
    is_credit_note: { type: "boolean" },
    merchant: { type: "string" },
    external_ref: { type: "string" },
    order_date: { type: ["string", "null"] },
    total_paise: { type: "integer" },
    invoices: {
      type: "array",
      items: {
        type: "object",
        properties: {
          invoice_number: { type: "string" },
          seller_name: { type: ["string", "null"] },
          invoice_date: { type: ["string", "null"] },
          total_paise: { type: "integer" },
          lines: {
            type: "array",
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["goods", "fee"] },
                description: { type: "string" },
                sku: { type: ["string", "null"] },
                qty: { type: "integer" },
                amount_paise: { type: "integer" },
              },
              required: ["kind", "description", "sku", "qty", "amount_paise"],
            },
          },
        },
        required: ["invoice_number", "seller_name", "invoice_date", "total_paise", "lines"],
      },
    },
  },
  required: [
    "is_invoice", "is_credit_note", "merchant", "external_ref",
    "order_date", "total_paise", "invoices",
  ],
} as const;

/**
 * Byte-identical for every document in a batch — that is what keeps it cached.
 *
 * Note what it does NOT do: it names no merchant and describes no template. A prompt that said
 * "this is a Blinkit invoice" would be a prompt that has to be chosen, and choosing it is the
 * job `detectReceiptTemplate` already does deterministically. A model asked to read whatever
 * it is given cannot be given the wrong hint.
 */
const PREFIX =
  "You read Indian retail invoices and return their contents exactly as printed.\n\n" +
  "RULES:\n" +
  "- Copy every amount as INTEGER PAISE. Rs 1,422.43 is 142243. Never round.\n" +
  "- Copy descriptions VERBATIM from the document. Never tidy, translate or shorten them.\n" +
  "- Never invent a line. If a row is unreadable, leave it out rather than guessing.\n" +
  "- A delivery charge, packaging fee or handling fee has kind 'fee'. Everything bought by " +
  "the customer has kind 'goods'.\n" +
  "- external_ref is the ORDER id, not an invoice number. One order can contain several " +
  "invoices from different sellers; list each separately with its own total.\n" +
  "- total_paise at the top level is the ORDER total: the sum of the invoice totals.\n" +
  "- Dates are YYYY-MM-DD, or null when the document does not state one.\n" +
  "- is_invoice is false when this document is not an invoice at all.\n" +
  "- is_credit_note is true for a refund, credit note or return.\n\n" +
  "DOCUMENT:\n";

/**
 * The exact request `readInvoice` sends. Exported so a measurement script asks the model the
 * SAME question the worker asks — a probe with its own copy of the prompt measures a prompt
 * nobody uses.
 */
export function buildRequest(markdown: string, cfg: ReceiptLlmConfig = RECEIPT_LLM): Record<string, unknown> {
  // Model, options, think and keep_alive are built by the one function both jobs share, so a
  // setting means the same thing here as it does for category suggestions.
  return { ...ollamaRequestBase(cfg), prompt: PREFIX + markdown + "\n", format: SCHEMA };
}

/**
 * Turn Ollama's refusal into a failure the queue can act on.
 *
 * The diagnosis is shared with llm.ts (`diagnoseOllamaRefusal`); what is specific to receipts
 * is only the KIND it maps to. A settings problem is `llm_misconfigured`, permanent — it fails
 * identically on every retry and reloads the model each time — and anything else stays
 * `llm_unavailable`, which is retried.
 */
export function classifyHttpFailure(
  status: number,
  body: string,
  cfg: ReceiptLlmConfig = RECEIPT_LLM,
): LlmParseFailure {
  const d = diagnoseOllamaRefusal(status, body, cfg);
  return new LlmParseFailure(d.misconfigured ? "llm_misconfigured" : "llm_unavailable", d.message);
}

export class LlmParseFailure extends Error {
  kind: ErrorKind;

  constructor(kind: ErrorKind, message: string) {
    super(message);
    this.name = "LlmParseFailure";
    this.kind = kind;
  }
}

const cache = new Map<string, LlmRecord>();

/**
 * Every setting that can change the ANSWER is in the key; the ones that only change how long it
 * takes (host, timeout, keep_alive) are not. Keying on the model and the window alone would let
 * a change of temperature or of an extra option serve an answer produced under the old one.
 */
function cacheKey(markdown: string, cfg: ReceiptLlmConfig = RECEIPT_LLM): string {
  const { model, think, temperature, numCtx, numPredict, extraOptions } = cfg;
  return createHash("sha256")
    .update(JSON.stringify({
      v: RECEIPT_PROMPT_VERSION, model, think, temperature, numCtx, numPredict, extraOptions,
    }))
    .update("\u0000")
    .update(markdown)
    .digest("hex");
}

/**
 * Ask the local model to read one document.
 *
 * Throws `LlmParseFailure` carrying an `ErrorKind`, so the worker's classification and the
 * queue's retry policy get a value rather than a message to pattern-match on.
 */
export async function readInvoice(markdown: string): Promise<LlmRecord> {
  const key = cacheKey(markdown);
  const hit = cache.get(key);
  // A model is not a function — temperature 0 narrows the output but does not make it
  // bit-identical. Memoising is what makes a re-run deterministic AT THE APPLICATION LAYER,
  // and it makes re-parsing an artifact after a code change free.
  if (hit !== undefined) return hit;

  const cfg = RECEIPT_LLM;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs);
  let raw: string;
  try {
    const res = await fetch(cfg.host + "/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildRequest(markdown, cfg)),
      signal: ctl.signal,
    });
    if (!res.ok) {
      // THE BODY IS THE DIAGNOSIS. Ollama answers 500 for several unrelated reasons — out of
      // memory, a crashed runner, a grammar it cannot compile — and says which in the body.
      // A bare status code in the failure list is a reason nobody can act on.
      const why = (await res.text().catch(() => "")).slice(0, 300);
      throw classifyHttpFailure(res.status, why, cfg);
    }
    const body = (await res.json()) as {
      response?: unknown;
      prompt_eval_count?: unknown;
      eval_count?: unknown;
      done_reason?: unknown;
    };
    if (typeof body.response !== "string") {
      throw new LlmParseFailure("schema_violation", "the model returned no response field");
    }

    // THE SILENT-TRUNCATION TRAP, CHECKED RATHER THAN DOCUMENTED.
    //
    // When a prompt does not fit, Ollama does not refuse it — it drops the FRONT and answers
    // about what is left, and the answer can be well-formed and even reconcile over the half it
    // saw. The response reports what was actually evaluated, so a prompt that filled the window
    // is treated as one that may have been cut, and refused as too large rather than believed.
    const promptTokens = Number(body.prompt_eval_count);
    const outputTokens = Number(body.eval_count);
    if (Number.isFinite(promptTokens) && Number.isFinite(outputTokens) &&
        promptTokens + outputTokens >= cfg.numCtx) {
      throw new LlmParseFailure(
        "too_large",
        `the document filled the model's ${cfg.numCtx}-token window ` +
          `(${promptTokens} in, ${outputTokens} out) and may have been cut — raise ` +
          "RECEIPT_LLM_NUM_CTX if this machine has the memory",
      );
    }
    // The generation stopped because it hit `num_predict`, not because it finished. The JSON
    // would fail to parse anyway, but naming the reason here beats "not complete JSON".
    if (body.done_reason === "length") {
      throw new LlmParseFailure(
        "llm_truncated",
        `the model's answer hit the ${cfg.numPredict}-token output cap before it finished — ` +
          "raise RECEIPT_LLM_NUM_PREDICT for invoices this long",
      );
    }
    raw = body.response;
  } catch (err) {
    if (err instanceof LlmParseFailure) throw err;
    if (ctl.signal.aborted) {
      throw new LlmParseFailure(
        "llm_timeout",
        `the local model took longer than ${Math.round(cfg.timeoutMs / 1000)}s — raise ` +
          "RECEIPT_LLM_TIMEOUT_MS on a slow machine",
      );
    }
    throw new LlmParseFailure(
      "llm_unavailable",
      `could not reach the local model at ${cfg.host} — is Ollama running?`,
    );
  } finally {
    clearTimeout(timer);
  }

  // MODEL OUTPUT IS UNTRUSTED INPUT, the same class as req.body. The grammar makes an invalid
  // shape unrepresentable, not impossible to RECEIVE: an aborted generation truncates the JSON
  // mid-string, and that arrives here as a parse error rather than as a schema violation.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LlmParseFailure(
      "llm_truncated",
      "the model's answer was not complete JSON — the generation was probably cut off",
    );
  }

  const record = coerce(parsed);
  cache.set(key, record);
  return record;
}

/** Validate the shape ourselves. The grammar is a guarantee about the model, not about us. */
function coerce(value: unknown): LlmRecord {
  const bad = (why: string): never => {
    throw new LlmParseFailure("schema_violation", why);
  };
  if (value === null || typeof value !== "object") return bad("the answer was not an object");
  const o = value as Record<string, unknown>;

  const int = (v: unknown, what: string): number => {
    // Number() never throws: Number("") is 0 and Number("abc") is NaN. Validate the shape,
    // never trust the coercion — the recurring trap this codebase names explicitly.
    if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) {
      return bad(`${what} was not an integer`);
    }
    return v;
  };
  const str = (v: unknown, what: string): string =>
    typeof v === "string" ? v : bad(`${what} was not a string`);
  const nullableStr = (v: unknown): string | null => (typeof v === "string" ? v : null);

  const invoices = Array.isArray(o.invoices) ? o.invoices : bad("invoices was not an array");

  return {
    is_invoice: o.is_invoice === true,
    is_credit_note: o.is_credit_note === true,
    merchant: str(o.merchant, "merchant"),
    external_ref: str(o.external_ref, "external_ref"),
    order_date: nullableStr(o.order_date),
    total_paise: int(o.total_paise, "total_paise"),
    invoices: invoices.map((raw, i) => {
      if (raw === null || typeof raw !== "object") return bad(`invoice ${i} was not an object`);
      const inv = raw as Record<string, unknown>;
      const lines = Array.isArray(inv.lines) ? inv.lines : bad(`invoice ${i} had no lines array`);
      return {
        invoice_number: str(inv.invoice_number, `invoice ${i} number`),
        seller_name: nullableStr(inv.seller_name),
        invoice_date: nullableStr(inv.invoice_date),
        total_paise: int(inv.total_paise, `invoice ${i} total`),
        lines: lines.map((lraw, j) => {
          if (lraw === null || typeof lraw !== "object") return bad(`line ${i}.${j} was not an object`);
          const l = lraw as Record<string, unknown>;
          return {
            kind: l.kind === "fee" ? ("fee" as const) : ("goods" as const),
            description: str(l.description, `line ${i}.${j} description`),
            sku: nullableStr(l.sku),
            qty: int(l.qty, `line ${i}.${j} qty`),
            amount_paise: int(l.amount_paise, `line ${i}.${j} amount`),
          };
        }),
      };
    }),
  };
}
