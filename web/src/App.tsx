import { useState } from "react";

import Summary from "./shared/Summary";
import DemoBanner from "./shared/DemoBanner";
import { LedgerVersionProvider } from "./shared/ledgerVersion";
import ConsolidatedView from "./ledger/ConsolidatedView";
import TransfersView from "./transfers/TransfersView";
import AnomaliesView from "./anomalies/AnomaliesView";
import RulesView from "./rules/RulesView";
import ReportsView from "./reports/ReportsView";
import CategoriesView from "./categories/CategoriesView";
import ItemsView from "./items/ItemsView";
import SourcesView from "./sources/SourcesView";
import { ReadingCount } from "./sources/ModelReadPanel";

type View =
  | "transactions"
  | "reports"
  | "transfers"
  | "rules"
  | "categories"
  | "products"
  | "sources"
  | "anomalies";

const TABS: { key: View; label: string }[] = [
  { key: "transactions", label: "Transactions" },
  { key: "reports", label: "Where it goes" },
  { key: "transfers", label: "Internal transfers" },
  { key: "rules", label: "Rules" },
  { key: "categories", label: "Categories" },
  // Products sits beside Categories because it is the same kind of thing — a vocabulary you
  // maintain — and immediately before Sources, which is where the rows in it come from.
  { key: "products", label: "Products" },
  // Rules, Categories and Sources are the machinery that adds meaning; Anomalies stays
  // last because it is the integrity check, not another place to configure something.
  { key: "sources", label: "Sources" },
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
      <DemoBanner />
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
                {t.key === "sources" && <ReadingCount />}
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
          {view === "products" && <ItemsView />}
          {view === "sources" && <SourcesView />}
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
