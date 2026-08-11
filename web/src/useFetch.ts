import { useEffect, useState } from "react";

// A custom hook: our useEffect fetch pattern extracted so every view reuses it.
// Returns { data, loading, error } and re-fetches whenever `url` changes.
// The cleanup flag (`cancelled`) ignores a stale response if the component
// unmounts or `url` changes mid-flight — the fetch-race guard.
export function useFetch<T>(url: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0); // bump to force a re-fetch of the same url

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
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
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true; // stale response from a previous url is discarded
    };
  }, [url, tick]);

  const refetch = () => setTick((t) => t + 1);
  return { data, loading, error, refetch };
}
