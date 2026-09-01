import { presets, type Period } from "../reports/reports";

// One date-range control, for every screen that filters by period.
//
// A preset dropdown AND two date inputs, both always visible, rather than a dropdown with
// a "Custom…" option that reveals them. The presets are shortcuts for the four ranges
// people ask for constantly; the inputs are the actual answer to "I want to see March".
// Hiding the general case behind the special case makes the general case feel like an
// advanced feature, when it is the plain one.
//
// Controlled: the range lives in the view that fetches with it. This component owns no
// state at all — which is what lets the ledger and the reports page share it without
// either of them having to sync a draft.
export default function DateRange({
  period,
  today,
  onChange,
}: {
  period: Period;
  /** Injected, not read from the clock here — presets() is pure and stays that way. */
  today: string;
  onChange: (next: Period) => void;
}) {
  const options = presets(today);
  // `<input type="date">` only ever emits a complete date or "", so a half-typed value
  // cannot reach us. The one invalid state left is a start after an end.
  const invalid = period.from !== "" && period.to !== "" && period.from > period.to;

  function setFrom(from: string) {
    // Dragging the start past the end is someone RE-PICKING the range, not asking for an
    // empty one — so the end follows. The alternative (refusing the keystroke) leaves the
    // control stuck until they work out which field it is unhappy about.
    const to = period.to !== "" && from > period.to ? from : period.to;
    onChange({ from, to, label: "Custom" });
  }

  function setTo(to: string) {
    const from = period.from !== "" && to < period.from ? to : period.from;
    onChange({ from, to, label: "Custom" });
  }

  return (
    <span className="daterange">
      <select
        className="cat-select"
        value={options.some((o) => o.label === period.label) ? period.label : "Custom"}
        onChange={(e) => {
          const preset = options.find((o) => o.label === e.target.value);
          if (preset !== undefined) onChange(preset);
        }}
      >
        {options.map((o) => (
          <option key={o.label} value={o.label}>
            {o.label}
          </option>
        ))}
        {/* Shown only once the range stops matching a preset. As a permanent option it
            would read as a mode you have to enter before the inputs work. */}
        {!options.some((o) => o.label === period.label) && (
          <option value="Custom">Custom</option>
        )}
      </select>

      <span className="daterange-inputs">
        <input
          type="date"
          aria-label="From date"
          className={period.from === "" ? "empty" : undefined}
          value={period.from}
          max={period.to === "" ? undefined : period.to}
          onChange={(e) => setFrom(e.target.value)}
        />
        <span className="soft">→</span>
        <input
          type="date"
          aria-label="To date"
          className={period.to === "" ? "empty" : undefined}
          value={period.to}
          min={period.from === "" ? undefined : period.from}
          onChange={(e) => setTo(e.target.value)}
        />
        {(period.from !== "" || period.to !== "") && (
          <button
            className="link-btn"
            title="Clear the date range"
            onClick={() => onChange({ from: "", to: "", label: "All time" })}
          >
            clear
          </button>
        )}
      </span>

      {invalid && <span className="debit save-error">start is after end</span>}
    </span>
  );
}

// Build the query params a range contributes. One place, so the ledger and the reports
// page cannot disagree about what an open-ended range means.
//
// An EMPTY end is open-ended, not "today" — "everything from 1 March" should keep
// including tomorrow's import without anyone editing the filter. Same for an empty start.
export function rangeParams(period: Period, into = new URLSearchParams()) {
  if (period.from !== "") into.set("from", period.from);
  if (period.to !== "") into.set("to", period.to);
  return into;
}
