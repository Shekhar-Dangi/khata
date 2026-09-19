import { useState } from "react";

import Pager from "../shared/Pager";
import { rupees } from "../shared/format";
import { useFetch } from "../shared/useFetch";
import { useLedgerVersion } from "../shared/ledgerVersion";

// What you actually USED, whoever paid for it — the Consumed side of the Spent | Consumed
// toggle on "Where it goes". the design.
//
// IT REPLACES A SECOND TABLE (owner, 2026-09-19). The page used to show spending by category
// and, below it, consumption by category — the same categories, different money, and nothing
// saying how one became the other. It also ignored the date range, and folded a large sum of
// money RECEIVED into the total without a word.
//
// So it is one table behind a toggle, and above it the FORMULA that walks the "Money out" tile
// to "consumed", one named money per line, each with its definition on hover. The gap between
// spending and consumption — the reason this view exists — is no longer something to infer
// from two tables; it is written down.

type Terms = {
  money_out_paise: number;
  unexplained_paise: number;
  fronted_paise: number;
  paid_for_you_paise: number;
  received_paise: number;
  consumed_paise: number;
};

type Row = {
  id: number;
  name: string;
  parent_name: string | null;
  consumed_paise: number;
  entries: number;
};

type Consumption = {
  categories: Row[];
  terms: Terms;
  unaccounted_paise: number;
  unclassified_paise: number;
};

type Entry = {
  date: string;
  kind: "bank" | "paid_for_you";
  detail: string | null;
  consumed_paise: number;
  account_name: string | null;
};

/** The formula, top to bottom. Each line's hover is its definition — said once, here. */
const LINES: {
  key: keyof Terms;
  sign: "" | "−" | "+" | "=";
  label: string;
  means: string;
  /** Hidden at zero — a line that says "+ Rs 0" is a line to read for nothing. */
  hideZero: boolean;
}[] = [
  {
    key: "money_out_paise",
    sign: "",
    label: "Money out",
    means:
      "Everything that left your accounts in this period — the same figure as the Money out " +
      "tile. Moving money between your own accounts is not counted.",
    hideZero: false,
  },
  {
    key: "unexplained_paise",
    sign: "−",
    label: "not explained yet",
    means:
      "Money out with no category. It cannot count as consumed until you say what it was.",
    hideZero: true,
  },
  {
    key: "fronted_paise",
    sign: "−",
    label: "not yours",
    means:
      "Spent on other people or moved around — categories marked as not your own spending, " +
      "such as Transfers, Shared and Income.",
    hideZero: true,
  },
  {
    key: "paid_for_you_paise",
    sign: "+",
    label: "paid for you",
    means:
      "What others paid for you, from Splitwise. It never appears on your bank statement. " +
      "Not tied to any account, so it drops out when an account is picked.",
    hideZero: true,
  },
  {
    key: "received_paise",
    sign: "−",
    label: "money received",
    means:
      "Credits filed under a spending category — a refund, or money received and filed where " +
      "spending goes. These count against what you consumed.",
    hideZero: true,
  },
  {
    key: "consumed_paise",
    sign: "=",
    label: "Consumed",
    means: "What you actually used, whoever paid for it.",
    hideZero: false,
  },
];

export default function ConsumedView({ baseQuery }: { baseQuery: string }) {
  const { version } = useLedgerVersion();
  const [openId, setOpenId] = useState<number | null>(null);
  const { data, error } = useFetch<Consumption>(
    `/reports/consumption${baseQuery === "" ? "" : `?${baseQuery}`}`,
    { keepPreviousData: true, revalidateOn: version },
  );

  if (error) return <p className="note">{error}</p>;
  if (data === null) return null;

  const t = data.terms;
  const max = Math.max(1, ...data.categories.map((r) => Math.abs(r.consumed_paise)));

  return (
    <div>
      <dl className="formula">
        {LINES.filter((l) => !(l.hideZero && t[l.key] === 0)).map((l) => (
          <div key={l.key} className={"f-row" + (l.sign === "=" ? " total" : "")} title={l.means}>
            <dt>
              {l.sign !== "" && <span className="f-sign">{l.sign}</span>}
              {l.label}
            </dt>
            <dd className="mono">{rupees(t[l.key])}</dd>
          </div>
        ))}
      </dl>

      {/* The two things not in the total, said beside it rather than left to be discovered. */}
      {data.unclassified_paise > 0 && (
        <p
          className="soft up-note"
          title="A flatmate paid, but that Splitwise category has no mapping yet — map it under Categories."
        >
          Not counted: {rupees(data.unclassified_paise)} paid for you, in a Splitwise category with
          no mapping yet.
        </p>
      )}
      {data.unaccounted_paise !== 0 && (
        // Every line is computed from the ledger on its own, so this is non-zero only when an
        // invariant broke. Shown, never rounded away.
        <p className="note">
          These lines are off by {rupees(data.unaccounted_paise)} — the ledger breaks a rule the
          formula relies on. Worth reporting.
        </p>
      )}

      {data.categories.length === 0 ? (
        <p className="soft">Nothing consumed in this period.</p>
      ) : (
        <div className="bars">
          {data.categories.map((r) => {
            const open = openId === r.id;
            return (
              <div key={r.id}>
                <button
                  className={"barrow" + (open ? " open" : "")}
                  aria-expanded={open}
                  onClick={() => setOpenId(open ? null : r.id)}
                  title={`${r.entries} ${r.entries === 1 ? "entry" : "entries"} — click to see them`}
                >
                  <span className="barlabel">
                    {r.name}
                    {r.parent_name && <em>{r.parent_name}</em>}
                  </span>
                  <span className="bartrack">
                    <span
                      className="barfill"
                      style={{ width: `${(Math.abs(r.consumed_paise) / max) * 100}%` }}
                    >
                      <i className="seg-consumed" style={{ width: "100%" }} />
                    </span>
                  </span>
                  <span className={"barvalue mono " + (r.consumed_paise < 0 ? "credit" : "")}>
                    {rupees(r.consumed_paise)}
                  </span>
                  <span className="bardelta" />
                </button>
                {open && (
                  <div className="bar-peek">
                    <Entries categoryId={r.id} baseQuery={baseQuery} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const PAGE = 25;

/** What is inside one bar: bank rows and what others paid, from the same rows as the total. */
function Entries({ categoryId, baseQuery }: { categoryId: number; baseQuery: string }) {
  const { version } = useLedgerVersion();
  const [offset, setOffset] = useState(0);
  const { data, error, isStale } = useFetch<{ entries: Entry[]; total: number }>(
    `/reports/consumption/entries?category_id=${categoryId}&limit=${PAGE}&offset=${offset}` +
      (baseQuery === "" ? "" : `&${baseQuery}`),
    { keepPreviousData: true, revalidateOn: version },
  );

  if (error) return <p className="note">{error}</p>;
  if (data === null) return null;

  return (
    <div className={isStale ? "is-stale" : undefined}>
      <div className="table-scroll short">
        <table>
          <colgroup>
            <col style={{ width: "108px" }} />
            <col />
            <col style={{ width: "140px" }} />
            <col style={{ width: "120px" }} />
          </colgroup>
          <thead>
            <tr>
              <th>Date</th>
              <th>What</th>
              <th>Paid from</th>
              <th className="r">Consumed</th>
            </tr>
          </thead>
          <tbody>
            {data.entries.map((e, i) => (
              <tr key={`${e.date}-${i}`}>
                <td className="mono soft">{e.date}</td>
                <td className="narration" title={e.detail ?? ""}>{e.detail ?? "—"}</td>
                <td className="soft">
                  {e.kind === "paid_for_you" ? "paid by others" : (e.account_name ?? "—")}
                </td>
                <td className={"mono r" + (e.consumed_paise < 0 ? " credit" : "")}>
                  {rupees(e.consumed_paise)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.total > PAGE && (
        <Pager
          offset={offset}
          limit={PAGE}
          total={data.total}
          shown={data.entries.length}
          onOffset={setOffset}
          unit="entries"
          busy={false}
        />
      )}
    </div>
  );
}
