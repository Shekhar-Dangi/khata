// The shape GET /transactions returns, in one place.
//
// It used to be declared twice: the ledger typed the whole row, and the drill-down typed
// a four-field subset called TouchedTxn. Same endpoint, same payload — the subset was not
// a smaller response, just a smaller belief about one. That is why the drill-down could
// not show whether a transaction was explained: the fields were always there, the type
// simply said they weren't.
export type Allocation = {
  amount_paise: number;
  category_id: number;
  category_name: string;
  source: "rule" | "user" | "evidence";
};

export type Txn = {
  id: string;
  account_name: string;
  txn_date: string;
  amount_paise: number;
  type: string;
  transfer_status: string | null;
  narration: string | null;
  explained_paise: number;
  unexplained_paise: number;
  allocations: Allocation[];
};

export type TransactionsResponse = { transactions: Txn[]; total: number };

export type Category = { id: number; name: string; parent_id: number | null };

// Both halves matter. `type` is what the IMPORT said; `transfer_status` is what detection
// later confirmed, and confirmation is the only one of the two a real bank statement ever
// produces — no bank labels a row "transfer" for you.
export function isTransfer(t: Txn): boolean {
  return t.type === "transfer" || t.transfer_status === "resolved";
}

// ── the three-state vocabulary, in one place ──────────────────────────────────
//
// The same three states were named three different ways: the ledger said "Money you
// can't explain yet" / "Explained by a rule, unconfirmed" / "explained", the reports
// page said "Can't explain yet" / "A rule guessed" / "You confirmed", and the table cell
// said "explain" / "left" / "explained". The three-state model is the idea this product
// is built on; naming it differently on every screen is how a sharp idea reads as a
// vague one.
//
// One noun each. The hero line on the summary strip stays a SENTENCE ("Money you can't
// explain yet") — that is prose, not a state name, and it is allowed to be warmer.
export const STATE = {
  unexplained: "Unexplained",
  rule: "Guessed",
  user: "Confirmed",
} as const;

export type StateKey = keyof typeof STATE;

/** The filter values `source=` accepts, in the order the dropdown offers them. */
export const STATE_KEYS: StateKey[] = ["unexplained", "rule", "user"];
