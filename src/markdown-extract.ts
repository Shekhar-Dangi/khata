// The TypeScript half of the MODEL path's extractor: bytes in, markdown out or a reason why not.
//
// the design slice 3. It is the sibling of `pdf-extract.ts` and it is
// deliberately a sibling rather than a branch inside it: the two answer different questions
// (page text and table cells for a deterministic parser; prose with table structure for a
// model), they have different limits, and they fail in different ways. Merging them would give
// one function two unrelated failure modes, which is the argument `receipt-templates.ts`
// already makes about keeping `detectSource` and `detectReceiptTemplate` apart.
//
// The out-of-process discipline is inherited wholesale from `pdf-extract.ts` and the reasons
// are unchanged — a document arriving from outside is fed to a large parsing surface, so a
// malformed one must cost a killed subprocess rather than the API. Docling raises the stakes:
// it is heavier than pdfplumber, it loads ML models, and it OCRs. Everything that was true
// about bounding pdfplumber is more true here.
//
// WHAT IS BOUNDED, and what is not:
//
//   bounded   wall-clock        the child is killed after EXTRACT_MARKDOWN_TIMEOUT_MS
//   bounded   input size        the upload route caps at 10mb
//   bounded   page count        MAX_PAGES in to_markdown.py, checked BEFORE conversion
//   bounded   output size       MAX_MARKDOWN_CHARS there, and MAX_OUTPUT_BYTES here
//   NOT       resident memory   same gap pdf-extract.ts documents, and docling uses more of it

import { spawn } from "node:child_process";

import { pythonBin, repoRoot } from "./pdf-extract.ts";
import type { ErrorKind } from "./parse-queue-policy.ts";
import { RECEIPT_LLM } from "./receipt-llm-config.ts";

/**
 * How long docling may run before it is killed.
 *
 * Far longer than `EXTRACT_TIMEOUT_MS`'s 20s, because these are not comparable operations:
 * pdfplumber reads a text layer, docling runs layout analysis and possibly OCR over every
 * page. 120s is a ceiling on pathological input rather than a target: measured with OCR off
 * (the default for a PDF with a text layer), a 2-3 page invoice converts in 10-36s once the
 * models are loaded and ~48s in a fresh process. The worker's heartbeat keeps the lease alive
 * across this and the model read, so a slow document is reported by THIS timer rather than
 * mistaken for a dead worker.
 */
export const EXTRACT_MARKDOWN_TIMEOUT_MS = RECEIPT_LLM.extractTimeoutMs; // RECEIPT_EXTRACT_TIMEOUT_MS, default 120s

/** Markdown is text and text is small. This guards the pipe, not the budget. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export type MarkdownResult =
  | { ok: true; markdown: string; chars: number; pages: number | null }
  | { ok: false; kind: ErrorKind; error: string };

/** The kinds `to_markdown.py` is allowed to answer with. Anything else is a bug in the seam. */
const PYTHON_KINDS = new Set<ErrorKind>([
  "empty",
  "too_many_pages",
  "too_large",
  "corrupt",
  "models_missing",
  "extract_crashed",
]);

/**
 * Convert a PDF to markdown in a child process.
 *
 * NEVER THROWS for a bad document. Every outcome is a value carrying an `ErrorKind`, because
 * "this file is a scan docling could not read" is something the queue has to RECORD and
 * classify, not something a catch block has to interpret. The kind flows straight into
 * `retryPolicy`, which is why it is typed as `ErrorKind` here rather than as a loose string.
 */
export function extractMarkdown(
  bytes: Buffer,
  timeoutMs = EXTRACT_MARKDOWN_TIMEOUT_MS,
): Promise<MarkdownResult> {
  return new Promise((resolve) => {
    // Array args, `shell: false`, and the document goes over STDIN — nothing user-controlled
    // ever becomes a command-line argument, so no quoting question arises at all.
    const child = spawn(pythonBin(), ["-m", "ingest.receipts.to_markdown"], {
      cwd: repoRoot(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      // The markdown budget is DERIVED from the model's window (receipt-llm-config.ts), so it is
      // handed to Python rather than kept as a second constant there. Raising the window then
      // admits bigger documents in one place, and the two halves cannot disagree about the size
      // of a document the model can read.
      env: { ...process.env, RECEIPT_MAX_MARKDOWN_CHARS: String(RECEIPT_LLM.maxMarkdownChars) },
    });

    const out: Buffer[] = [];
    let outBytes = 0;
    let err = "";
    let settled = false;

    const finish = (result: MarkdownResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        ok: false,
        kind: "extract_timeout",
        error: `converting the document exceeded ${timeoutMs}ms and was killed`,
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish({
          ok: false,
          kind: "too_large",
          error: `the converter produced more than ${MAX_OUTPUT_BYTES} bytes`,
        });
        return;
      }
      out.push(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      // Tail only — a child in an error loop fills this as fast as stdout, and the last
      // message is the useful one. Docling is chatty on stderr even when it succeeds.
      err = (err + chunk.toString("utf8")).slice(-4000);
    });

    child.on("error", (e) => {
      finish({
        ok: false,
        kind: "models_missing",
        error: `could not start the converter (${pythonBin()}): ${e.message}`,
      });
    });

    child.on("close", () => {
      const raw = Buffer.concat(out).toString("utf8").trim();
      if (raw === "") {
        finish({
          ok: false,
          kind: "extract_crashed",
          error: `the converter produced no output${err ? `: ${err.slice(-300)}` : ""}`,
        });
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // The one contract violation worth naming precisely: stdout must be JSON and nothing
        // else, so a stray print in the Python half lands here rather than as a confusing
        // schema error three layers up.
        finish({
          ok: false,
          kind: "extract_crashed",
          error: `the converter did not answer with JSON: ${raw.slice(0, 200)}`,
        });
        return;
      }

      const body = parsed as Record<string, unknown>;
      if (body.ok === true && typeof body.markdown === "string") {
        finish({
          ok: true,
          markdown: body.markdown,
          chars: typeof body.chars === "number" ? body.chars : body.markdown.length,
          pages: typeof body.pages === "number" ? body.pages : null,
        });
        return;
      }

      // A kind we do not recognise becomes `unknown`, which `retryPolicy` treats as permanent.
      // Trusting the child's string directly would let a typo in the Python half choose the
      // retry policy, and a kind nobody classified must not inherit somebody else's.
      const kind = body.kind;
      finish({
        ok: false,
        kind: typeof kind === "string" && PYTHON_KINDS.has(kind as ErrorKind)
          ? (kind as ErrorKind)
          : "unknown",
        error: typeof body.error === "string" ? body.error : "the converter did not say why",
      });
    });

    // EPIPE is expected rather than exceptional: the child exits early on a document it
    // refuses, and the remaining bytes then have nowhere to go. Same note as pdf-extract.ts.
    child.stdin.on("error", () => {});
    child.stdin.end(bytes);
  });
}
