// One way to make a WRITE request.
//
// `useFetch` covers reads. Writes were each hand-rolling the same block — and the ones
// that did not were the bug: seven call sites did `await fetch(...)` and never looked at
// the response, so a failed DELETE or a refused confirm looked exactly like success. The
// list refetched, the row was still there, and nothing on screen said why.
//
// Silent partial success is the worst shape a bug can take in a tool whose whole claim is
// being honest about numbers, so the failure path is the one that gets the helper.
/** Said whenever the API process itself is not answering, however that surfaced. */
export const UNREACHABLE =
  "Could not reach the app's server. Is the backend running on :3000?";

export async function mutate<T = Record<string, unknown>>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  let res: Response;
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
    throw new Error(UNREACHABLE);
  }

  // 502/503/504 through the dev proxy mean the API process is not running. "request
  // failed: 502" is true and useless — it names the messenger, not the problem, and the
  // action it should prompt (start the backend) is nowhere in it.
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    throw new Error(UNREACHABLE);
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
