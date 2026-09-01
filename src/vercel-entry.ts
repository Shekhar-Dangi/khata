// Vercel serverless entry.
//
// An Express app IS a `(req, res)` function, which is exactly the shape a Vercel Node
// function must export — so there is no adapter here, just a re-export. `src/server.ts`
// only calls listen() when it is the program being run, so importing it yields a
// configured app and starts nothing.
//
// It lives in src/ and NOT in api/, which matters more than it looks.
//
// Vercel discovers serverless functions from the SOURCE TREE, before the build command
// runs. A `.ts` file sitting in api/ is therefore compiled by Vercel's own TypeScript
// pipeline — which does not resolve the explicit `.ts` import specifiers this codebase
// uses (Node's ESM requirement, and the thing that lets the server run with no build step).
// The first deploy did exactly that and every request returned
// FUNCTION_INVOCATION_FAILED.
//
// So `api/` contains exactly one thing: `index.js`, the bundle produced from this file by
// `npm run build:api` — and it is COMMITTED, because a build artefact Vercel needs before
// it runs your build command has to already be there. CI regenerates it and the
// "no uncommitted changes" step fails if the committed bundle has gone stale, so the
// artefact cannot silently drift from its source.
import { app } from "./server.ts";

export default app;
