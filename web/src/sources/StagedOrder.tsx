import { Fragment, useState } from "react";

import CategorySelect from "../shared/CategorySelect";
import { errorText, mutate } from "../shared/api";
import { rupees } from "../shared/format";
import type { Category } from "../shared/transactions";
import ItemPicker from "./ItemPicker";
import {
  bestCandidate,
  dayMonth,
  itemIdOf,
  openLines,
  overrideKey,
  verdictOf,
  type LineAnswer,
  type StagedLine,
  type StagedMatch,
  type StagedOrder as Order,
} from "./staged";

// One staged order, and — expanded — the lines it is made of.
//
// The same shape as every other list in this app: a table row you click to open, the actions
// inside the panel rather than trailing off the end of the row. RecordTable is the sibling; this
// is the same screen one phase earlier, before anything is on the ledger.
//
// THE MATCH IS ON THE ROW, not inside the panel. the design calls "will attach to
// Card −₹120.00 on 08 Aug" the single most useful line on the screen, and a fact you have to
// open something to see is a fact most people will confirm without.

export default function StagedOrder({
  order,
  picked,
  onPick,
  answers,
  onAnswer,
  categories,
  freshCategories,
  onCategorised,
  expanded,
  onExpand,
}: {
  order: Order;
  picked: boolean;
  onPick: () => void;
  answers: Map<string, LineAnswer>;
  onAnswer: (key: string, next: LineAnswer | null) => void;
  categories: Category[];
  /**
   * Categories written from this screen since the list was read, by item id.
   *
   * Layered over the response rather than refetched, and that is not only a saving: the same
   * product appears on lines of several different orders, so filing it once and watching every
   * one of them change is the clearest possible statement of the thing has to explain in
   * words — a category belongs to the PRODUCT, not to the line.
   */
  freshCategories: Map<string, { id: number; name: string } | null>;
  onCategorised: (itemId: string, category: { id: number; name: string } | null) => void;
  expanded: boolean;
  onExpand: () => void;
}) {
  const waiting = openLines(order, answers);

  return (
    <Fragment>
      <tr className="txn-row" onClick={onExpand}>
        {/* The cell swallows its own clicks, or the checkbox's change AND the row's click both
            fire and the tick immediately unticks itself. Same trap, same fix, as the finder. */}
        <td onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={picked}
            onChange={onPick}
            aria-label={`Confirm order ${order.external_ref}`}
          />
        </td>
        <td className="mono soft">{order.order_date}</td>
        {/* ONE LINE, and the merchant first. The reference is the identity but the merchant is
            what a person recognises, and putting the variable-length part last means every row
            truncates in the same place instead of at a different word.
            `.clip`, not `.narration`: that class truncates by way of `max-width: 0` on a
            fixed-layout <td>, and max-width does nothing at all to an inline box — so a long
            reference ran past its column instead of ellipsising. */}
        <td>
          <span className="order-cell">
            <b className="order-merchant">{order.source_type}</b>
            <span className="clip mono soft">{order.external_ref}</span>
            {/* AFTER the reference, not before it. Leading the cell with a tag that most rows
                do not carry starts the merchant at two different x positions down the column,
                which is the misalignment a table exists to prevent. At the end it is flush to
                the cell's own right edge, so it lines up whether or not the row beneath has one. */}
            {waiting > 0 && <span className="tag-claim input">{waiting} to answer</span>}
          </span>
        </td>
        <td className="mono r debit">{rupees(-order.total_paise)}</td>
        <td className="r nowrap">
          <Attaches match={order.match} open={expanded} />
        </td>
      </tr>

      {expanded && (
        <tr className="txn-detail">
          <td colSpan={5}>
            <Lines
              order={order}
              answers={answers}
              onAnswer={onAnswer}
              categories={categories}
              freshCategories={freshCategories}
              onCategorised={onCategorised}
            />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

/**
 * What confirming this order will attach it to.
 *
 * Three answers, and only one of them is work. "No bank row yet" is not a failure — the
 * commonest reason is that the statement covering that month has not been imported (
 * measured exactly this), and `POST /evidence/rematch` finds it later without anyone
 * re-uploading. So it is said in ink, and only the ambiguous case takes the flag colour.
 */
function Attaches({ match, open }: { match: StagedMatch; open: boolean }) {
  const caret = open ? " ▴" : " ▾";

  if (match.kind === "matched" && match.transaction !== null) {
    const t = match.transaction;
    // Account and day, not the whole sentence. The AMOUNT is in the column to the left and a
    // match is exact on it by definition, so repeating it here says nothing and was the reason
    // this cell needed 250px; the panel below still names the narration in full.
    return (
      <span className="credit">
        {t.account_name ?? "a bank row"} · {dayMonth(t.txn_date)}
        {caret}
      </span>
    );
  }
  if (match.kind === "ambiguous") {
    return <span className="flag">more than one match{caret}</span>;
  }
  return <span className="soft">no bank row{caret}</span>;
}

/**
 * The line items, and the two decisions that can be made about each.
 *
 * The note at the top is the first of its two surprises, said at the level where it is
 * true: on the PANEL, not on each control. Repeating it beside every picker would turn a fact
 * about the catalogue into fifteen identical warnings nobody reads by the third one.
 */
function Lines({
  order,
  answers,
  onAnswer,
  categories,
  freshCategories,
  onCategorised,
}: {
  order: Order;
  answers: Map<string, LineAnswer>;
  onAnswer: (key: string, next: LineAnswer | null) => void;
  categories: Category[];
  freshCategories: Map<string, { id: number; name: string } | null>;
  onCategorised: (itemId: string, category: { id: number; name: string } | null) => void;
}) {
  const [openLine, setOpenLine] = useState<number | null>(null);
  const lineTotal = order.lines.reduce((a, l) => a + l.amount_paise, 0);

  return (
    <div className="lines">
      <p className="note">
        A category here belongs to the <b>product</b>, not to this order — filing one line files
        every purchase of that product, everywhere. That is what makes it cheap: once per
        product, not once per order.
      </p>

      {/* FOUR columns, not five. The product and its category were two columns saying one
          thing, and splitting them cost the reader the very sentence needs them to read:
          "Sprite Zero is Groceries". Together in one column, the name sits directly above the
          select, so the control IS the statement — and the table loses a column of clutter. */}
      <table className="pick-table">
        <colgroup>
          <col />
          <col style={{ width: "48px" }} />
          <col style={{ width: "104px" }} />
          <col style={{ width: "340px" }} />
        </colgroup>
        <thead>
          <tr>
            <th>Line</th>
            <th className="r">Qty</th>
            <th className="r">Amount</th>
            <th>Product, and what it is</th>
          </tr>
        </thead>
        <tbody>
          {order.lines.map((line) => (
            <LineRow
              key={line.index}
              artifactId={order.artifact_id}
              line={line}
              answer={answers.get(overrideKey(order.artifact_id, line.index))}
              onAnswer={onAnswer}
              categories={categories}
              freshCategories={freshCategories}
              onCategorised={onCategorised}
              open={openLine === line.index}
              onOpen={() => setOpenLine(openLine === line.index ? null : line.index)}
            />
          ))}
        </tbody>
      </table>

      {/* The arithmetic that decides whether the parse is trustworthy at all. makes the
          reconcile gate the strongest thing these invoices give us, and a line total that does
          not reach the order total is the visible half of it — so it is stated rather than
          assumed, and stated as a difference rather than as a pass. */}
      <div className="editor-foot">
        <span className="soft linked-note">
          {order.lines.length} lines · <b className="mono">{rupees(lineTotal)}</b>
          {/* One order is N invoices —. Said here rather than on the row, because it
              explains the line count and explains nothing about the money. */}
          {order.invoice_count > 1 && ` · across ${order.invoice_count} invoices`}
          {lineTotal !== order.total_paise && (
            <span className="flag">
              {" · "}
              {rupees(Math.abs(order.total_paise - lineTotal))} apart from the order total
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

function LineRow({
  artifactId,
  line,
  answer,
  onAnswer,
  categories,
  freshCategories,
  onCategorised,
  open,
  onOpen,
}: {
  artifactId: string;
  line: StagedLine;
  answer: LineAnswer | undefined;
  onAnswer: (key: string, next: LineAnswer | null) => void;
  categories: Category[];
  freshCategories: Map<string, { id: number; name: string } | null>;
  onCategorised: (itemId: string, category: { id: number; name: string } | null) => void;
  open: boolean;
  onOpen: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const key = overrideKey(artifactId, line.index);
  const verdict = verdictOf(line, answer);
  const itemId = itemIdOf(line, answer);
  const close = bestCandidate(line.resolution.candidates);

  // WHOSE category is on screen. `has`, not `??`: a cleared category is stored as `null`, and
  // `??` would fall through to the value the server sent and redraw the category the person
  // just removed. Null-versus-absent, and they are different answers.
  const pointsElsewhere =
    answer !== undefined &&
    ("create_new" in answer.answer || answer.answer.item_id !== line.resolution.item_id);
  const fromServer =
    line.category === null || pointsElsewhere
      ? null
      : // Ids arrive as strings (pg renders BIGINT as one) and CategorySelect compares numbers.
        { id: Number(line.category.id), name: line.category.name };
  const category =
    itemId !== null && freshCategories.has(itemId)
      ? (freshCategories.get(itemId) ?? null)
      : fromServer;

  // The picker is labelled with the PRODUCT, never the line description — its second half.
  // Said by construction: the name sits directly above the select, in the same column, so the
  // control reads "this product is filed under this" rather than "this line is".
  //
  // The person's own answer wins, and it has to carry its own label: a product found through
  // the catalogue SEARCH appears nowhere in this line's resolution, so falling back to
  // `resolution.item_name` there would label the picker with the product they had just moved
  // away from — the control would name one product and file another.
  const product =
    answer !== undefined && "item_id" in answer.answer
      ? answer.label
      : (line.resolution.item_name ?? line.description);

  async function fileUnder(categoryId: number | null) {
    if (itemId === null) return;
    setBusy(true);
    setError(null);
    try {
      // PATCH /items/:id — an integer or an explicit null, which is a real answer ("no category
      // yet"), not a missing one. The route defaults `category_source` to 'user', the
      // provenance the classifier may never overwrite, so nothing has to be said here.
      await mutate(`/items/${itemId}`, {
        method: "PATCH",
        body: JSON.stringify({ category_id: categoryId }),
      });
      onCategorised(
        itemId,
        categoryId === null
          ? null
          : { id: categoryId, name: categories.find((c) => c.id === categoryId)?.name ?? "filed" },
      );
    } catch (e) {
      // Kept on the line: the refusal is about THIS product, and lifting it to the top of the
      // screen would separate it from the only control that can act on it.
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Fragment>
      <tr className={busy ? "line-row is-writing" : "line-row"}>
        {/* The invoice's own words, one line. The SKU used to sit under it and made every row
            two lines tall for a code nobody reads while scanning — it belongs in the picker,
            where the question it answers ("is this the same product?") is actually asked. */}
        <td>
          {/* `kind` said in one word, and only where it is not "goods". A delivery charge is
              not a product, so the row that offers to file it as one should say so. */}
          <span className="clip">
            {line.description}
            {line.kind === "fee" && " · fee"}
          </span>
        </td>
        <td className="mono r soft">{line.qty}</td>
        <td className="mono r">{rupees(line.amount_paise)}</td>
        <td>
          <div className="line-product">
            <button type="button" className="line-verdict" onClick={onOpen}>
              <span className="clip">
                {verdict === "new"
                  ? "New product"
                  : verdict === "input"
                    ? close === null
                      ? "No close match"
                      : `${close.name} · ${close.similarity}%`
                    : product}
              </span>
              <span className={`tag-claim ${verdict}`}>
                {verdict === "input" ? "needs input" : verdict}
              </span>
              <span className="soft line-chev">{open ? "▴" : "▾"}</span>
            </button>
            {itemId === null ? (
              // Nothing to PATCH yet: the product does not exist until this order is confirmed.
              // Said rather than shown as a disabled control, which would invite a click that
              // cannot do anything — the same call CategoryChoice makes for a record the map
              // already answered.
              <span className="soft line-said">
                {verdict === "input" ? "pick a product first" : "filed after it lands"}
              </span>
            ) : (
              <CategorySelect
                value={category === null ? null : category.id}
                categories={categories}
                onChange={(id) => void fileUnder(id)}
                placeholder="No category yet"
                disabled={busy}
              />
            )}
            {error !== null && <span className="debit save-error">{error}</span>}
          </div>
        </td>
      </tr>

      {open && (
        <tr className="line-detail">
          <td colSpan={4}>
            <ItemPicker
              resolution={line.resolution}
              answer={answer}
              description={line.description}
              // The merchant's own id for this line. It is the evidence behind the question —
              // makes a DIFFERENT sku from the same merchant a hard refusal to merge — so
              // it lives where the question is asked rather than on every scanned row.
              code={line.sku ?? line.hsn}
              onAnswer={(next) => onAnswer(key, next)}
              onClear={() => onAnswer(key, null)}
            />
          </td>
        </tr>
      )}
    </Fragment>
  );
}
