import express from "express";

import { errorHandler, notFoundHandler } from "./http.ts";
import { accounts } from "./routes/accounts.ts";
import { categories } from "./routes/categories.ts";
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

const app = express();
// Parse JSON request bodies into req.body. Returns 400 automatically if the body is
// malformed — that rejection arrives at errorHandler as `entity.parse.failed`.
app.use(express.json());

// Health is genuinely about the SERVER rather than any resource, so it is the one route
// that belongs in this file.
app.get("/health", (_req, res) => {
  res.json({ ok: true });
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
app.use(reports);
app.use(rules);
app.use(transactions);
app.use(transfers);

// Anything unmatched, then the one place a thrown error becomes a response. Both must
// come AFTER every router: Express walks this stack in order, and a 404 handler
// registered early answers every request in the app.
app.use(notFoundHandler);
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`listening on http://localhost:${PORT}`);
});
