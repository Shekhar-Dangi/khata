import { useState } from "react";

import Pager from "../shared/Pager";
import { errorText, mutate } from "../shared/api";
import { rupees } from "../shared/format";
import { useLedgerVersion } from "../shared/ledgerVersion";
import type { Category } from "../shared/transactions";
import { useBusy, useFetch } from "../shared/useFetch";
import StagedOrderRow from "./StagedOrder";
import StagedProducts from "./StagedProducts";
import type { StagedItem, StagedItemsResponse } from "./stagedItems";
import {
  ORDER_FILTERS,
  overrideKey,
  type OrderFilter,
  artifactOfKey,
  inOrderFilter,
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

/**
 * Orders per page. 10 was sized for a list that only ever held the handful needing attention;
 * with every order reachable from a chip it is the whole inbox, and ten at a time turns 213
 * into 22 pages. A row is one line until you open it, so 25 still scans.
 */
const PAGE = 25;

/**
 * What "select all" asks for in one go — MAX_LIMIT in src/filters.ts, and the ceiling is real:
 * a request over it is refused rather than silently truncated, which is the only safe way for
 * a control that says "all" to behave.
 */
const MAX_PAGE = 500;

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
  /** What has been chosen, by normalised key — the same map the Products tab reads. */
  mapped: Map<string, { id: string; name: string } | null>;
  onMap: (canonical: string, item: { id: string; name: string } | null) => void;
  openId: string | null;
  onOpen: (id: string | null) => void;
};

/**
 * THE INBOX — everything parsed and waiting for a person, grouped the way imports are.
 *
 * This component now only READS. Everything about working through a group lives in
 * `StagedGroup`, one per source, because that is the question the old flat list could not
 * answer: drop Amazon today and Blinkit tomorrow and the two used to become one pile of 300
 * with a single "select all" across both.
 *
 * THREE READS, ONE LEVEL UP. Orders, products and the category tree are fetched here rather
 * than inside each panel: every panel needs the taxonomy, the product count has to be on a
 * collapsed tab label before anyone opens it, and `/evidence/staged` resolves the whole inbox
 * on every call — so one request per group would multiply the most expensive read on the
 * screen by the number of merchants.
 */
export default function StagedReview() {
  const { version, bump } = useLedgerVersion();
  // Collapsed until asked, like every import below. A drop of 213 orders that springs open on
  // arrival buries the rest of the page under itself.
  const [open, setOpen] = useState<Set<string>>(new Set());

  const cats = useFetch<{ categories: Category[] }>("/categories");
  const categories = cats.data?.categories ?? [];

  const products = useFetch<StagedItemsResponse>("/evidence/staged/items", {
    keepPreviousData: true,
    revalidateOn: version,
  });

  const inbox = useFetch<StagedResponse>(`/evidence/staged?limit=${MAX_PAGE}&offset=0`, {
    keepPreviousData: true,
    revalidateOn: version,
  });
  const working = useBusy(inbox.refreshing);
  const summary = inbox.data?.summary ?? null;

  // SAID, not blank. Resolving every staged order against the catalogue takes seconds on a real
  // drop, and returning null for the whole of it is why a full inbox looked like an empty one.
  if (inbox.loading) {
    return (
      <div className="staged">
        <div className="busybar on" aria-hidden="true">
          <i />
        </div>
        <p className="soft batch-empty">Reading the invoice inbox…</p>
      </div>
    );
  }

  // A FAILED READ IS SAID, an empty one is not. The two are indistinguishable from `data ===
  // null` and they are not the same fact: an inbox nobody has filled should show nothing at
  // all, while one that could not be read is exactly the silent failure that would let someone
  // believe two hundred uploaded invoices had vanished.
  if (inbox.error !== null) {
    return <p className="note">Could not read the invoice inbox — {inbox.error}</p>;
  }
  if (summary === null) return null;
  if (summary.staged === 0 && summary.held === 0) return null;

  // One group per source, biggest first. `source_type` is the only grouping the data carries;
  // see the note on StagedGroup for why that is not quite "per drop".
  const orders = inbox.data?.orders ?? [];
  const bySource = new Map<string, StagedOrder[]>();
  for (const o of orders) {
    const key = o.source_type || "unknown";
    const held = bySource.get(key);
    if (held) held.push(o);
    else bySource.set(key, [o]);
  }
  const sources = [...bySource.entries()].sort((a, b) => b[1].length - a[1].length);
  const allProducts = products.data?.items ?? [];
  const stale = working || inbox.isStale;

  return (
    <div className="staged">
      {sources.map(([source, group]) => (
        <StagedGroup
          key={source}
          source={source}
          orders={group}
          // A product belongs to the group whose merchant sold it. Filtered here so a panel's
          // Products tab can never offer something from a different merchant's drop.
          products={allProducts.filter((i) => i.source_type === source)}
          categories={categories}
          stale={stale}
          expanded={open.has(source)}
          onToggle={() =>
            setOpen((current) => {
              const next = new Set(current);
              if (next.has(source)) next.delete(source);
              else next.add(source);
              return next;
            })
          }
          onConfirmed={bump}
        />
      ))}

      {summary.held > 0 && (
        <Held
          files={inbox.data?.held ?? []}
          count={summary.held}
          expanded={open.has("__held")}
          onToggle={() =>
            setOpen((current) => {
              const next = new Set(current);
              if (next.has("__held")) next.delete("__held");
              else next.add("__held");
              return next;
            })
          }
        />
      )}

      {/* The taxonomy failing is not the inbox failing — the orders are still reviewable and
          only the category pickers go empty, so it is said here rather than replacing them. */}
      {cats.error !== null && <p className="note">Categories could not be read — {cats.error}</p>}
    </div>
  );
}

/**
 * ONE SOURCE'S worth of the inbox, in a panel shaped exactly like an import's.
 *
 * The inbox used to be a flat pile with a heading. That was fine while only one merchant's
 * receipts had ever been dropped, and wrong the moment a second arrived: two merchants'
 * invoices merged into one list of 300, one "select all", one confirm, and no way to work
 * through today's drop without touching last week's. It also sat at a different indent from
 * the imports below it, which made two things that ARE the same kind of thing look like two
 * kinds of thing.
 *
 * So a source is a group, drawn as `.batch` like every import, collapsed until opened, with
 * its own tabs, filters, selection and confirm. Nothing here is shared between groups — which
 * is the point: confirming Amazon cannot pick up a Blinkit order you had ticked and forgotten.
 *
 * The unit is SOURCE, not drop, because that is the only grouping the data actually carries —
 * `artifacts` has `source_type` and `created_at` and no batch id. Two Amazon drops on separate
 * days therefore share a panel. Splitting those needs a column, not a guess at one.
 */
function StagedGroup({
  source,
  orders,
  products,
  categories,
  stale,
  expanded,
  onToggle,
  onConfirmed,
}: {
  source: string;
  orders: StagedOrder[];
  products: StagedItem[];
  categories: Category[];
  stale: boolean;
  expanded: boolean;
  onToggle: () => void;
  onConfirmed: () => void;
}) {
  // The full ROW, not just its id — an order picked on page 1 is still picked on page 3, and a
  // confirm bar counting money from rows nothing on screen shows would be a number with no
  // visible cause. Same reasoning, and the same shape, as TransactionFinder's `picked`.
  const [picked, setPicked] = useState<Map<string, StagedOrder>>(new Map());
  const [answers, setAnswers] = useState<Map<string, LineAnswer>>(new Map());
  const [openId, setOpenId] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<ConfirmResponse | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Which half of the inbox is on screen. Orders answer "did this get paid"; products answer
  // "what was bought". They are worked at different rates — 365 lines collapse to 234 products,
  // so the product tab is usually the shorter road — and nesting one inside the other is what
  // made a person meet the same milk six times.
  const [tab, setTab] = useState<"orders" | "products">("orders");
  const [filter, setFilter] = useState<OrderFilter>("needs");
  // What the Products tab has been told, by normalised key. Kept beside `answers` rather than
  // derived from it: a key mapped to "create one" writes the same override as a key nobody has
  // touched, so the two are indistinguishable in `answers` and only this remembers the
  // difference between an answer and a default.
  const [mapped, setMapped] = useState<Map<string, { id: string; name: string } | null>>(
    new Map(),
  );

  const summary = groupSummary(orders);
  const working = stale;

  function toggle(order: StagedOrder) {
    setPicked((current) => {
      const next = new Map(current);
      if (next.has(order.artifact_id)) next.delete(order.artifact_id);
      else next.set(order.artifact_id, order);
      return next;
    });
  }

  /**
   * Point every line that reduces to one normalised key at one catalogue item.
   *
   * This is what makes the Products tab worth having: the same milk appears on twelve lines
   * across eight orders, and answering it there has to reach all twelve. Written as overrides
   * on the LINES rather than as a product-level answer because `POST /evidence/staged/confirm`
   * is keyed `artifact:line` — the wire has no notion of a product, and inventing one here
   * would mean the screen and the server disagreed about what was decided.
   */
  function mapProduct(canonical: string, item: { id: string; name: string } | null) {
    setMapped((current) => new Map(current).set(canonical, item));
    setAnswers((current) => {
      const next = new Map(current);
      for (const o of orders) {
        for (const l of o.lines) {
          if (l.kind === "fee" || l.canonical !== canonical) continue;
          next.set(
            overrideKey(o.artifact_id, l.index),
            item === null
              ? { answer: { create_new: true }, label: canonical }
              : { answer: { item_id: item.id }, label: item.name },
          );
        }
      }
      return next;
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
      setMapped(new Map());
      setOpenId(null);
      // Evidence, matching and allocations all move on a confirm, and the summary strip lives
      // in a different subtree — see ledgerVersion.tsx.
      onConfirmed();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setConfirming(false);
    }
  }

  const handlers: RowHandlers = {
    picked,
    onPick: toggle,
    answers,
    mapped,
    onMap: mapProduct,
    openId,
    onOpen: setOpenId,
  };

  // The view of this group's orders, then the page of that. One array behind the chips, the
  // table and "select all", so the three cannot disagree about what they mean.
  const matching = orders.filter((o) => inOrderFilter(o, filter));
  const pageOrders = matching.slice(offset, offset + PAGE);
  const filterLabel = ORDER_FILTERS.find((f) => f.id === filter)?.label ?? "all";

  const chosen = [...picked.values()];
  const money = chosen.reduce((a, o) => a + o.total_paise, 0);
  const unanswered = chosen.filter((o) => openLines(o, answers) > 0).length;

  return (
    <section className="batch">
      {/* The same header an import has, at the same indent, saying the same four things — what
          it is called, where it came from, how big it is, and how much of it is still work.
          They ARE the same kind of thing, and drawing them differently was the reason this
          list looked bolted on. */}
      <button className="batch-head" aria-expanded={expanded} onClick={onToggle}>
        <span className="batch-caret" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
        <span className="batch-name">{source} receipts</span>
        <span className="pill">not on your ledger yet</span>
        <span className="soft batch-when mono">
          {summary.staged} orders · {products.length} products ·{" "}
          {rupees(summary.total_paise)}
        </span>
        <span className={`batch-left${summary.needs_attention > 0 ? " flag" : " credit"}`}>
          {summary.needs_attention > 0
            ? `${summary.needs_attention} waiting on you`
            : `${summary.staged} ready to confirm`}
        </span>
      </button>

      {!expanded ? null : (
      <div className="batch-body">
      <Header summary={summary} />

      {result !== null && <Landed result={result} onDismiss={() => setResult(null)} />}

      <div className={"busybar" + (working ? " on" : "")} aria-hidden="true">
        <i />
      </div>

      {summary.staged > 0 && (
        <>
          {/* Two halves of one inbox, never nested. The count rides on the tab because it is a
              fact about the tab; the tab's own colour is what says "you are here". */}
          <div className="tf-tabs">
            <button
              className="tf-tab"
              aria-current={tab === "orders"}
              onClick={() => setTab("orders")}
            >
              Orders <b className="mono">{summary.staged}</b>
            </button>
            <button
              className="tf-tab"
              aria-current={tab === "products"}
              onClick={() => setTab("products")}
            >
              Products <b className="mono">{products.length}</b>
            </button>
          </div>

          {tab === "products" ? (
            <StagedProducts
              all={products}
              loading={false}
              error={null}
              stale={stale}
              categories={categories}
              chosen={mapped}
              onMap={mapProduct}
              onFiled={onConfirmed}
            />
          ) : (
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

          {/* THE FILTERS THE FOLD USED TO REPLACE.
              Every order is reachable from here — the 211 that need nothing are a chip, not a
              disclosure. Counts are exact because they are counted off the same array the table
              renders, and a chip with nothing behind it stays in place, greyed: that a filter is
              empty is a fact about the inbox, and a chip that vanishes takes it away. */}
          <div className="tf-tabs">
            {ORDER_FILTERS.map((f) => {
              const n = orders.filter((o) => inOrderFilter(o, f.id)).length;
              return (
                <button
                  key={f.id}
                  className={"tf-tab" + (n === 0 && filter !== f.id ? " zero" : "")}
                  aria-current={filter === f.id}
                  onClick={() => {
                    setFilter(f.id);
                    setOffset(0);
                    setOpenId(null);
                  }}
                >
                  {f.label} <b className="mono">{n}</b>
                </button>
              );
            })}
          </div>

          <OrderList
            orders={pageOrders}
            total={matching.length}
            offset={offset}
            onOffset={setOffset}
            busy={working}
            stale={stale}
            empty={`Nothing matches “${filterLabel}”.`}
            handlers={handlers}
            onSelectEvery={() =>
              setPicked(new Map(matching.map((o) => [o.artifact_id, o])))
            }
          />

          </>
          )}
        </>
      )}

      </div>
      )}
    </section>
  );
}

/**
 * What a group is, counted off its own rows.
 *
 * Derived rather than read from `summary`, because the response's summary describes the WHOLE
 * inbox and each panel has to describe itself. A panel headed "213 orders" above a list of 40
 * is the same lie as a paged count over a filtered list.
 */
function groupSummary(orders: StagedOrder[]): StagedSummary {
  return {
    staged: orders.length,
    held: 0,
    total_paise: orders.reduce((a, o) => a + o.total_paise, 0),
    needs_attention: orders.filter((o) => o.needs_attention).length,
    uncategorised_lines: orders.reduce(
      (a, o) => a + o.lines.filter((l) => l.kind !== "fee" && l.category === null).length,
      0,
    ),
  };
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
        <b className="mono">{rupees(summary.total_paise)}</b> would be attributed to your bank
        rows{summary.held > 0 && <> · {summary.held} held</>}
      </p>

    </>
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
  onSelectEvery,
}: {
  orders: StagedOrder[];
  total: number;
  offset: number;
  onOffset: (next: number) => void;
  busy: boolean;
  stale: boolean;
  empty: string;
  handlers: RowHandlers;
  onSelectEvery: () => void;
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

  const everyPicked = total > 0 && handlers.picked.size >= total;

  return (
    <>
      {/* Said only when the two answers differ. With one page there is nothing to offer and
          nothing to disambiguate, so the strip stays off the screen rather than restating
          what the header box already did. */}
      {allOnPage && orders.length < total && (
        <p className="staged-scope">
          {everyPicked ? (
            <span className="credit">All {total} selected — not just this page.</span>
          ) : (
            <>
              <span className="soft">All {orders.length} on this page.</span>{" "}
              <button className="btn-ghost" onClick={onSelectEvery}>
                Select all {total}
              </button>
            </>
          )}
        </p>
      )}

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
                mapped={handlers.mapped}
                onMap={handlers.onMap}
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
function Held({
  files,
  count,
  expanded,
  onToggle,
}: {
  files: HeldFile[];
  count: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <section className="batch">
      {/* Its own group, drawn like the others. These are not a footnote to a drop — they are a
          pile with its own reason to exist, and they outlive the import that brought them. */}
      <button className="batch-head" aria-expanded={expanded} onClick={onToggle}>
        <span className="batch-caret" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
        <span className="batch-name">Held files</span>
        <span className="pill">nothing reads these yet</span>
        <span className="soft batch-when mono">
          {count} file{count === 1 ? "" : "s"} · stored, nothing lost
        </span>
        <span className="batch-left soft">waiting on a feature</span>
      </button>

      {!expanded ? null : (
      <div className="batch-body">
      <p className="soft batch-empty">
        Mostly credit notes — re-read where they sit once refunds are built.
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
      </div>
      )}
    </section>
  );
}
