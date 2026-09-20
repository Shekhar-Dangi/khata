// One way to make a WRITE request.
//
// `useFetch` covers reads. Writes were each hand-rolling the same block — and the ones
// that did not were the bug: seven call sites did `await fetch(...)` and never looked at
// the response, so a failed DELETE or a refused confirm looked exactly like success. The
// list refetched, the row was still there, and nothing on screen said why.
//
// Silent partial success is the worst shape a bug can take in a tool whose whole claim is
// being honest about numbers, so the failure path is the one that gets the helper.
import { RESTART_RETRY_MS } from "./useFetch.ts";

/** Said whenever the API process itself is not answering, however that surfaced. */
export const UNREACHABLE =
  "Could not reach the app's server. Is the backend running on :3000?";

export async function mutate<T = Record<string, unknown>>(
  url: string,
  init?: RequestInit,
  /**
   * `idempotent: true` retries the write across an API restart, the way reads already do.
   *
   * OFF BY DEFAULT, and it has to stay that way: a 502 can arrive AFTER the server has
   * processed a write, so repeating a confirm or an import blindly would double it. Pass it
   * only where running twice is defined to be the same as running once — the routes that
   * answer `already: true` rather than doing the work again.
   *
   * MEASURED, and the reason this exists: in development the API restarts far more often
   * than anyone edits it, and a write that lands in that window is simply lost. One such
   * loss left a document queued and never started, with the screen reporting it as in
   * flight — the failure that is worth a retry is exactly the one nobody can see.
   */
  { idempotent = false }: { idempotent?: boolean } = {},
): Promise<T> {
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    const restarting = attempt < RESTART_RETRY_MS.length && idempotent;
    try {
      res = await fetch(url, {
        ...init,
        headers:
          init?.body === undefined
            ? init?.headers
            : { "Content-Type": "application/json", ...init?.headers },
      });
    } catch {
      // fetch only REJECTS on a network-level failure; an HTTP error is a resolved promise.
      // So this branch is "the request never reached anything", which is a different thing
      // to tell someone than a status code.
      if (!restarting) throw new Error(UNREACHABLE);
      await new Promise((r) => setTimeout(r, RESTART_RETRY_MS[attempt]));
      continue;
    }

    // 502/503/504 through the dev proxy mean the API process is not running. "request
    // failed: 502" is true and useless — it names the messenger, not the problem, and the
    // action it should prompt (start the backend) is nowhere in it.
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      if (!restarting) throw new Error(UNREACHABLE);
      await new Promise((r) => setTimeout(r, RESTART_RETRY_MS[attempt]));
      continue;
    }
    break;
  }

  // Read as text first. A path missing from the Vite proxy answers 200 with index.html,
  // so the STATUS proves nothing — the body is what tells you. Checking the status alone
  // through that proxy is how "JSON.parse: unexpected character" ends up surfacing three
  // components away from the route that was never proxied.
  const text = await res.text();
  let body: Record<string, unknown> = {};
  if (text !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(
        `${url} did not return JSON (${res.status}). If this is a new route prefix, add it to web/vite.config.ts.`,
      );
    }
  }

  if (!res.ok) {
    // The server's own message where there is one: it knows why it refused, and
    // "category is in use" beats "request failed: 409" every time.
    throw new Error(
      typeof body.error === "string" ? body.error : `request failed: ${res.status}`,
    );
  }
  return body as T;
}

/** The message to show a person, from anything that was thrown. */
export function errorText(e: unknown, fallback = "Something went wrong"): string {
  return e instanceof Error ? e.message : fallback;
}
