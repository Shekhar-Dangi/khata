import { useEffect, useState } from "react";

import LoadingLine from "../shared/LoadingLine";
import Pager from "../shared/Pager";
import { rupees } from "../shared/format";
import { useFetch } from "../shared/useFetch";
import { useLedgerVersion } from "../shared/ledgerVersion";
import { STATE } from "../shared/transactions";
import type { Consumption, ConsumptionTerms } from "./reports";

// What you actually USED, whoever paid for it — the Consumed side of the Spent | Consumed
// toggle on "Where it goes".
//
// IT REPLACES A SECOND TABLE (owner, 2026-09-19). The page used to show spending by category
// and, below it, consumption by category — the same categories, different money, and nothing
// saying how one became the other. It also ignored the date range, and folded a sizeable
// amount of money RECEIVED into the total without a word.
//
// So it is one table behind a toggle, and above it the FORMULA that walks the "Money out" tile
// to "consumed", one named money per line, each with its definition on hover.
//
// DRAWN WITH THE SPENT SIDE'S OWN PARTS, so the toggle changes the money and nothing else: the
// same `.bars` rows, and a drill-down in the same `.peek` frame with the same five columns in
// the same order — Date · Account · Narration · amount · State. It was a table of its own for
// one afternoon, 14px against the drill-down's 12.5px, 44px rows against 36px, the columns in
// another order; the owner saw it at once.
//
// The data is fetched by the PAGE, beside the Spent data, so flipping the toggle shows it
// immediately instead of opening onto an empty space while it loads.

/** The formula, top to bottom. Each line's hover is its definition — said once, here. */
const LINES: {
  key: keyof ConsumptionTerms;
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

export default function ConsumedView({
  data,
  error,
  baseQuery,
}: {
  data: Consumption | null;
  error: string | null;
  baseQuery: string;
}) {
  const [openId, setOpenId] = useState<number | null>(null);

  if (error) return <p className="note">{error}</p>;
  // Only on a first visit before the page's prefetch has answered — the same line as everywhere.
  if (data === null) return <LoadingLine />;

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
        <p className="soft">Nothing in this period.</p>
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
                  <span className={"barvalue mono " + (r.consumed_paise < 0 ? "credit" : "debit")}>
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

type Entry = {
  date: string;
  kind: "bank" | "paid_for_you";
  detail: string | null;
  source: "user" | "rule" | "evidence";
  consumed_paise: number;
  account_name: string | null;
};

/** Same page size as TransactionPeek, so both drill-downs are the same height. */
const PAGE = 10;

/** What is inside one bar — bank rows and what others paid, in the Spent drill-down's frame. */
function Entries({ categoryId, baseQuery }: { categoryId: number; baseQuery: string }) {
  const { version } = useLedgerVersion();
  const [offset, setOffset] = useState(0);
  useEffect(() => setOffset(0), [baseQuery]);

  const entries = useFetch<{ entries: Entry[]; total: number }>(
    `/reports/consumption/entries?category_id=${categoryId}&limit=${PAGE}&offset=${offset}` +
      (baseQuery === "" ? "" : `&${baseQuery}`),
    { keepPreviousData: true, revalidateOn: version },
  );

  if (entries.error) return <p className="soft touched-empty">{entries.error}</p>;
  if (entries.data === null) {
    return (
      <div className="peek">
        <LoadingLine />
      </div>
    );
  }
  const data = entries.data;

  return (
    <div className={"peek" + (entries.isStale ? " is-stale" : "")}>
      <table>
        {/* The Spent drill-down's columns, widths and order, so the toggle moves nothing. */}
        <colgroup>
          <col style={{ width: "110px" }} />
          <col style={{ width: "130px" }} />
          <col />
          <col style={{ width: "140px" }} />
          <col style={{ width: "120px" }} />
        </colgroup>
        <thead>
          <tr>
            <th>Date</th>
            <th>Account</th>
            <th>Narration</th>
            <th className="r">Consumed</th>
            <th className="r">State</th>
          </tr>
        </thead>
        <tbody>
          {data.entries.map((e, i) => (
            <tr key={`${e.date}-${i}`}>
              <td className="mono soft">{e.date}</td>
              <td className="soft">
                {e.kind === "paid_for_you" ? "paid by others" : (e.account_name ?? "—")}
              </td>
              <td className="narration" title={e.detail ?? ""}>{e.detail ?? "—"}</td>
              <td className={"mono r " + (e.consumed_paise < 0 ? "credit" : "debit")}>
                {rupees(e.consumed_paise)}
              </td>
              <td className="r">
                {/* The same two words the Spent drill-down uses for the same money. */}
                {e.source === "rule" ? (
                  <span className="prov" title="A rule guessed this. Open it on Transactions to confirm.">
                    {STATE.rule}
                  </span>
                ) : (
                  <span className="credit">{STATE.user}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.total > PAGE && (
        <Pager
          offset={offset}
          limit={PAGE}
          total={data.total}
          shown={data.entries.length}
          onOffset={setOffset}
          busy={entries.refreshing}
        />
      )}
    </div>
  );
}
