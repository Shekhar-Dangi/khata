import { useState } from "react";

import TransactionList from "./TransactionList";
import { useFetch } from "./useFetch";
import { rupees } from "./format";

type Account = { id: number; name: string; bank: string; balance_paise: number };

const BANK_META: Record<string, string> = {
  hdfc: "savings",
  indian_bank: "savings",
  slice: "credit line",
};

// Accounts list; click a row to expand its transactions (the drill-in).
export default function AccountsView() {
  const { data, loading, error } = useFetch<{ accounts: Account[] }>("/accounts");
  const [expandedId, setExpandedId] = useState<number | null>(null);

  if (loading) return <p className="soft">Loading…</p>;
  if (error) return <p className="soft">{error}</p>;
  if (!data) return null;

  return (
    <div>
      {data.accounts.map((a) => (
        <div key={a.id}>
          <button
            className="acct"
            aria-expanded={expandedId === a.id}
            onClick={() => setExpandedId(expandedId === a.id ? null : a.id)}
          >
            <div>
              <span className="nm">{a.name}</span>
              <span className="meta">{BANK_META[a.bank] ?? a.bank}</span>
            </div>
            <span className={"bal" + (a.balance_paise < 0 ? " debit" : "")}>
              {rupees(a.balance_paise)}
            </span>
          </button>
          {expandedId === a.id && (
            <div className="drill">
              <TransactionList accountId={a.id} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
