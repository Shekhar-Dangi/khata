import { useState } from "react";

import Summary from "./shared/Summary";
import { LedgerVersionProvider } from "./shared/ledgerVersion";
import ConsolidatedView from "./ledger/ConsolidatedView";
import TransfersView from "./transfers/TransfersView";
import AnomaliesView from "./anomalies/AnomaliesView";
import RulesView from "./rules/RulesView";
import ReportsView from "./reports/ReportsView";
import CategoriesView from "./categories/CategoriesView";

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

  // The summary answers "what can't I explain / how much do I have" — the question the
  // product exists for. It used to render on three of the six tabs, which moved the
  // whole page up or down by ~200px on every switch between a tab that had it and one
  // that did not; a navigation should not read as a reload. It is slimmer now (see
  // .summary in index.css) precisely so it can afford to be permanent.

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

      <Summary />

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
