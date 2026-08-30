import { useState } from "react";

import { useFetch } from "./useFetch";

type Account = { id: number; name: string };
type Keyword = {
  id: number;
  account_id: number;
  account_name: string;
  keyword: string;
  kind: string;
};

const KINDS = [
  { value: "account_number", label: "account number" },
  { value: "upi_handle", label: "UPI handle" },
  { value: "name", label: "name" },
];

// The inputs detection actually runs on.
//
// This screen exists because the feature underneath it was unreachable. Detection's
// strong pass scans a narration for the account NUMBER or UPI HANDLE of your other
// accounts — and there was no way, anywhere in the app, to tell it what those are. So
// `account_keywords` stayed empty, the strong pass matched nothing, and every rupee you
// moved between your own accounts was counted as spending on both legs.
//
// `name` is accepted and stored but deliberately NOT used to auto-resolve: your own name
// appears in half the narrations on a statement, and a weak signal that moves money out
// of the spend column is worse than no signal.
export default function AccountIdentifiers({ onChanged }: { onChanged: () => void }) {
  const accounts = useFetch<{ accounts: Account[] }>("/accounts");
  const keywords = useFetch<{ keywords: Keyword[] }>("/keywords");

  if (keywords.loading || accounts.loading) return <p className="soft">Loading…</p>;
  if (keywords.error) return <p className="soft">{keywords.error}</p>;

  const all = keywords.data?.keywords ?? [];

  async function reload() {
    await keywords.refetch();
    onChanged();
  }

  return (
    <div>
      <p className="soft rules-intro">
        Detection reads these out of the other account's narration. An account number or
        UPI handle is enough to link two legs automatically; a name is stored but never
        used on its own, because your own name appears on half the rows of a statement.
      </p>
      {(accounts.data?.accounts ?? []).map((a) => (
        <AccountRow
          key={a.id}
          account={a}
          keywords={all.filter((k) => k.account_id === a.id)}
          onChanged={reload}
        />
      ))}
    </div>
  );
}

// One account's identifiers, with its own draft state. Split out for the same reason
// RuleForm was: the draft lives beside the input that edits it, so typing here does not
// re-render the other accounts' lists.
function AccountRow({
  account,
  keywords,
  onChanged,
}: {
  account: Account;
  keywords: Keyword[];
  onChanged: () => Promise<void> | void;
}) {
  const [draft, setDraft] = useState("");
  const [kind, setKind] = useState("account_number");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function add() {
    const keyword = draft.trim();
    if (keyword === "") return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/accounts/${account.id}/keywords`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyword, kind }),
      });
      // The body, not the status: a path missing from the Vite proxy list answers 200
      // with index.html, and every check that trusts res.ok passes while nothing works.
      const body = await res.json().catch(() => ({}) as { error?: string });
      if (!res.ok) throw new Error(body.error ?? `request failed: ${res.status}`);
      setDraft("");
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save that identifier");
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: number) {
    await fetch(`/accounts/${account.id}/keywords/${id}`, { method: "DELETE" });
    await onChanged();
  }

  return (
    <div className="kw-account">
      <div className="kw-name">{account.name}</div>
      {keywords.length === 0 ? (
        <p className="soft" style={{ margin: "0 0 8px" }}>
          Nothing yet — transfers into this account can only be found by amount and date.
        </p>
      ) : (
        <div className="kw-list">
          {keywords.map((k) => (
            <span className="kw-chip" key={k.id}>
              {k.keyword}
              <em>{KINDS.find((x) => x.value === k.kind)?.label ?? k.kind}</em>
              <button
                className="row-x"
                title={`remove ${k.keyword}`}
                onClick={() => remove(k.id)}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="kw-add">
        <input
          value={draft}
          placeholder="XXXXXX4321  ·  name@okbank"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
        />
        <select className="cat-select" value={kind} onChange={(e) => setKind(e.target.value)}>
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
        <button className="btn" onClick={add} disabled={saving || draft.trim() === ""}>
          Add
        </button>
        {error && <span className="debit save-error">{error}</span>}
      </div>
    </div>
  );
}
