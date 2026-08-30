// Shared vocabulary for the rules UI: the shapes the API speaks, and the helpers that
// turn them into something readable. No React in here — it is all pure functions and
// types, so any of the rules components can use it without dragging state around.

export type Condition = { field: string; op: string; value: string | number };

export type Rule = {
  id: number;
  name: string;
  conditions: Condition[];
  match_mode: "all" | "any";
  category_id: number | null;
  category_name: string | null;
  priority: number;
  enabled: boolean;
};

export type Category = { id: number; name: string; parent_id: number | null };

// A rule plus what it actually did — from GET /reports/by-rule. `money_paise` is the
// MAGNITUDE it touched; `net_paise` is signed, which is what separates an income rule
// from a spend one when both are in the same list.
export type RuleImpact = Rule & {
  allocations: number;
  transactions: number;
  money_paise: number;
  net_paise: number;
  first_seen: string | null;
  last_seen: string | null;
};

// Mirrors GET /rules/vocabulary. The form renders itself from this rather than a
// hardcoded copy, so adding an op to the backend's rules.ts offers it here with no
// second place to edit.
export type Vocabulary = {
  fields: string[];
  ops: string[];
  match_modes: string[];
  ops_by_field: Record<string, string[]>;
};

export type ApplyResult = {
  examined: number;
  matched: number;
  created: number;
  removed: number;
  unchanged: number;
  skipped_user_locked: number;
};

// A condition as the FORM holds it: the value stays a string while you type, so "1.5"
// and a half-typed "-" are both valid intermediate states. Number(" -") is NaN and would
// fight the user mid-keystroke.
export type Draft = { field: string; op: string; value: string };

export const FIELD_LABEL: Record<string, string> = {
  narration: "Narration",
  amount_paise: "Amount",
  txn_date: "Date",
};

export const OP_LABEL: Record<string, string> = {
  contains: "contains",
  equals: "is exactly",
  lt: "is less than",
  gt: "is more than",
};

export const emptyDraft = (): Draft => ({
  field: "narration",
  op: "contains",
  value: "",
});

// Convert a draft to what the API expects. Rupees become paise HERE, once, at the
// boundary — and Math.round keeps it an integer, because 19.99 * 100 is
// 1998.9999999999998 in floating point and a non-integer would be rejected.
export function toCondition(d: Draft): Condition {
  if (d.field === "amount_paise") {
    return {
      field: d.field,
      op: d.op,
      value: Math.round(parseFloat(d.value || "0") * 100),
    };
  }
  return { field: d.field, op: d.op, value: d.value.trim() };
}

// The inverse, for loading an existing rule into the edit form. It must undo exactly
// what toCondition did: paise back to rupees, everything else to its own text.
//
// `String(value / 100)` and not `toFixed(2)` — toFixed would turn a whole ₹500 into
// "500.00", which is not what the user typed and not what they want to see waiting in
// the box. Both round-trip to the same paise, so neither is wrong; only one is polite.
export function toDraft(c: Condition): Draft {
  if (c.field === "amount_paise") {
    const paise = typeof c.value === "number" ? c.value : Number(c.value);
    return { field: c.field, op: c.op, value: String(paise / 100) };
  }
  return { field: c.field, op: c.op, value: String(c.value) };
}

// Integer paise -> rupee string. Local to this module so `describe` stays pure and does
// not depend on component-land formatting.
function rupeeString(paise: number): string {
  return (paise / 100).toLocaleString("en-IN", {
    style: "currency",
    currency: "INR",
  });
}

// Render a stored condition the way a person would say it.
export function describe(c: Condition): string {
  if (c.field === "amount_paise") {
    const paise = typeof c.value === "number" ? c.value : Number(c.value);
    // A comparison against zero is a SIGN TEST, and "amount is less than ₹0.00" is a
    // baffling way to write "money went out". Say what it means.
    if (paise === 0 && c.op === "lt") return "money out";
    if (paise === 0 && c.op === "gt") return "money in";
    return `amount ${OP_LABEL[c.op] ?? c.op} ${rupeeString(Math.abs(paise))}`;
  }
  if (c.field === "txn_date") return `date ${OP_LABEL[c.op] ?? c.op} ${c.value}`;
  return `narration ${OP_LABEL[c.op] ?? c.op} “${c.value}”`;
}

// How a rule's conditions read as one sentence.
export function describeRule(r: Rule): string {
  return r.conditions.map(describe).join(r.match_mode === "all" ? " and " : " or ");
}
