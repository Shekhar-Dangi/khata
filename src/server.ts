import express from "express";
import path from "node:path";

import { errorHandler, notFoundHandler } from "./http.ts";
import { accounts } from "./routes/accounts.ts";
import { categories } from "./routes/categories.ts";
import { evidence } from "./routes/evidence.ts";
import { reports } from "./routes/reports.ts";
import { rules } from "./routes/rules.ts";
import { transactions } from "./routes/transactions.ts";
import { transfers } from "./routes/transfers.ts";

// The server is a wiring diagram now, and nothing else. Everything it used to hold lives
// in a module named after what it does:
//
//   routes/*      one file per resource — the HTTP layer, and only that
//   detect.ts     the DB half of transfer detection (its pure half is transfers.ts)
//   reconcile.ts  the balance walk
//   accounts.ts   account lookups + the import fingerprint
//   spend.ts      EXPLAINABLE_SPEND — the one definition of what counts as spending
//   http.ts       withTransaction, HttpError, the error handler
//   filters.ts / rules.ts / transfers.ts   pure, DB-free, and where the tests live
//
// If this file ever starts growing again, the thing being added belongs somewhere else.

const PORT = Number(process.env.PORT) || 3000;

// DEMO_MODE marks a PUBLIC deployment carrying generated data: a place to click around
// before deciding whether to run it locally. It changes two things and nothing else —
// the app shows a banner saying what this is, and the local-model endpoint stops
// pretending it could work, because a hosted box has no Ollama on loopback.
//
// It is NOT a security boundary. There is no authentication in this app at all; see the
// note on /health below.
export const DEMO_MODE = process.env.DEMO_MODE === "1";

export const app = express();
// Parse JSON request bodies into req.body. Returns 400 automatically if the body is
// malformed — that rejection arrives at errorHandler as `entity.parse.failed`.
app.use(express.json());

// Health is genuinely about the SERVER rather than any resource, so it is the one route
// that belongs in this file.
// `demo` is here so ONE build works everywhere: the frontend asks the server what it is
// rather than being compiled for a particular deployment. A build-time flag would mean two
// artefacts and a way to ship the wrong one.
app.get("/health", (_req, res) => {
  res.json({ ok: true, demo: DEMO_MODE });
});

// Routers are mounted at the ROOT and declare their own full paths, rather than being
// mounted under a prefix. Two reasons, both practical:
//
//  - The concern and the URL do not always agree. `/accounts/:id/keywords` and
//    `/accounts/:id/detect-transfers` are account-shaped URLs but entirely a transfers
//    concern; prefix-mounting would force them into a file where they do not belong.
//  - A full path written in one piece is a path you can GREP. Search `/rules/apply` and
//    you land on the handler, instead of having to know it is `/apply` inside a router
//    mounted somewhere else.
//
// Order is not load-bearing here — no two paths in this app shadow each other — but it is
// alphabetical so that stays easy to check.
app.use(accounts);
app.use(categories);
app.use(evidence);
app.use(reports);
app.use(rules);
app.use(transactions);
app.use(transfers);

// In a deployment the API also serves the built frontend, so the whole thing is one
// origin and one process: no CORS, no second host, and the paths the Vite proxy handles in
// dev need no production equivalent.
//
// The fallback is deliberately NARROW. Serving index.html for anything unmatched would
// recreate this codebase's most-documented trap: a mistyped or missing API path answering
// 200 with HTML, which surfaces far away as "JSON.parse: unexpected character". So it
// answers only GETs that actually asked for HTML — a browser navigating. An API client
// sends Accept: application/json and falls through to the JSON 404 below, where it should.
if (process.env.SERVE_WEB === "1") {
  const dist = path.resolve(import.meta.dirname, "../web/dist");
  app.use(express.static(dist));
  app.get(/.*/, (req, res, next) => {
    if (req.accepts("html") && !req.accepts("json")) {
      return res.sendFile(path.join(dist, "index.html"));
    }
    return next();
  });
}

// Anything unmatched, then the one place a thrown error becomes a response. Both must
// come AFTER every router: Express walks this stack in order, and a 404 handler
// registered early answers every request in the app.
app.use(notFoundHandler);
app.use(errorHandler);

// Listen ONLY when this file is the program being run.
//
// The ESM equivalent of `require.main === module`. A serverless host imports this module to
// get the app and drives it itself — calling listen() there would bind a port nothing is
// routing to, and on some platforms hang the invocation until it times out. Running
// `node src/server.ts` still starts a server, unchanged.
if (import.meta.filename === process.argv[1]) {
  app.listen(PORT, () => {
    console.log(`listening on http://localhost:${PORT}`);
  });
}
