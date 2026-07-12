import { useState } from "react";

import TransactionList from "./TransactionList";
import { useFetch } from "./useFetch";
import { rupees } from "./format";

type Account = { id: number; name: string; bank: string; balance_paise: number };

export default function AccountsView() {
  const { data, loading, error } = useFetch<{ accounts: Account[] }>("/accounts");
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);

  if (loading) return <p>Loading…</p>;
  if (error) return <p>{error}</p>;
  if (!data) return null;

  return (
    <div>
      <ul>
        {data.accounts.map((a) => (
          <li key={a.id}>
            <button onClick={() => setSelectedAccountId(a.id)}>
              {a.name} : {rupees(a.balance_paise)}
            </button>
          </li>
        ))}
      </ul>
      {selectedAccountId != null && <TransactionList accountId={selectedAccountId} />}
    </div>
  );
}
