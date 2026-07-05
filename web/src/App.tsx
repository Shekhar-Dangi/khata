import { useEffect, useState } from "react";
import TransactionList from "./TransactionList";

type Account = {
  id: number;
  name: string;
  bank: string;
  balance_paise: number;
};

function App() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(
    null,
  );

  useEffect(() => {
    async function fetchAccounts() {
      try {
        const res = await fetch("/accounts");
        if (!res.ok) {
          throw new Error(`Request failed : ${res.status}`);
        }
        const data = await res.json();
        const accounts = data.accounts;
        setAccounts(accounts);
      } catch (error: unknown) {
        setError(error instanceof Error ? error.message : "Unknown error");
        console.log(error);
      } finally {
        setLoading(false);
      }
    }
    fetchAccounts();
  }, []);
  return (
    <main>
      <h1>Accounts</h1>
      {loading ? (
        "Loading..."
      ) : error ? (
        error
      ) : (
        <ul>
          {accounts.map((account) => (
            <li key={account.id}>
              <button onClick={() => setSelectedAccountId(account.id)}>
                {account.name} :{" "}
                {(account.balance_paise / 100).toLocaleString("en-IN", {
                  style: "currency",
                  currency: "INR",
                })}
              </button>
            </li>
          ))}
        </ul>
      )}
      {selectedAccountId != null && (
        <TransactionList accountId={selectedAccountId} />
      )}
    </main>
  );
}

export default App;
