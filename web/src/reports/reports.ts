// Types and date maths for the reports page. No React — pure functions and shapes.

export type CategoryRow = {
  category_id: number;
  category_name: string;
  parent_id: number | null;
  parent_name: string | null;
  confirmed_paise: number;
  provisional_paise: number;
  evidence_paise: number;
  total_paise: number;
  transactions: number;
};

export type CategoryReport = {
  categories: CategoryRow[];
  out_paise: number;
  in_paise: number;
  unexplained_paise: number;
  /** Unexplained split by direction, so the tiles can share one universe. */
  unexplained_out_paise: number;
  unexplained_in_paise: number;
  transactions: number;
};

/** GET /reports/consumption — see ConsumedView and src/consumption.ts. */
export type ConsumptionTerms = {
  money_out_paise: number;
  unexplained_paise: number;
  fronted_paise: number;
  paid_for_you_paise: number;
  received_paise: number;
  consumed_paise: number;
};

export type Consumption = {
  categories: {
    id: number;
    name: string;
    parent_name: string | null;
    consumed_paise: number;
    entries: number;
  }[];
  terms: ConsumptionTerms;
  unaccounted_paise: number;
  unclassified_paise: number;
};

export type Period = { from: string; to: string; label: string };

// ── date maths on YYYY-MM-DD strings ────────────────────────────────────────
// Everything goes through Date.UTC rather than the local-time constructor. `new
// Date("2026-03-01")` is parsed as UTC midnight but READ back in local time, so in
// IST (UTC+5:30) .getDate() returns the 1st — but west of Greenwich it returns the
// 28th of the previous month. Building ranges that way silently drops a day for half
// the world. Working in UTC throughout removes the question.

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function utc(y: number, m: number, day: number): Date {
  return new Date(Date.UTC(y, m, day));
}

function parse(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split("-").map(Number);
  return { y: y!, m: m! - 1, d: d! };
}

export function startOfMonth(iso: string): string {
  const { y, m } = parse(iso);
  return toIso(utc(y, m, 1));
}

export function endOfMonth(iso: string): string {
  const { y, m } = parse(iso);
  return toIso(utc(y, m + 1, 0)); // day 0 of the next month = last day of this one
}

export function addMonths(iso: string, n: number): string {
  const { y, m, d } = parse(iso);
  return toIso(utc(y, m + n, d));
}

export function addDays(iso: string, n: number): string {
  const { y, m, d } = parse(iso);
  return toIso(utc(y, m, d + n));
}

export function daysBetween(from: string, to: string): number {
  const a = parse(from);
  const b = parse(to);
  return Math.round(
    (utc(b.y, b.m, b.d).getTime() - utc(a.y, a.m, a.d).getTime()) / 86400000,
  );
}

export function monthLabel(iso: string): string {
  const { y, m } = parse(iso);
  return utc(y, m, 1).toLocaleDateString("en-IN", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

// The period the page opens on, and the presets. `today` is injected so this stays a
// pure function — a helper that reads the clock itself cannot be reasoned about.
export function presets(today: string): Period[] {
  const thisMonthStart = startOfMonth(today);
  const lastMonthStart = addMonths(thisMonthStart, -1);
  return [
    { from: thisMonthStart, to: today, label: "This month" },
    {
      from: lastMonthStart,
      to: endOfMonth(lastMonthStart),
      label: "Last month",
    },
    { from: addMonths(thisMonthStart, -2), to: today, label: "Last 3 months" },
    { from: `${parse(today).y}-01-01`, to: today, label: "This year" },
    { from: "", to: "", label: "All time" },
  ];
}

// The equal-length window immediately before this one — what "compare with the previous
// period" means. Length is preserved rather than snapping to a calendar month, so
// comparing 12 days compares against the 12 days before, not against a whole month.
export function previousPeriod(p: Period): Period | null {
  if (p.from === "" || p.to === "") return null; // "all time" has no predecessor
  const span = daysBetween(p.from, p.to); // inclusive range => span + 1 days
  const to = addDays(p.from, -1);
  const from = addDays(to, -span);
  return { from, to, label: "previous" };
}

// A percentage change that refuses to invent one. Going from nothing to something is not
// "+∞%" or "+100%" — it is a new thing, and saying so is more honest than a number.
export function pctChange(now: number, before: number): number | null {
  if (before === 0) return null;
  return ((Math.abs(now) - Math.abs(before)) / Math.abs(before)) * 100;
}

// Mirrors GET /reports/by-month. The three states sum to out_paise exactly, every month —
// that is the endpoint's own invariant and what makes a stacked column honest rather than
// decorative.
export type MonthRow = {
  month: string; // "YYYY-MM"
  out_paise: number;
  provisional_paise: number;
  confirmed_paise: number;
  unexplained_paise: number;
  transactions: number;
};
