// The artifact store: the bytes a person uploaded, kept BEFORE anything tries to read them.
//
// the design/the design both make this slice 1 of invoice ingestion, for
// one reason: a parser bug must cost a re-run, not the document. A Splitwise CSV is
// re-downloadable in ten seconds; a Blinkit invoice is exposed per order and never in bulk, so
// losing it loses the order.
//
// The pure half (`sha256Hex`, `sniffMime`, `isTextual`) has no database and no clock, and is
// where the tests live — same split as rules.ts / transfers.ts, and for the same reason: this
// is the code that decides which parser sees a file, and getting that wrong corrupts data
// silently rather than loudly.

import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

/**
 * Content hash of an upload, lowercase hex.
 *
 * sha256 rather than md5 or a cheap non-cryptographic hash, and the reason is not ceremony:
 * this hash is the key of a UNIQUE index that decides "we already have this file". A
 * collision would therefore make one document silently masquerade as another and skip its
 * own import. md5 collisions are constructible on a laptop; sha256's are not.
 */
export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Magic numbers: the first few bytes a format is REQUIRED to begin with. This is what
// `file(1)` does, and it is the only self-describing thing about an upload.
const PDF_MAGIC = Buffer.from("%PDF-", "ascii");
// xlsx, docx and every other OOXML file is a ZIP archive, so they share this signature.
// Telling them apart means reading the archive directory, which is a parser's job, not a
// sniffer's.
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** Mime types whose bytes are meant to be decoded to a string before anything reads them. */
export const TEXTUAL_MIMES = new Set(["text/plain"]);

function startsWith(bytes: Buffer, magic: Buffer): boolean {
  return bytes.length >= magic.length && bytes.subarray(0, magic.length).equals(magic);
}

/**
 * Does this look like text we can safely decode as UTF-8?
 *
 * Strict decoding, over the WHOLE buffer, rather than a heuristic over a sample. `fatal: true`
 * makes TextDecoder throw on any invalid sequence instead of substituting U+FFFD — and
 * substitution is precisely the failure we are trying to detect, because it is silent and
 * irreversible.
 *
 * A sample would be cheaper and wrong: binary rubbish very often begins with a plausible ASCII
 * header, and a multi-byte character straddling the sample boundary would fail a valid file.
 * At upload sizes this costs microseconds.
 */
export function isTextual(bytes: Buffer): boolean {
  // A NUL byte is the oldest and most reliable binary marker: no text encoding this app will
  // ever see produces one, and several binary formats are full of them. Checked first because
  // it is a fast reject.
  if (bytes.includes(0x00)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * What kind of file is this, decided from the BYTES.
 *
 * Never from the `Content-Type` header and never from the filename, both of which are
 * client-controlled and routinely wrong: curl sends a form content-type unless told
 * otherwise, browsers send whatever the page set, and a file renamed on the way out of a
 * phone carries no truth at all. the design already applies this rule to choosing a
 * PARSER; this is the same rule one level down, choosing whether the bytes may be turned into
 * a string at all.
 *
 * `application/octet-stream` is the honest answer for "recognised nothing", and it is a real
 * answer: such an artifact is stored and listed for review rather than guessed at.
 */
export function sniffMime(bytes: Buffer): string {
  if (startsWith(bytes, PDF_MAGIC)) return "application/pdf";
  if (startsWith(bytes, ZIP_MAGIC)) return "application/zip";
  if (isTextual(bytes)) return "text/plain";
  return "application/octet-stream";
}

export type ParseStatus = "pending" | "parsed" | "unsupported" | "failed";

export type StoredArtifact = {
  id: string;
  contentHash: string;
  mime: string;
  byteSize: number;
  parseStatus: ParseStatus;
  /** True when these exact bytes were already in the store before this call. */
  duplicate: boolean;
};

/**
 * Put the bytes in the store, or find the row that already holds them.
 *
 * Written as INSERT ... ON CONFLICT DO NOTHING and then a SELECT, rather than SELECT-then-
 * INSERT. the design is explicit about why: a dedupe implemented as SELECT-then-INSERT
 * is a race and a lie, because two callers can both see "absent" and both insert. Here the
 * UNIQUE index is the thing that decides, and the SELECT only reports what it decided.
 *
 * The row is written with `parse_status = 'pending'` and `source_type = NULL` DELIBERATELY:
 * storing happens before detection, which is the entire point of the store. Anything that
 * knows more updates it afterwards through `setParseStatus`.
 */
export async function storeArtifact(
  client: PoolClient,
  input: { bytes: Buffer; mime: string; originalName?: string | null },
): Promise<StoredArtifact> {
  const contentHash = sha256Hex(input.bytes);

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO artifacts (content_hash, bytes, byte_size, mime, original_name)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (content_hash) DO NOTHING
     RETURNING id`,
    [contentHash, input.bytes, input.bytes.length, input.mime, input.originalName ?? null],
  );

  if (inserted.rowCount === 1) {
    return {
      id: inserted.rows[0].id,
      contentHash,
      mime: input.mime,
      byteSize: input.bytes.length,
      parseStatus: "pending",
      duplicate: false,
    };
  }

  // Conflict: the same bytes are already here. Report the EXISTING row's state rather than
  // the state we would have written — a caller's next decision depends on whether the stored
  // copy was ever successfully parsed.
  const existing = await client.query<{
    id: string; mime: string; byte_size: number; parse_status: ParseStatus;
  }>(
    "SELECT id, mime, byte_size, parse_status FROM artifacts WHERE content_hash = $1",
    [contentHash],
  );
  const row = existing.rows[0];
  return {
    id: row.id,
    contentHash,
    mime: row.mime,
    byteSize: row.byte_size,
    parseStatus: row.parse_status,
    duplicate: true,
  };
}

/**
 * Record what happened when something tried to read this artifact.
 *
 * `parsed_at` is set for every terminal state, not just success: "when did we last try" is
 * the question a re-run asks, and a NULL there would make a failure indistinguishable from a
 * file nothing has looked at yet.
 */
export async function setParseStatus(
  client: PoolClient,
  id: string,
  status: ParseStatus,
  detail: { sourceType?: string | null; externalRef?: string | null; error?: string | null } = {},
): Promise<void> {
  await client.query(
    `UPDATE artifacts
        SET parse_status = $2,
            source_type  = COALESCE($3, source_type),
            external_ref = COALESCE($4, external_ref),
            parse_error  = $5,
            parsed_at    = CASE WHEN $2 = 'pending' THEN NULL ELSE now() END
      WHERE id = $1`,
    [id, status, detail.sourceType ?? null, detail.externalRef ?? null, detail.error ?? null],
  );
}

export type ArtifactListRow = {
  id: string;
  content_hash: string;
  mime: string;
  byte_size: number;
  original_name: string | null;
  source_type: string | null;
  parse_status: ParseStatus;
  parse_error: string | null;
  external_ref: string | null;
  created_at: string;
};

/**
 * The stored artifacts, newest first — WITHOUT their bytes.
 *
 * `bytes` is excluded from the column list on purpose. Postgres keeps a large BYTEA out of
 * line in TOAST storage, so selecting it costs an extra read per row; a listing that wants a
 * filename and a status has no reason to pay that, or to move megabytes through the driver.
 */
export async function listArtifacts(
  client: PoolClient,
  opts: { status?: ParseStatus; limit: number; offset: number },
): Promise<{ rows: ArtifactListRow[]; total: number }> {
  const where = opts.status ? "WHERE parse_status = $3" : "";
  const params: unknown[] = [opts.limit, opts.offset];
  if (opts.status) params.push(opts.status);

  const rows = await client.query<ArtifactListRow>(
    `SELECT id, content_hash, mime, byte_size, original_name, source_type,
            parse_status, parse_error, external_ref, created_at
       FROM artifacts ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT $1 OFFSET $2`,
    params,
  );
  const total = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM artifacts ${opts.status ? "WHERE parse_status = $1" : ""}`,
    opts.status ? [opts.status] : [],
  );
  return { rows: rows.rows, total: Number(total.rows[0].count) };
}
