import { createContext, useCallback, useContext, useId, useLayoutEffect, useState } from "react";

// What every section of the Sources page is waiting on, gathered in one place so the PAGE can
// decide what to show — not each section on its own.
//
// THE PROBLEM IT SOLVES. Each section fetched for itself and drew its own loading state: the
// Splitwise list appeared, then the invoice inbox drew a moving line and "Reading the invoice
// inbox…", then popped in ABOVE the list and pushed it down. Every request on the page was
// measured under 100ms (2026-09-19) — nothing was slow. It was the STAGGER: sections arriving
// one at a time, each announcing itself.
//
// So sections REPORT, and the page waits for all of them once, draws everything together, and
// owns the one loading line. This is the same lesson as `ledgerVersion` — state that several
// subtrees need lives above all of them — applied to "are we ready" instead of "what changed".
//
// Outside a Sources page (the tab's own "reading 2/5" count, in the nav) the default reporter
// does nothing, so a component can report without knowing where it is mounted.

type SectionState = { loading: boolean; refreshing: boolean };
type Report = (id: string, state: SectionState | null) => void;

export const PageActivityContext = createContext<Report>(() => {});

/**
 * The page's side: collect every section's state.
 *
 * `ready` is vacuously true before any section has reported, which would be a lie on the first
 * render — but sections report in a LAYOUT effect, which React runs and flushes before the
 * browser paints, so the first frame anyone sees already knows who is still loading.
 */
export function usePageActivityRoot() {
  const [sections, setSections] = useState<Record<string, SectionState>>({});

  const report = useCallback<Report>((id, state) => {
    setSections((held) => {
      const current = held[id];
      if (state === null) {
        if (current === undefined) return held;
        const { [id]: _gone, ...rest } = held;
        return rest;
      }
      // Same answer twice is not a change. Returning the SAME object is what stops a report
      // from re-rendering the page, which would re-render every section, which would report.
      if (current !== undefined && current.loading === state.loading && current.refreshing === state.refreshing) {
        return held;
      }
      return { ...held, [id]: state };
    });
  }, []);

  const states = Object.values(sections);
  return {
    report,
    ready: states.every((s) => !s.loading),
    refreshing: states.some((s) => s.refreshing),
  };
}

/** A section's side: say whether this section is still loading, or re-reading. */
export function useReportActivity(loading: boolean, refreshing: boolean) {
  const report = useContext(PageActivityContext);
  // useId, not a name the caller picks: two copies of one section (two open imports) must not
  // overwrite each other's report and let the page believe one of them had finished.
  const id = useId();
  useLayoutEffect(() => {
    report(id, { loading, refreshing });
  }, [report, id, loading, refreshing]);
  // Separate, so leaving removes the report instead of leaving a section "loading" forever —
  // which would hold the page's line on after the section it belonged to was gone.
  useLayoutEffect(() => () => report(id, null), [report, id]);
}
