/**
 * demo-activity.ts — make a freshly seeded demo look like somebody has used it.
 *
 *   npm run demo:activity                       # against http://localhost:3000
 *   BASE=https://khata.vercel.app npm run demo:activity
 *
 * A seeded demo shows two of the three states and not the third. Rules run, so rows are
 * unexplained (nothing matched) or provisional (a rule guessed) — but nothing is ever
 * CONFIRMED, because confirming is a human act. The trend chart then draws two bands and
 * the three-state model, which is the whole point of the product, does not show up in the
 * one picture meant to explain it.
 *
 * So this confirms a deterministic slice, and it does so THROUGH THE REAL ENDPOINTS —
 * POST /rules/apply and POST /transactions/confirm — rather than reproducing their SQL.
 * A seed script with its own copy of "what confirming means" is a second definition that
 * drifts, and this repo has spent enough of its comments on that lesson already.
 *
 * Deterministic, not random: the same seed produces the same demo every time, so a
 * screenshot in the README keeps matching the live site.
 */

const BASE = process.env.BASE ?? "http://localhost:3000";

/** Confirm roughly this share of what the rules guessed. */
const CONFIRM_SHARE = 0.45;

type Txn = { id: string; txn_date: string; allocations: { source: string }[] };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  const text = await res.text();
  let body: unknown = {};
  if (text !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`${path} did not return JSON (${res.status}): ${text.slice(0, 120)}`);
    }
  }
  if (!res.ok) {
    const message = (body as { error?: string }).error ?? `request failed: ${res.status}`;
    throw new Error(`${path}: ${message}`);
  }
  return body as T;
}

async function count(query: string): Promise<number> {
  const { total } = await api<{ total: number }>(`/transactions?${query}&limit=1`);
  return total;
}

async function main() {
  console.log(`target: ${BASE}\n`);

  const applied = await api<Record<string, number>>("/rules/apply", { method: "POST" });
  console.log(`rules applied: ${JSON.stringify(applied)}`);

  const { transactions } = await api<{ transactions: Txn[] }>(
    "/transactions?source=rule&spend_only=true&limit=500",
  );
  if (transactions.length === 0) {
    console.log("\nnothing provisional to confirm — did the seed and the rules both run?");
    return;
  }

  // Oldest first, and take a prefix rather than a sample. Confirming the EARLIER months
  // is what a real user's history looks like — you work through the backlog and the recent
  // weeks are the part you have not got to yet — and it makes the trend chart show the
  // green band shrinking towards the present, which is the story the chart exists to tell.
  const byDate = [...transactions].sort((a, b) => a.txn_date.localeCompare(b.txn_date));
  const take = Math.max(1, Math.floor(byDate.length * CONFIRM_SHARE));
  const ids = byDate.slice(0, take).map((t) => t.id);

  const confirmed = await api<{ confirmed: number; transactions: number }>(
    "/transactions/confirm",
    { method: "POST", body: JSON.stringify({ transaction_ids: ids }) },
  );
  console.log(`confirmed: ${JSON.stringify(confirmed)}`);

  const [unexplained, provisional, user] = await Promise.all([
    count("source=unexplained&spend_only=true"),
    count("source=rule&spend_only=true"),
    count("source=user&spend_only=true"),
  ]);
  console.log(
    `\nthree states now visible:\n` +
      `  unexplained  ${unexplained}\n` +
      `  provisional  ${provisional}\n` +
      `  confirmed    ${user}\n`,
  );
  if (unexplained === 0 || provisional === 0 || user === 0) {
    console.log("one band is still empty — the chart will not show all three colours.\n");
  }
}

main().catch((err) => {
  console.error("\nFAILED: " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
