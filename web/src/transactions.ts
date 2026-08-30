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
