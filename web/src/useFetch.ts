import { useEffect, useRef, useState } from "react";

// A custom hook: our useEffect fetch pattern extracted so every view reuses it.
// Returns { data, loading, refreshing, isStale, error, refetch }.
//
// `loading` means "there is nothing to show yet" — NOT "a request is in flight".
// That distinction is the whole point. Views are written as:
//
//     if (x.loading) return <p>Loading…</p>;
//
// so if `loading` went true on every refetch, a background refresh would rip the
// existing content out of the DOM, show a spinner, and put fresh nodes back — which
// reads as a flash, and replays the .view reveal animation on the way in. Use
// `refreshing` when you want to show that a request is in flight without hiding
// what is already on screen.
//
// `keepPreviousData` extends that to URL CHANGES. By default a changed url clears the
// data, because the url naming a different resource means what we hold is wrong. But a
// url built from FILTERS names the same view with different parameters, and blanking
// the page on every filter tweak is exactly the flash we removed. Opt in there, and use
// `isStale` to dim what is on screen while the new result is in flight. React Query
// ships this under the same name for the same reason.
export function useFetch<T>(
  url: string,
  options: { keepPreviousData?: boolean } = {},
) {
  // Destructured to a PRIMITIVE before it reaches the dependency array. Putting the
  // options object itself in the deps would re-run the effect on every render, because
  // a caller writing `{ keepPreviousData: true }` inline creates a new object each time.
  const keepPreviousData = options.keepPreviousData ?? false;

  // data and the url it came from move together, so they live in one state object —
  // two separate useStates could be read in a torn state mid-update.
  const [result, setResult] = useState<{ data: T | null; url: string | null }>({
    data: null,
    url: null,
  });
  const [error, setError] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState(true);
  const [tick, setTick] = useState(0); // bump to force a re-fetch of the same url
  const lastUrl = useRef(url);

  useEffect(() => {
    let cancelled = false;

    if (lastUrl.current !== url) {
      lastUrl.current = url;
      if (!keepPreviousData) {
        setResult({ data: null, url: null });
      }
    }
    setInFlight(true);
    setError(null);

    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`request failed: ${res.status}`);
        const json = (await res.json()) as T;
        // Stamp the url the data came from, so `isStale` can tell whether what is on
        // screen matches what is currently being asked for.
        if (!cancelled) setResult({ data: json, url });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Unknown error");
      } finally {
        if (!cancelled) setInFlight(false);
      }
    })();

    return () => {
      cancelled = true; // stale response from a previous url is discarded
    };
  }, [url, tick, keepPreviousData]);

  const refetch = () => setTick((t) => t + 1);

  return {
    data: result.data,
    loading: inFlight && result.data === null, // nothing to show yet
    refreshing: inFlight, // a request is in flight; stale data may still be on screen
    // What is rendered belongs to a different url than the one being requested. Only
    // possible with keepPreviousData; the cue for dimming rather than blanking.
    isStale: result.url !== null && result.url !== url,
    error,
    refetch,
  };
}

// Delay a fast-changing value so it can be used to build a fetch url.
//
// Without this, a filter bound to a text input fires one request per keystroke: typing
// "blinkit" is seven requests, six of which are already obsolete when they land. The
// cleanup cancels the pending timer on every change, so only a pause actually commits.
export function useDebounced<T>(value: T, ms = 300): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer); // a new keystroke replaces the pending timer
  }, [value, ms]);

  return settled;
}

// Turn "a request is in flight" into "show a busy state", without flicker.
//
// The naive version — render a spinner whenever `active` is true — behaves badly at both
// ends. A request that finishes in 5ms flashes the indicator on and off within a single
// frame, which reads as a glitch rather than as feedback. And a request that finishes
// just after the indicator appears snaps it away before the eye registers it.
//
// So: wait `delay` before showing anything (fast requests stay invisible, which is
// correct — an instant answer IS the feedback), and once shown, stay up for at least
// `minDuration` (slow requests get a steady state instead of a blink).
export function useBusy(active: boolean, delay = 90, minDuration = 320): boolean {
  const [busy, setBusy] = useState(false);
  const shownAt = useRef<number | null>(null);

  useEffect(() => {
    if (active) {
      if (busy) return; // already showing — do not restart the clock
      const timer = setTimeout(() => {
        shownAt.current = Date.now();
        setBusy(true);
      }, delay);
      return () => clearTimeout(timer); // finished before `delay`: never show at all
    }

    if (!busy) return;
    // Showing, and the request is done — hold until the minimum has elapsed.
    const elapsed = shownAt.current === null ? minDuration : Date.now() - shownAt.current;
    const timer = setTimeout(
      () => {
        shownAt.current = null;
        setBusy(false);
      },
      Math.max(0, minDuration - elapsed),
    );
    return () => clearTimeout(timer);
  }, [active, busy, delay, minDuration]);

  return busy;
}
