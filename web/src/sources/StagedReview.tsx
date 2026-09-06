import { useState } from "react";

import Pager from "../shared/Pager";
import { errorText, mutate } from "../shared/api";
import { rupees } from "../shared/format";
import { useLedgerVersion } from "../shared/ledgerVersion";
import type { Category } from "../shared/transactions";
import { useBusy, useFetch } from "../shared/useFetch";
import StagedOrderRow from "./StagedOrder";
import {
  artifactOfKey,
  openLines,
  type ConfirmResponse,
  type HeldFile,
  type LineAnswer,
  type Override,
  type StagedOrder,
  type StagedResponse,
  type StagedSummary,
} from "./staged";

// THE INBOX — everything parsed and reconciled, waiting for a person, and none of it on the
// ledger yet.
//
// IT HOLDS NO IMPORT STATE. Every figure on this screen is read from the server, which is what
// makes the two-phase design work at all: upload two hundred invoices today, close the laptop,
// confirm them tomorrow. A version that kept parsed orders in browser memory would lose the
// review on a refresh, could not be resumed, and would need a re-upload to try again.
//
// ATTENTION FIRST. A screen that asks a person to read 221 orders will not be read, so
// the ~30 that need a decision ARE the list and the other ~190 sit behind a disclosure. Both
// feed ONE selection, so confirming across them needs no opinion from the screen.

/** Orders per page. Each row opens into a table of line items, so a screenful is small. */
const PAGE = 10;

/**
 * Everything a row needs that this screen owns.
 *
 * A named bundle rather than eleven props threaded through two list components: the two lists
 * are the same list with a different filter, and re-declaring the set for each is how they end
 * up offering different controls on the same row.
 */
type RowHandlers = {
  picked: Map<string, StagedOrder>;
  onPick: (order: StagedOrder) => void;
  answers: Map<string, LineAnswer>;
  onAnswer: (key: string, next: LineAnswer | null) => void;
  categories: Category[];
  freshCategories: Map<string, { id: number; name: string } | null>;
  onCategorised: (itemId: string, category: { id: number; name: string } | null) => void;
  openId: string | null;
  onOpen: (id: string | null) => void;
};

export default function StagedReview() {
  const { version, bump } = useLedgerVersion();
  // The full ROW, not just its id — an order picked on page 1 is still picked on page 3, and a
  // confirm bar counting money from rows nothing on screen shows would be a number with no
  // visible cause. Same reasoning, and the same shape, as TransactionFinder's `picked`.
  const [picked, setPicked] = useState<Map<string, StagedOrder>>(new Map());
  const [answers, setAnswers] = useState<Map<string, LineAnswer>>(new Map());
  const [freshCategories, setFreshCategories] = useState<
    Map<string, { id: number; name: string } | null>
  >(new Map());
  const [openId, setOpenId] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<ConfirmResponse | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  // ONE request for the category tree, here rather than inside each picker: five hundred line
  // items each fetching the taxonomy would be five hundred requests for the same list.
  const cats = useFetch<{ categories: Category[] }>("/categories");
  const categories = cats.data?.categories ?? [];

  // The attention page IS the summary request. One fetch, not two: a second call for the
  // header would ask the server to re-run resolution over the same rows to produce figures the
  // first one already carried, and the two could disagree while both were in flight.
  const inbox = useFetch<StagedResponse>(
    `/evidence/staged?attention=1&limit=${PAGE}&offset=${offset}`,
    { keepPreviousData: true, revalidateOn: version },
  );
  const working = useBusy(inbox.refreshing);
  const summary = inbox.data?.summary ?? null;

  function toggle(order: StagedOrder) {
    setPicked((current) => {
      const next = new Map(current);
      if (next.has(order.artifact_id)) next.delete(order.artifact_id);
      else next.set(order.artifact_id, order);
      return next;
    });
  }

  function setAnswer(key: string, next: LineAnswer | null) {
    setAnswers((current) => {
      const map = new Map(current);
      if (next === null) map.delete(key);
      else map.set(key, next);
      return map;
    });
  }

  async function confirm() {
    setConfirming(true);
    setError(null);
    try {
      const ids = [...picked.keys()];
      const mine = new Set(ids);
      const payload: Record<string, Override> = {};
      for (const [key, value] of answers) {
        // Only the answers belonging to an order being confirmed. Sending one about an order
        // left behind asks the server to decide what to do with a decision it was not asked to
        // act on. `value.answer`, never `value`: the label is the screen's, not the wire's.
        if (mine.has(artifactOfKey(key))) payload[key] = value.answer;
      }
      const answer = await mutate<ConfirmResponse>("/evidence/staged/confirm", {
        method: "POST",
        body: JSON.stringify({ artifact_ids: ids, overrides: payload }),
      });
      setResult(answer);
      // Everything is cleared, not only what landed. A stale answer is keyed by line INDEX
      // within an order that is no longer in the list at the same place — a decision applied to
      // the wrong product is exactly the failure this screen exists to prevent, and re-picking
      // is cheap next to it.
      setPicked(new Map());
      setAnswers(new Map());
      setOpenId(null);
      // Evidence, matching and allocations all move on a confirm, and the summary strip lives
      // in a different subtree — see ledgerVersion.tsx.
      bump();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setConfirming(false);
    }
  }

  if (inbox.loading) return null;

  // A FAILED READ IS SAID, an empty one is not. The two are indistinguishable from `data ===
  // null` and they are not the same fact: an inbox nobody has filled should show nothing at
  // all, while an inbox that could not be read is exactly the silent failure that would let
  // someone believe two hundred uploaded invoices had vanished.
  if (inbox.error !== null) {
    return (
      <div className="staged">
        <div className="sect">
          <span>Waiting for you to confirm</span>
        </div>
        <p className="note">Could not read the invoice inbox — {inbox.error}</p>
      </div>
    );
  }

  // NOTHING WAITING IS NOT AN EMPTY STATE WORTH DRAWING. This section sits above the Splitwise
  // imports, on a screen whose drop panel already says what to do with an empty inbox — a panel
  // announcing "no invoices are waiting" would be a third statement of the same fact, for the
  // same reason Pager renders nothing when there is nothing to page through.
  if (summary === null) return null;
  if (summary.staged === 0 && summary.held === 0) return null;

  const handlers: RowHandlers = {
    picked,
    onPick: toggle,
    answers,
    onAnswer: setAnswer,
    categories,
    freshCategories,
    onCategorised: (itemId, category) =>
      setFreshCategories((current) => new Map(current).set(itemId, category)),
    openId,
    onOpen: setOpenId,
  };

  const chosen = [...picked.values()];
  const money = chosen.reduce((a, o) => a + o.total_paise, 0);
  const unanswered = chosen.filter((o) => openLines(o, answers) > 0).length;

  return (
    <div className="staged">
      <div className="sect">
        <span>Waiting for you to confirm</span>
        <span className="pill">not on your ledger yet</span>
      </div>

      <Header summary={summary} />

      {result !== null && <Landed result={result} onDismiss={() => setResult(null)} />}

      <div className={"busybar" + (working ? " on" : "")} aria-hidden="true">
        <i />
      </div>

      {summary.staged > 0 && (
        <>
          {/* The tally and the button together, ABOVE the list — the same arrangement, for the
              same reason, as the finder's action bar: the number you steer by and the control
              you steer with have to be on screen at the same time. */}
          <div className="finder-bar">
            <span className="finder-tally">
              <span>
                selected <b className="mono">{chosen.length}</b>
                <span className="soft"> of {summary.staged} orders</span>
              </span>
              <span>
                worth <b className="mono">{rupees(money)}</b>
              </span>
            </span>
            {/* Information, never a block — the same call the finder makes about its gap. An
                unanswered line resolves the way the resolver already proposed, which is a
                defensible outcome; letting it happen without saying so would not be. */}
            {unanswered > 0 && (
              <span className="finder-warn flag">
                {unanswered} of these still {unanswered === 1 ? "has a line" : "have lines"}{" "}
                waiting on you — confirming takes the resolver's own answer for{" "}
                {unanswered === 1 ? "it" : "them"}.
              </span>
            )}
            <span className="finder-actions">
              {error !== null && <span className="debit save-error">{error}</span>}
              {chosen.length > 0 && (
                <button
                  className="btn-ghost"
                  disabled={confirming}
                  onClick={() => setPicked(new Map())}
                >
                  Clear
                </button>
              )}
              <button
                className="btn"
                disabled={confirming || chosen.length === 0}
                onClick={() => void confirm()}
              >
                {confirming
                  ? "Confirming…"
                  : `Confirm ${chosen.length} order${chosen.length === 1 ? "" : "s"}`}
              </button>
            </span>
          </div>

          <OrderList
            orders={inbox.data?.orders ?? []}
            total={summary.needs_attention}
            offset={offset}
            onOffset={setOffset}
            busy={working}
            stale={working || inbox.isStale}
            empty="Nothing needs a decision — everything staged is ready as it is, below."
            handlers={handlers}
          />

          {/* Everything else, COLLAPSED. A native <details>, so the disclosure is keyboard- and
              screen-reader-correct without a line of JavaScript — and the list inside does not
              fetch until it is opened, which is what keeps "221 orders" cheap to have on the
              page at all. */}
          <details className="fold" onToggle={(e) => setShowAll(e.currentTarget.open)}>
            <summary>
              All {summary.staged} staged orders, including the{" "}
              {summary.staged - summary.needs_attention} that need nothing
            </summary>
            {showAll && <AllOrders total={summary.staged} handlers={handlers} />}
          </details>
        </>
      )}

      {summary.held > 0 && <Held files={inbox.data?.held ?? []} count={summary.held} />}

      {/* The taxonomy failing is not the inbox failing — the orders are still reviewable and
          only the category pickers go empty, so it is said here rather than replacing the page. */}
      {cats.error !== null && <p className="note">Categories could not be read — {cats.error}</p>}
    </div>
  );
}

/**
 * The two sentences a person needs before pressing anything: how much money this is, and what
 * confirming will and will not do to it.
 *
 * The second is its surprise, said UP FRONT rather than discovered afterwards: every item
 * starts uncategorised, so a correct confirm of two hundred orders moves the unexplained figure
 * by nothing at all. An import that looks broken when it worked is how a person stops trusting
 * the numbers, which is the one thing this product cannot afford.
 *
 * It borrows the import receipt's prose-plus-tally shape rather than a grid of tiles, and for
 * the reason recorded there: equal-weight figures say all the figures matter equally, which is
 * the one thing a summary must never say.
 */
function Header({ summary }: { summary: StagedSummary }) {
  const ready = summary.staged - summary.needs_attention;

  // Held files with nothing staged behind them — every invoice in the drop was a credit note,
  // or the only ones left are the ones nothing reads yet. A tally of five zeroes under it would
  // be five facts about an empty list; the one sentence is the whole content.
  if (summary.staged === 0) {
    return (
      <p className="receipt-said">
        Nothing is waiting to be confirmed. {summary.held} file
        {summary.held === 1 ? " was" : "s were"} stored but cannot be posted yet — they are
        listed below and nothing about them is lost.
      </p>
    );
  }

  return (
    <>
      <p className="receipt-said">
        <strong>
          {summary.staged} order{summary.staged === 1 ? "" : "s"}
        </strong>{" "}
        parsed and waiting — <b className="mono">{rupees(summary.total_paise)}</b> would be
        attributed to your bank rows
        {summary.held > 0 && (
          <>
            , and {summary.held} file{summary.held === 1 ? " is" : "s are"} held
          </>
        )}
        . Nothing here has touched your ledger.
      </p>

      <div className="receipt-tally">
        <span className={summary.needs_attention > 0 ? "flag" : "soft"}>
          <b className="mono">{summary.needs_attention}</b> need you
          <span className="soft"> · a line to answer, or no bank row found</span>
        </span>
        <span className={ready > 0 ? "credit" : "soft"}>
          <b className="mono">{ready}</b> ready as {ready === 1 ? "it is" : "they are"}
        </span>
        <span className={summary.uncategorised_lines > 0 ? "flag" : "soft"}>
          <b className="mono">{summary.uncategorised_lines}</b> line items with no category
        </span>
      </div>

      {summary.uncategorised_lines > 0 ? (
        <p className="note">
          Confirming attaches these orders to your bank rows and files their items into the
          product catalogue. It will <b>not</b> categorise a rupee of it: a category belongs to
          the product, and {summary.uncategorised_lines} of these items do not have one yet — so
          this import produces <b>zero allocations</b> until some products are filed. That is
          deliberate, and it is cheap to fix: a product is filed once, not once per order.
        </p>
      ) : (
        <p className="note ok">
          Every product in these orders already has a category, so confirming will attribute the
          money as well as record it.
        </p>
      )}
    </>
  );
}

/**
 * The "everything else" list — its own fetch and its own page position.
 *
 * Paged separately from the attention list for the reason ImportBatchPanel pages its segments
 * separately: the two are worked at different rates, and one shared pager would make "next
 * page" mean a different thing depending on where you happened to be.
 */
function AllOrders({ total, handlers }: { total: number; handlers: RowHandlers }) {
  const [offset, setOffset] = useState(0);
  const { version } = useLedgerVersion();
  const list = useFetch<StagedResponse>(`/evidence/staged?limit=${PAGE}&offset=${offset}`, {
    keepPreviousData: true,
    revalidateOn: version,
  });
  const working = useBusy(list.refreshing);

  if (list.loading) return <p className="soft batch-empty">Reading the inbox…</p>;
  if (list.error !== null) return <p className="note">{list.error}</p>;

  return (
    <OrderList
      orders={list.data?.orders ?? []}
      total={total}
      offset={offset}
      onOffset={setOffset}
      busy={working}
      stale={working || list.isStale}
      empty="Nothing staged."
      handlers={handlers}
    />
  );
}

/**
 * One page of staged orders. Presentational: it owns nothing, the way Pager owns nothing.
 *
 * THE TOTAL COMES FROM THE SUMMARY, not from the page. its response carries no `total`, and
 * inventing one would be inventing an endpoint — but `summary.staged` and
 * `summary.needs_attention` already count exactly these two lists, so each is told which one it
 * is showing.
 */
function OrderList({
  orders,
  total,
  offset,
  onOffset,
  busy,
  stale,
  empty,
  handlers,
}: {
  orders: StagedOrder[];
  total: number;
  offset: number;
  onOffset: (next: number) => void;
  busy: boolean;
  stale: boolean;
  empty: string;
  handlers: RowHandlers;
}) {
  if (orders.length === 0) return <p className="soft batch-empty">{empty}</p>;

  const allOnPage = orders.every((o) => handlers.picked.has(o.artifact_id));
  // The PAGE, never the whole inbox. A control that silently selects rows on pages you have not
  // looked at is a control that confirms orders you have not seen.
  const togglePage = () => {
    for (const o of orders) {
      if (handlers.picked.has(o.artifact_id) === allOnPage) handlers.onPick(o);
    }
  };

  return (
    <>
      <div className={"staged-list" + (stale ? " is-stale" : "")}>
        <table className="record-table">
          <colgroup>
            <col style={{ width: "38px" }} />
            {/* 108px, not 100: a mono YYYY-MM-DD does not fit in 100 and wraps onto two lines,
                which makes every row in the table a different height. */}
            <col style={{ width: "108px" }} />
            <col />
            <col style={{ width: "116px" }} />
            <col style={{ width: "168px" }} />
          </colgroup>
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  checked={allOnPage}
                  onChange={togglePage}
                  aria-label="Select every order on this page"
                />
              </th>
              <th>Ordered</th>
              <th>Order</th>
              <th className="r">Amount</th>
              <th className="r">Attaches to</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <StagedOrderRow
                key={o.artifact_id}
                order={o}
                picked={handlers.picked.has(o.artifact_id)}
                onPick={() => handlers.onPick(o)}
                answers={handlers.answers}
                onAnswer={handlers.onAnswer}
                categories={handlers.categories}
                freshCategories={handlers.freshCategories}
                onCategorised={handlers.onCategorised}
                expanded={handlers.openId === o.artifact_id}
                onExpand={() =>
                  handlers.onOpen(handlers.openId === o.artifact_id ? null : o.artifact_id)
                }
              />
            ))}
          </tbody>
        </table>
      </div>

      {total > PAGE && (
        <Pager
          offset={offset}
          limit={PAGE}
          total={total}
          shown={orders.length}
          onOffset={onOffset}
          unit="orders"
          busy={busy}
        />
      )}
    </>
  );
}

/**
 * What a confirm actually did.
 *
 * Three lists, and only one of them is a problem. `skipped` is the idempotent half — an order
 * already on the ledger — and drawing it as a failure would make the resumable path look like a
 * fault every time a selection was confirmed twice.
 */
function Landed({ result, onDismiss }: { result: ConfirmResponse; onDismiss: () => void }) {
  return (
    <div className="receipt done">
      <p className="receipt-said">
        <strong>
          {result.landed.length} order{result.landed.length === 1 ? "" : "s"} on your ledger
        </strong>
        {result.skipped.length > 0 && <> · {result.skipped.length} were already there</>}
        {result.errors.length > 0 && (
          <span className="flag"> · {result.errors.length} could not be posted</span>
        )}
        . Matching ran as they landed; anything with no bank row is picked up by a re-match once
        the statement covering it is imported.
      </p>
      {result.errors.length > 0 && (
        <div className="table-scroll short">
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Why not</th>
              </tr>
            </thead>
            <tbody>
              {result.errors.map((e) => (
                <tr key={e.artifact_id}>
                  <td className="mono">{e.artifact_id}</td>
                  <td className="soft">{e.error}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="preview-actions">
        <button className="btn-secondary" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

/**
 * Files that parsed as something this app cannot post yet.
 *
 * A STATE, and drawn as one — ink, not red, and no word suggesting anything went wrong. Of the
 * real corpus 29 of 252 are credit notes, and a refund is a separate event from the purchase it
 * reverses, so posting one as an order would double-count the money. They are waiting on
 * a feature, not on a fix, and the whole point of keeping the bytes is that the day it lands
 * every one of these is re-read where it sits. A correct run must not look half-broken.
 */
function Held({ files, count }: { files: HeldFile[]; count: number }) {
  return (
    <details className="fold" open>
      <summary>
        {count} file{count === 1 ? "" : "s"} held — stored, waiting on a feature
      </summary>
      <p className="note">
        These were read and stored, and nothing about them is lost. Most are credit notes: a
        refund is a separate event from the purchase it reverses, so posting one as an order
        would count the money twice. They stay in the store and are re-read where they sit once
        refunds are built.
      </p>
      <div className="table-scroll short">
        <table>
          <colgroup>
            <col />
            <col style={{ width: "140px" }} />
            <col style={{ width: "50%" }} />
          </colgroup>
          <thead>
            <tr>
              <th>File</th>
              <th>State</th>
              <th>What the reader said</th>
            </tr>
          </thead>
          <tbody>
            {files.map((f) => (
              <tr key={f.artifact_id}>
                <td className="narration">{f.original_name ?? `artifact ${f.artifact_id}`}</td>
                <td className="soft nowrap">
                  {/* "unsupported" covers two different things and the difference matters to
                      whoever reads this row. A credit note was READ — a parser recognised it
                      and declined on purpose, because a refund is not a purchase. Calling that
                      "no reader yet" describes the file as unrecognised when it was understood
                      exactly. The parse_error names which case it is. */}
                  {f.parse_status !== "unsupported"
                    ? "could not be read"
                    : /^(credit_note|not_an_invoice)/.test(f.parse_error ?? "")
                      ? "read, not a purchase"
                      : "no reader yet"}
                </td>
                <td className="soft narration">{f.parse_error ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
