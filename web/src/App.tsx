import { useState } from "react";

import Summary from "./Summary";
import AccountsView from "./AccountsView";
import ConsolidatedView from "./ConsolidatedView";
import TransfersView from "./TransfersView";
import AnomaliesView from "./AnomaliesView";
import RulesView from "./RulesView";
import ReportsView from "./ReportsView";

type View =
  | "accounts"
  | "transactions"
  | "reports"
  | "transfers"
  | "rules"
  | "anomalies";

const TABS: { key: View; label: string }[] = [
  { key: "accounts", label: "Accounts" },
  { key: "transactions", label: "All transactions" },
  { key: "reports", label: "Where it goes" },
  { key: "transfers", label: "Internal transfers" },
  { key: "rules", label: "Rules" },
  { key: "anomalies", label: "Anomalies" },
];

function App() {
  const [view, setView] = useState<View>("accounts");

  // The summary answers "what can't I explain / how much do I have" — irrelevant on the
  // pure-ledger views, so it's hidden there (design-brief deviation #1).
  const showSummary =
    view === "accounts" || view === "anomalies" || view === "rules";

  return (
    <>
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
            {view === "accounts" && <AccountsView />}
            {view === "transactions" && <ConsolidatedView />}
            {view === "transfers" && <TransfersView />}
            {view === "reports" && <ReportsView />}
            {view === "rules" && <RulesView />}
            {view === "anomalies" && <AnomaliesView />}
          </div>
        </div>
      </main>

      <footer>
        <div className="shell">local-first · your data never leaves this device</div>
      </footer>
    </>
  );
}

export default App;
