import { useBusy } from "./useFetch";

/**
 * THE loading state, everywhere: a thin moving line WHERE the content will appear — never text.
 *
 * Owner's rule (2026-09-19), after the app had grown three answers to one question: a
 * "Loading…" sentence on most pages, a line on a few, and nothing at all under some expanded
 * rows — a blank gap that read as broken. A page loads with the line at its top; an expanded
 * row loads with the line inside the expansion, which is the only place anyone is looking.
 *
 * Through `useBusy`, so the line stays dark for anything that answers in under ~90ms and never
 * flashes on and off inside one frame — most requests here are that fast, and a line that
 * blinks for every one of them would be worse than none. It is always rendered, lit or not,
 * so lighting it never moves the layout.
 */
export default function LoadingLine({ on = true }: { on?: boolean }) {
  const lit = useBusy(on);
  return (
    <div className={"busybar" + (lit ? " on" : "")} aria-hidden="true">
      <i />
    </div>
  );
}
