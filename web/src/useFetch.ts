import { useEffect, useRef, useState } from "react";

// A custom hook: our useEffect fetch pattern extracted so every view reuses it.
// Returns { data, loading, refreshing, error, refetch }.
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
export function useFetch<T>(url: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState(true);
  const [tick, setTick] = useState(0); // bump to force a re-fetch of the same url
  const lastUrl = useRef(url);

  useEffect(() => {
    let cancelled = false;

    // A CHANGED url means the data we are holding describes a different resource, so
    // it must go and the view should show its loading state. A refetch of the SAME
    // url keeps the old data on screen while the new response is in flight.
    if (lastUrl.current !== url) {
      lastUrl.current = url;
      setData(null);
    }
    setInFlight(true);
    setError(null);

    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`request failed: ${res.status}`);
        const json = (await res.json()) as T;
        if (!cancelled) setData(json);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Unknown error");
      } finally {
        if (!cancelled) setInFlight(false);
      }
    })();

    return () => {
      cancelled = true; // stale response from a previous url is discarded
    };
  }, [url, tick]);

  const refetch = () => setTick((t) => t + 1);

  return {
    data,
    loading: inFlight && data === null, // nothing to show yet
    refreshing: inFlight, // a request is in flight, stale data may still be on screen
    error,
    refetch,
  };
}
