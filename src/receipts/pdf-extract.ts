// The TypeScript half of the seam: run the Python extractor OUT OF PROCESS, safely.
//
// The boundary sits here — Python extracts, TypeScript owns dedupe,
// matching, allocation and persistence — so this module's whole job is to get a Document back
// or a reason why not. It knows nothing about invoices and nothing about the ledger.
//
// WHY OUT OF PROCESS AT ALL. A PDF library is a large parsing surface fed by files that arrive
// from outside, which is the classic shape of untrusted-input processing. Three things follow
// and none of them are avoidable in-process:
//
//   - a malformed document can make a parser loop or allocate without bound. In-process that
//     takes the API down; in a child it costs one killed subprocess and a 422.
//   - a native crash in a C extension takes its whole process with it. Better that process is
//     not the one holding the database pool.
//   - the extractor is Python and the app is Node. There is no in-process option anyway, and
//     it is worth being clear that the isolation is a benefit rather than a consolation.
//
// WHAT IS ACTUALLY BOUNDED, and what is not — stated plainly, because a guard you believe in
// and do not have is worse than none:
//
//   bounded   wall-clock time      the child is killed after EXTRACT_TIMEOUT_MS
//   bounded   input size           the artifact route caps the upload at 10mb
//   bounded   page count           MAX_PAGES in ingest/receipts/extract.py, checked BEFORE
//                                  iterating, so a declared-huge page count costs nothing
//   bounded   output size          this module stops reading past MAX_OUTPUT_BYTES and kills
//   NOT       resident memory      a hard RSS cap needs a Job Object on Windows or setrlimit
//                                  on POSIX. Not implemented. The three caps above bound it
//                                  indirectly and the timeout ends anything pathological.

import { spawn } from "node:child_process";
import path from "node:path";

/**
 * How long the extractor may run before it is killed.
 *
 * The four real sample invoices extract in well under a second. 20s is far above anything
 * legitimate and far below anything that makes a person think the app has hung — and it is a
 * ceiling on pathological input, not a performance target.
 */
export const EXTRACT_TIMEOUT_MS = 20_000;

/**
 * How much JSON we will read back.
 *
 * A document whose extracted text is enormous would otherwise be buffered in full on this
 * side — the child is bounded, and then the parent falls over reading its output, which is a
 * guard that protects the wrong process. 64 MB is roughly two orders of magnitude above the
 * largest real statement.
 */
export const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** One page of the document, as `ingest/receipts/extract.py` produced it. */
export type ExtractedPage = {
  index: number;
  width: number;
  height: number;
  /** Linearised text — for DETECTING the template, not for reading data out of. */
  text: string;
  /** Cells are multi-line, and their lines do NOT correspond row-to-row across cells. */
  tables: string[][][];
};

export type ExtractedDocument = {
  page_count: number;
  /** Zero would mean a scan; the extractor rejects that rather than returning it. */
  char_count: number;
  pages: ExtractedPage[];
};

/**
 * Why an extraction produced nothing.
 *
 * The first five come from the child and are DOCUMENT problems. The last three are OUR
 * problems and are worth keeping distinct: "your PDF is a scan" and "Python is not installed"
 * need completely different responses, and a single `error` string makes them look the same.
 */
export type ExtractFailure =
  | "empty" | "not_pdf" | "encrypted" | "malformed" | "too_large" | "no_text"
  | "timeout" | "output_too_large" | "internal";

/** The parsed order, when a parser recognised the template AND the arithmetic reconciled. */
export type ParsedRecord = {
  source_type: string;
  external_ref: string;
  order_date: string | null;
  total_paise: number;
  invoices: { invoice_number: string; seller_name: string | null; invoice_date: string | null; total_paise: number; lines: ParsedLine[] }[];
  payment: { mode: string }[];
  warnings: string[];
};

export type ParsedLine = {
  kind: "goods" | "fee";
  invoice_number: string;
  description: string;
  sku: string | null;
  hsn: string | null;
  qty: number;
  amount_paise: number;
  unit_paise: number | null;
  net_paise: number | null;
  tax_paise: number | null;
  discount_paise: number | null;
};

export type ExtractResult =
  | {
      ok: true;
      document: ExtractedDocument;
      /** Present only when a parser ran AND the reconcile gate passed. */
      record: ParsedRecord | null;
      /** Why no record — a parser refusal, or a reconcile mismatch. */
      parseError: { kind: string; error: string } | null;
    }
  | { ok: false; kind: ExtractFailure; error: string };

/**
 * Where the venv interpreter lives.
 *
 * The path genuinely differs by platform — `Scripts/python.exe` on Windows, `bin/python`
 * elsewhere — and following the Unix one on a Windows machine fails outright. The
 * env override exists so a different environment does not need a code change.
 */
export function pythonBin(): string {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  const root = repoRoot();
  return process.platform === "win32"
    ? path.join(root, "ingest", ".venv", "Scripts", "python.exe")
    : path.join(root, "ingest", ".venv", "bin", "python");
}

export function repoRoot(): string {
  // src/receipts/ -> the repo. The child must run from here for `-m ingest.receipts.cli` to resolve.
  return path.resolve(import.meta.dirname, "../..");
}

/**
 * Extract a PDF by handing its bytes to the Python extractor on stdin.
 *
 * Never throws for a bad document — every outcome is a value, because "this file is a scan"
 * is an answer the caller has to record, not an exception it has to catch.
 */
export function extractPdf(
  bytes: Buffer,
  timeoutMs = EXTRACT_TIMEOUT_MS,
): Promise<ExtractResult> {
  return new Promise((resolve) => {
    // `shell: false` (the default, stated for the reader) and ARRAY arguments. There is no
    // shell to interpret anything, so no quoting or injection question arises — which matters
    // because a filename could otherwise reach a command line. Nothing user-controlled is an
    // argument here at all: the document goes over stdin.
    const child = spawn(pythonBin(), ["-m", "ingest.receipts.cli"], {
      cwd: repoRoot(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const out: Buffer[] = [];
    let outBytes = 0;
    let err = "";
    // One settle, whatever happens. Several of these paths can fire for the same run — a
    // timeout kills the child, which then also emits 'close' — and resolving twice would be a
    // silent bug rather than a loud one.
    let settled = false;
    const finish = (result: ExtractResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        ok: false,
        kind: "timeout",
        error: `extraction exceeded ${timeoutMs}ms and was killed`,
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish({
          ok: false,
          kind: "output_too_large",
          error: `extractor produced more than ${MAX_OUTPUT_BYTES} bytes`,
        });
        return;
      }
      out.push(chunk);
    });

    // Capped too, and for the same reason: a child in a tight error loop can fill this as
    // fast as stdout. Only the tail is worth keeping — the last message is the useful one.
    child.stderr.on("data", (chunk: Buffer) => {
      err = (err + chunk.toString("utf8")).slice(-4000);
    });

    child.on("error", (e) => {
      // Failure to SPAWN — almost always a missing interpreter. Named precisely, because
      // "extraction failed" would send someone looking at their PDF.
      finish({
        ok: false,
        kind: "internal",
        error: `could not start the extractor (${pythonBin()}): ${e.message}`,
      });
    });

    child.on("close", (code) => {
      const raw = Buffer.concat(out).toString("utf8").trim();
      if (raw === "") {
        finish({
          ok: false,
          kind: "internal",
          error: `extractor exited ${code} with no output${err ? `: ${err}` : ""}`,
        });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        finish({ ok: false, kind: "internal", error: "extractor did not return JSON" });
        return;
      }
      const body = parsed as {
        ok?: boolean; kind?: string; error?: string; document?: unknown;
        record?: unknown; parse_error?: { kind: string; error: string } | null;
      };
      if (body.ok === true && body.document) {
        finish({
          ok: true,
          document: body.document as ExtractedDocument,
          // The reconcile gate runs INSIDE the child (shapes.reconcile), so a record that
          // comes back has already been proved to add up. A parse that did not is reported
          // here as parseError and never as a record — there is no third state where we hold
          // a basket we know is wrong.
          record: (body.record as ParsedRecord | null) ?? null,
          parseError: body.parse_error ?? null,
        });
        return;
      }
      finish({
        ok: false,
        // The child's vocabulary is closed and matches ours, but this is a process boundary:
        // trusting it blindly would let a future change introduce a kind nothing handles.
        kind: (body.kind as ExtractFailure) ?? "internal",
        error: body.error ?? `extractor exited ${code}`,
      });
    });

    // EPIPE is EXPECTED here, not exceptional: the child rejects a non-PDF the moment it sees
    // the first bytes and exits, closing the pipe while we are still writing. Unhandled, that
    // is an uncaught 'error' event on the stream and it takes the whole process down.
    child.stdin.on("error", () => { /* the 'close' handler reports what actually happened */ });
    child.stdin.end(bytes);
  });
}
