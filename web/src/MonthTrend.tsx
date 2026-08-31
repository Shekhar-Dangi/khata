import { useState } from "react";

import { rupees } from "./format";
import { monthLabel, type MonthRow } from "./reports";

// The soul metric over TIME.
//
// Every other figure in this app is a snapshot, which leaves the one question the product
// exists to answer unanswerable: is unexplained money going down? A metric whose whole
// meaning is directional needs a direction.
//
// Stacked columns, not three lines. The three states are PARTS OF ONE WHOLE — they sum to
// money out, exactly, every month (the endpoint's own invariant) — and a stack shows both
// the total and the split in one mark. Three separate lines would show the split and hide
// the total, and invite reading a rise in "confirmed" as spending going up when it is only
// work being done.
//
// Unexplained sits at the BOTTOM of the stack on purpose: a segment resting on the axis is
// the only one whose height can be compared across columns without the eye having to
// discount a shifting baseline. It is the number you are trying to move, so it gets the
// readable position.
const H = 168; // plot height in viewBox units
const W = 640;
const PAD_L = 8;
const PAD_B = 22;

export default function MonthTrend({ months }: { months: MonthRow[] }) {
  const [hover, setHover] = useState<string | null>(null);

  if (months.length === 0) {
    return <p className="soft">No months in this period.</p>;
  }

  // Scale to the tallest column so the shape is readable, and label the peak so the scale
  // is never a guess. Months with no spend are absent from the response rather than zero —
  // a gap in a statement is missing data, not a month you spent nothing.
  const max = Math.max(...months.map((m) => m.out_paise), 1);
  const bandWidth = (W - PAD_L * 2) / months.length;
  const barWidth = Math.min(46, bandWidth * 0.6);

  const last = months[months.length - 1]!;
  const previous = months.length > 1 ? months[months.length - 2]! : null;

  // Month over month, NOT first versus last.
  //
  // First-versus-last is fragile precisely where it matters: the earliest month in a
  // statement import is usually a PARTIAL one. On this ledger the first month held a quarter of
// the next month's rows, so anchoring to it reported "up 440%" in red while unexplained money had in fact fallen by two thirds — a large improvement shown as a
  // regression. A chart that inverts the direction of the thing it exists to show is worse
  // than no chart.
  //
  // The comparison is NAMED in the label rather than left implicit, because the last month
  // is often partial too and the reader has to be able to discount that themselves.
  const delta =
    previous === null || previous.unexplained_paise === 0
      ? null
      : ((last.unexplained_paise - previous.unexplained_paise) /
          previous.unexplained_paise) *
        100;

  const shown = months.find((m) => m.month === hover) ?? last;

  return (
    <div className="trend">
      <div className="trend-head">
        <div>
          <span className="trend-label">Unexplained, {monthLabel(shown.month + "-01")}</span>
          <span className="trend-value st-unexplained">
            {rupees(shown.unexplained_paise)}
          </span>
        </div>
        {delta !== null && months.length > 1 && (
          <span className={"trend-delta " + (delta <= 0 ? "good" : "bad")}>
            {delta <= 0 ? "↓" : "↑"} {Math.abs(delta).toFixed(0)}% vs{" "}
            {monthLabel(previous!.month + "-01")}
          </span>
        )}
      </div>

      <svg
        viewBox={`0 0 ${W} ${H + PAD_B}`}
        className="trend-svg"
        role="img"
        aria-label={
          "Money out per month, split into unexplained, provisional and confirmed. " +
          months
            .map((m) => `${monthLabel(m.month + "-01")}: ${rupees(m.unexplained_paise)} unexplained`)
            .join("; ")
        }
      >
        {months.map((m, i) => {
          const x = PAD_L + i * bandWidth + (bandWidth - barWidth) / 2;
          const h = (v: number) => (v / max) * H;
          // Bottom-up: unexplained on the axis, then provisional, then confirmed.
          const uh = h(m.unexplained_paise);
          const ph = h(m.provisional_paise);
          const ch = h(m.confirmed_paise);
          const active = hover === null || hover === m.month;
          return (
            <g
              key={m.month}
              opacity={active ? 1 : 0.35}
              onMouseEnter={() => setHover(m.month)}
              onMouseLeave={() => setHover(null)}
            >
              {/* A full-height hit area, so hovering the empty space above a short column
                  still selects that month. Without it only the bar itself responds and the
                  smallest month — usually the interesting one — is the hardest to hit. */}
              <rect
                x={PAD_L + i * bandWidth}
                y={0}
                width={bandWidth}
                height={H}
                fill="transparent"
              />
              <rect x={x} y={H - uh} width={barWidth} height={uh} className="seg-unexplained" />
              <rect x={x} y={H - uh - ph} width={barWidth} height={ph} className="seg-provisional" />
              <rect x={x} y={H - uh - ph - ch} width={barWidth} height={ch} className="seg-confirmed" />
              <text x={x + barWidth / 2} y={H + 15} className="trend-tick">
                {monthLabel(m.month + "-01")}
              </text>
            </g>
          );
        })}
        <line x1={0} y1={H} x2={W} y2={H} className="trend-axis" />
      </svg>

      <div className="trend-legend">
        <span><i className="seg-unexplained" /> unexplained {rupees(shown.unexplained_paise)}</span>
        <span><i className="seg-provisional" /> a rule guessed {rupees(shown.provisional_paise)}</span>
        <span><i className="seg-confirmed" /> you confirmed {rupees(shown.confirmed_paise)}</span>
        <span className="soft">
          {shown.transactions} rows · {rupees(shown.out_paise)} out
        </span>
      </div>
    </div>
  );
}
