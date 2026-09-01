// Vercel serverless entry.
//
// An Express app IS a `(req, res)` function, which is exactly the shape a Vercel Node
// function must export — so there is no adapter here, just a re-export. `src/server.ts`
// only calls listen() when it is the program being run, so importing it yields a
// configured app and starts nothing.
//
// This file is BUNDLED before deploy (see `build:api`) rather than handed to Vercel as
// TypeScript. The app's source uses explicit `.ts` import specifiers — Node's ESM
// requirement, and the thing that lets the server run with no build step at all — and a
// platform's own TypeScript pipeline is not obliged to understand them. Bundling makes
// what gets deployed a thing this repo produced and can inspect, rather than a thing a
// vendor produced from source it interpreted its own way.
import { app } from "../src/server.ts";

export default app;
