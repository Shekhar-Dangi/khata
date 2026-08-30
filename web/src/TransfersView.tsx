import { useEffect, useState } from "react";

import { useBusy, useFetch } from "./useFetch";
import { useLedgerVersion } from "./ledgerVersion";
import { rupees } from "./format";
import Pager from "./Pager";
import AccountIdentifiers from "./AccountIdentifiers";

type Leg = {
  id: string;
  account_id: number;
  account_name: string;
  txn_date: string;
  amount_paise: number;
  narration: string | null;
  transfer_status: string | null;
  counterparty_name: string | null;
};
type Group = {
  key: string;
  transfer_group_id: number | null;
  status: string | null;
  /** WHY this link exists: 'reference:<rrn>' | 'keyword:<kw>' | 'amount+date' | 'confirmed'. */
  evidence: string | null;
  txn_date: string;
  amount_paise: number;
  legs: Leg[];
};
type TransfersResponse = {
  groups: Group[];
  total: number;
  limit: number;
  offset: number;
  counts: Record<string, number>;
};
type DetectResult = {
  accounts: number;
  resolved: number;
  pending: number;
  suspected: number;
  by_reference: number;
  by_keyword: number;
};

// Turn the stored evidence string into something a person would say.
//
// The reference is shown IN FULL, not summarised away. It is the whole justification for
// having moved this money out of your spending without asking, and it is checkable - that
// number is printed on both statements.
function explainEvidence(evidence: string | null): { label: string; detail?: string } {
  if (evidence === null) return { label: "linked" };
  if (evidence.startsWith("reference:")) {
    return { label: "same UPI reference", detail: evidence.slice("reference:".length) };
  }
  if (evidence.startsWith("keyword:")) {
    return {
      label: "narration names your account",
      detail: evidence.slice("keyword:".length),
    };
  }
  if (evidence === "confirmed") return { label: "you confirmed this" };
  if (evidence === "amount+date") return { label: "same amount, same days" };
  return { label: evidence };
}

const PAGE = 10;

const TABS = [
  { key: "suspected", label: "To review" },
  { key: "resolved", label: "Confirmed" },
  { key: "pending", label: "Waiting for the other sheet" },
  { key: "rejected", label: "Not a transfer" },
];

// Internal transfers: your own money moving between your own accounts.
//
// It is the single biggest distortion in this app's headline number. A ₹40,000 credit
// card payment is one debit on the bank and one credit on the card, and until the two
// are linked BOTH are counted — so the same money is reported as spending twice, and
// "money out" reads far higher than anything you actually spent.
//
// Detection decides ONLY where the bank already did. When both legs quote the same UPI
// reference, that is the bank's own statement that the two rows are one payment, so the
// pair resolves without asking. Everything weaker proposes: a pair matched on amount and
// date alone is written `suspected` and stays INSIDE spend until you confirm it, because
// silently hiding money on a coincidence is the exact failure this tool exists to prevent.
//
// Every link records WHY, and every link can be undone. An automatic classification
// nobody can interrogate or reverse is worse than no classification.
export default function TransfersView() {
  const [tab, setTab] = useState("suspected");
  const [offset, setOffset] = useState(0);
  const [showIds, setShowIds] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [result, setResult] = useState<DetectResult | null>(null);
  const { version, bump } = useLedgerVersion();

  const { data, loading, error, refetch, refreshing, isStale } =
    useFetch<TransfersResponse>(
      `/transfers?status=${tab}&limit=${PAGE}&offset=${offset}`,
      { keepPreviousData: true, revalidateOn: version },
    );
  const busy = useBusy(refreshing);

  // Page 3 of "to review" is not page 3 of "confirmed"; staying there would show an
  // empty list on a tab that has rows.
  useEffect(() => {
    setOffset(0);
  }, [tab]);

  async function detect() {
    setDetecting(true);
    try {
      const res = await fetch("/transfers/detect", { method: "POST" });
      const body = await res.json();
      setResult(body as DetectResult);
      setTab("suspected");
      setOffset(0);
      await refetch();
    } finally {
      setDetecting(false);
    }
  }

  // Confirming moves both legs out of spend, so every number on the ledger changes —
  // that is a ledger mutation, not a change to this list.
  async function decide(groupId: number, verdict: "confirm" | "reject") {
    await fetch(`/transfers/${groupId}/${verdict}`, { method: "POST" });
    await refetch();
    bump();
  }

  async function unlink(txnId: string) {
    await fetch(`/transactions/${txnId}/unlink-transfer`, { method: "POST" });
    await refetch();
    bump();
  }

  if (loading) return <p className="soft">Loading…</p>;
  if (error) return <p className="soft">{error}</p>;

  const counts = data?.counts ?? {};
  const groups = data?.groups ?? [];
  const total = data?.total ?? 0;
  const toReview = counts.suspected ?? 0;

  return (
    <>
      <div className="rules-head">
        <h2>Internal transfers</h2>
        <p className="soft rules-intro">
          Your own money moving between your own accounts, counted twice — once on each
          statement. Pairs sharing a UPI reference are linked for you; weaker guesses wait
          for you. Every link says why, and can be undone.
        </p>
        <div className="head-actions">
          <button className="btn" onClick={detect} disabled={detecting}>
            {detecting ? "Looking…" : "Find transfers"}
          </button>
          <button className="btn-ghost" onClick={() => setShowIds((v) => !v)}>
            {showIds ? "Hide account identifiers" : "Account identifiers"}
          </button>
        </div>
      </div>

      {/* Its own line. Wedged into the button row it re-flowed the buttons the moment it
          appeared, so pressing "Find transfers" moved the thing you had just pressed. */}
      {result && (
        <p className="note ok">
          {result.by_reference > 0
            ? `Linked ${result.by_reference} pair${result.by_reference === 1 ? "" : "s"} on a shared UPI reference.`
            : "Nothing new to link on a UPI reference."}
          {result.suspected > 0 &&
            ` ${result.suspected} more to review below.`}
          {result.pending > 0 &&
            ` ${result.pending} waiting for the other statement.`}
        </p>
      )}

      {showIds && <AccountIdentifiers onChanged={refetch} />}

      {toReview > 0 && tab !== "suspected" && (
        <p className="note">
          {toReview} pair{toReview === 1 ? "" : "s"} still waiting on you. Until you
          confirm them they count as spending.
        </p>
      )}

      <div className="tf-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className="tf-tab"
            aria-current={tab === t.key}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            <b>{counts[t.key] ?? 0}</b>
          </button>
        ))}
      </div>

      <div className={"busybar" + (busy ? " on" : "")} aria-hidden="true">
        <i />
      </div>

      <div className={busy || isStale ? "is-stale" : undefined}>
        {groups.length === 0 ? (
          <p className="soft" style={{ padding: "0 10px" }}>
            {tab === "suspected"
              ? "Nothing to review. Press “Find transfers” to look again."
              : "Nothing here yet."}
          </p>
        ) : (
          groups.map((g) => (
            <TransferPair key={g.key} group={g} onDecide={decide} onUnlink={unlink} />
          ))
        )}
      </div>

      <Pager
        offset={offset}
        limit={PAGE}
        total={total}
        shown={groups.length}
        onOffset={setOffset}
        unit="transfers"
        busy={busy}
      />
    </>
  );
}

// One proposal or one linked pair, drawn as a single card.
//
// A table would put the two legs on adjacent rows and leave "are these the same money?"
// entirely to the reader. The question this screen asks is about a PAIR, so the pair is
// the thing on the page.
function TransferPair({
  group,
  onDecide,
  onUnlink,
}: {
  group: Group;
  onDecide: (groupId: number, verdict: "confirm" | "reject") => void;
  onUnlink: (txnId: string) => void;
}) {
  const canDecide = group.status === "suspected" && group.transfer_group_id !== null;
  const paired = group.legs.length > 1;
  const why = explainEvidence(group.evidence);

  return (
    <div className="pair">
      <div className="pair-head">
        <span className="pair-amount mono">{rupees(group.amount_paise)}</span>
        <span className="pair-when">
          <span className="soft mono">{group.txn_date}</span>
          {!paired && (
            <span
              className="pill"
              title="The other account's statement is not imported yet."
            >
              no partner leg
            </span>
          )}
          {/* Why this pair is on the screen. On a resolved row it is the justification for
              a decision nobody was asked about, so it is stated on the card rather than
              hidden behind a tooltip. */}
          <span className="pair-why soft">
            {why.label}
            {why.detail !== undefined && <b className="mono">{why.detail}</b>}
          </span>
        </span>
        <span className="pair-actions">
          {canDecide ? (
            <>
              <button
                className="btn"
                onClick={() => onDecide(group.transfer_group_id!, "confirm")}
              >
                Yes, same money
              </button>
              <button
                className="link-btn danger"
                onClick={() => onDecide(group.transfer_group_id!, "reject")}
              >
                Not a transfer
              </button>
            </>
          ) : (
            <button
              className="link-btn"
              title="Put these back in spending and forget the link"
              onClick={() => onUnlink(group.legs[0]!.id)}
            >
              Undo
            </button>
          )}
        </span>
      </div>
      {group.legs.map((l) => (
        <div className="pair-leg" key={l.id}>
          <span className="mono soft">{l.txn_date}</span>
          <span>{l.account_name}</span>
          <span className="pair-narration soft" title={l.narration ?? ""}>
            {l.narration}
          </span>
          <span className={"mono r " + (l.amount_paise < 0 ? "debit" : "credit")}>
            {rupees(l.amount_paise)}
          </span>
        </div>
      ))}
    </div>
  );
}
