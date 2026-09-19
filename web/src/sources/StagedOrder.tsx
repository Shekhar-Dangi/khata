import { Fragment } from "react";

import { rupees } from "../shared/format";
import ItemCombo from "./ItemCombo";
import {
  dayMonth,
  openLines,
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
// THE MATCH IS ON THE ROW, not inside the panel. "Will attach to Card −₹120.00 on 08 Aug" is the
// single most useful line on the screen, and a fact you have to open something to see is a fact
// most people will confirm without.

export default function StagedOrder({
  order,
  picked,
  onPick,
  answers,
  mapped,
  onMap,
  expanded,
  onExpand,
}: {
  order: Order;
  picked: boolean;
  onPick: () => void;
  answers: Map<string, LineAnswer>;
  mapped: Map<string, { id: string; name: string } | null>;
  onMap: (canonical: string, item: { id: string; name: string } | null) => void;
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
          <td className="order-detail" colSpan={5}>
            <Lines order={order} mapped={mapped} onMap={onMap} />
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
 * commonest reason is that the statement covering that month has not been imported (real data
 * showed exactly this), and `POST /evidence/rematch` finds it later without anyone
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
  // Attaching is done in ONE place — the confirmed list, with the same picker Splitwise uses —
  // so the inbox says where rather than offering a second way to do it.
  const where = "Confirm it, then pick the payment under “on your ledger”";
  if (match.kind === "ambiguous") {
    return <span className="flag" title={where}>more than one match{caret}</span>;
  }
  return <span className="soft" title={where}>no bank row{caret}</span>;
}

/**
 * The line items of one order.
 *
 * ONE decision per line, not two. Filing a category used to live here as well, and it was the
 * wrong level: a category belongs to the product, so answering it per line asks the same
 * question once per sighting and invites a different answer each time. The Products tab asks
 * it once, and this table asks only which catalogue item the line is.
 */
function Lines({
  order,
  mapped,
  onMap,
}: {
  order: Order;
  mapped: Map<string, { id: string; name: string } | null>;
  onMap: (canonical: string, item: { id: string; name: string } | null) => void;
}) {
  const lineTotal = order.lines.reduce((a, l) => a + l.amount_paise, 0);

  return (
    <div className="lines">
      {/* Six columns, each a short label over one fact: what the invoice said, how many, what
          one cost, what the line came to, the key we reduced it to, and which catalogue item it
          lands on. The last is an input rather than a link to a panel — see ItemCombo. */}
      <table className="pick-table">
        <colgroup>
          <col />
          <col style={{ width: "46px" }} />
          <col style={{ width: "88px" }} />
          <col style={{ width: "92px" }} />
          <col style={{ width: "206px" }} />
          <col style={{ width: "236px" }} />
        </colgroup>
        <thead>
          <tr>
            <th>Raw value</th>
            <th className="r">Qty</th>
            <th className="r">Price</th>
            <th className="r">Amount</th>
            <th>Normalized</th>
            <th>Catalogue item</th>
          </tr>
        </thead>
        <tbody>
          {order.lines.map((line) => (
            <LineRow
              key={line.index}
              line={line}
              mapped={mapped}
              onMap={onMap}
            />
          ))}
        </tbody>
      </table>

      {/* The arithmetic that decides whether the parse is trustworthy at all. The reconcile
          gate is the strongest thing these invoices give us, and a line total that does
          not reach the order total is the visible half of it — so it is stated rather than
          assumed, and stated as a difference rather than as a pass. */}
      <div className="editor-foot">
        <span className="soft linked-note">
          {order.lines.length} lines · <b className="mono">{rupees(lineTotal)}</b>
          {/* One order is N invoices, one per legal seller. Said here rather than on the row,
              because it explains the line count and explains nothing about the money. */}
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

/**
 * One line of an invoice, and where it lands.
 *
 * It no longer carries a CATEGORY. A category belongs to the product, not to the line — filing
 * it here meant answering the same question once per sighting, twelve times for one milk, and
 * getting a different answer on the twelfth. The Products tab files it once. This row's only
 * question is which catalogue item the line resolves to, and that is now a box you type in
 * rather than a panel that opens under the row.
 */
/**
 * One line of an invoice, and where it lands.
 *
 * IT ANSWERS FOR THE PRODUCT, NOT THE LINE. Choosing a catalogue item here writes the same
 * mapping the Products tab writes, keyed by the normalised name — so the choice shows up on
 * that tab, and on every other line of every other order that reduces to the same key.
 *
 * That is not a convenience, it is the only coherent reading: two lines with one canonical key
 * resolve to one item by construction, so letting them be mapped to different products would
 * be an answer the catalogue cannot hold. It also removes the surprise this fixed — mapping a
 * name here and finding the Products tab still offering to create it.
 *
 * There is no CATEGORY here either. That belongs to the product, and asking per line asks the
 * same question once per sighting.
 */
function LineRow({
  line,
  mapped,
  onMap,
}: {
  line: StagedLine;
  mapped: Map<string, { id: string; name: string } | null>;
  onMap: (canonical: string, item: { id: string; name: string } | null) => void;
}) {
  // The person's answer wins over the resolver's proposal. `has`, not `??`: a key mapped to
  // null is a real answer ("create one") and must not fall through to the name the resolver
  // suggested — null-versus-absent, and they are different states.
  const answered =
    line.canonical !== null && mapped.has(line.canonical)
      ? (mapped.get(line.canonical) ?? null)
      : undefined;
  const chosenName =
    answered !== undefined ? (answered?.name ?? null) : (line.resolution.item_name ?? null);
  const itemId = answered !== undefined ? (answered?.id ?? null) : line.resolution.item_id;

  return (
    <Fragment>
      <tr className="line-row">
        {/* `title` carries the whole string. These run past ninety characters and the column
            cannot, so the cell truncates and hovering reads it out in full — the alternative is
            a row three lines tall on every line of every order. */}
        <td title={line.description}>
          <span className="clip">
            {line.description}
            {line.kind === "fee" && " · fee"}
          </span>
        </td>

        <td className="mono r soft">{line.qty}</td>
        {/* The invoice's own unit figure, never amount ÷ qty: the two differ by tax and
            discount, and inventing the division would quietly contradict the document. */}
        <td className="mono r soft">{rupees(line.unit_paise)}</td>
        <td className="mono r">{rupees(line.amount_paise)}</td>

        <td title={line.canonical ?? undefined}>
          <span className="clip mono soft">{line.canonical ?? "—"}</span>
        </td>

        {/* `combo-cell` is what lets the catalogue popover leave this cell. Named rather than
            selected by position, so widening it can never reach a cell that must truncate. */}
        <td className="combo-cell">
          {line.kind === "fee" ? (
            // A fee is money, not merchandise. It never reaches the catalogue, so there is
            // nothing to pick and a disabled box would only invite a click.
            <span className="soft">not a product</span>
          ) : (
            <ItemCombo
              value={chosenName}
              itemId={itemId}
              // What the resolver proposed for THIS line. Offered before anything is typed,
              // which is the moment they answer the question.
              suggestions={line.resolution.candidates}
              onPick={(item) => onMap(line.canonical ?? line.description, item)}
            />
          )}
        </td>
      </tr>
    </Fragment>
  );
}
