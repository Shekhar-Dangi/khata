import { useState } from "react";

import Summary from "./Summary";
import { LedgerVersionProvider } from "./ledgerVersion";
import ConsolidatedView from "./ConsolidatedView";
import TransfersView from "./TransfersView";
import AnomaliesView from "./AnomaliesView";
import RulesView from "./RulesView";
import ReportsView from "./ReportsView";
import CategoriesView from "./CategoriesView";

type View =
  | "transactions"
  | "reports"
  | "transfers"
  | "rules"
  | "categories"
  | "anomalies";

const TABS: { key: View; label: string }[] = [
  { key: "transactions", label: "Transactions" },
  { key: "reports", label: "Where it goes" },
  { key: "transfers", label: "Internal transfers" },
  { key: "rules", label: "Rules" },
  { key: "categories", label: "Categories" },
  { key: "anomalies", label: "Anomalies" },
];

function App() {
  const [view, setView] = useState<View>("transactions");

  // The summary answers "what can't I explain / how much do I have". That belongs on the
  // ledger now that the ledger IS the home page — it is where you arrive and where you
  // explain things, so the number you are moving should be in front of you.
  const showSummary =
    view === "transactions" || view === "anomalies" || view === "rules";

  return (
    <LedgerVersionProvider>
      <div className="topbar">
        <div className="shell">
          <div>
            <span className="wordmark">Khata</span>
            <span className="tagline">money, explained.</span>
          </div>
          <nav>
            {TABS.map((t) => (
              <button
                key={t.key}
                aria-current={view === t.key}
                onClick={() => setView(t.key)}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </div>
      </div>

      {showSummary && <Summary />}

      <main>
        <div className="shell">
          {/* key={view} remounts this subtree on tab change -> the CSS reveal replays */}
          <div className="view" key={view}>
            {view === "transactions" && <ConsolidatedView />}
            {view === "transfers" && <TransfersView />}
            {view === "reports" && <ReportsView />}
            {view === "rules" && <RulesView />}
            {view === "categories" && <CategoriesView />}
            {view === "anomalies" && <AnomaliesView />}
          </div>
        </div>
      </main>

      <footer>
        <div className="shell">local-first · your data never leaves this device</div>
      </footer>
    </LedgerVersionProvider>
  );
}

export default App;
