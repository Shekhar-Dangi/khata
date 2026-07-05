import { useEffect, useState } from "react";

type Transaction = {
  id: string;
  txn_date: string;
  txn_time: string | null;
  amount_paise: number;
  type: string;
  narration: string | null;
  counterparty_account_id: string | null;
  transfer_status: string | null;
  bank_balance_paise: number | null;
};

export default function TransactionList({ accountId }: { accountId: number }) {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Reset to loading whenever the account changes — this instance is reused
    // across account switches, so without this the previous account's rows
    // would linger on screen until the new fetch lands.
    setLoading(true);
    setError(null);

    async function fetchTransactions() {
      try {
        const res = await fetch(`/accounts/${accountId}/transactions`);
        if (!res.ok) {
          throw new Error(`Request failed : ${res.status}`);
        }
        const data = await res.json();
        setTransactions(data.transactions);
      } catch (error: unknown) {
        setError(error instanceof Error ? error.message : "Unknown error");
        console.log(error);
      } finally {
        setLoading(false);
      }
    }
    fetchTransactions();
  }, [accountId]);

  if (loading) return "Loading...";
  if (error) return error;
  return (
    <ul>
      {transactions.map((transaction) => (
        <li key={transaction.id}>
          {transaction.id} : {transaction.amount_paise}
        </li>
      ))}
    </ul>
  );
}
