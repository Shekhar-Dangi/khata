import { useState } from "react";

import AccountsView from "./AccountsView";
import ConsolidatedView from "./ConsolidatedView";
import TransfersView from "./TransfersView";
import AnomaliesView from "./AnomaliesView";

type View = "accounts" | "transactions" | "transfers" | "anomalies";

const TABS: { key: View; label: string }[] = [
  { key: "accounts", label: "Accounts" },
  { key: "transactions", label: "All transactions" },
  { key: "transfers", label: "Internal transfers" },
  { key: "anomalies", label: "Anomalies" },
];

function App() {
  const [view, setView] = useState<View>("accounts");

  return (
    <main>
      <h1>Finance reconciler</h1>
      <nav>
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setView(t.key)}
            disabled={view === t.key}
          >
            {t.label}
          </button>
        ))}
      </nav>
      {view === "accounts" && <AccountsView />}
      {view === "transactions" && <ConsolidatedView />}
      {view === "transfers" && <TransfersView />}
      {view === "anomalies" && <AnomaliesView />}
    </main>
  );
}

export default App;
