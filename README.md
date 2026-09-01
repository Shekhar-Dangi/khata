# Khata

[![CI](https://github.com/Shekhar-Dangi/khata/actions/workflows/ci.yml/badge.svg)](https://github.com/Shekhar-Dangi/khata/actions/workflows/ci.yml)

**A local-first reconciliation tool for Indian bank statements, built around one number:
_money you can't explain yet_.**

A bank statement is the source of truth for *cash movement* — never for *meaning*. `UPI-Debit-123456789012-AMAZON INDIA-YESB0APLUPI` records that money left an account. It does not record what was bought. Khata is the layer that turns the first into the second, and is honest about the part it cannot.

Three months of real statements, 516 transactions, three banks, no data leaving the machine.

---

## The idea it's built on

Most personal-finance tools auto-categorise everything and show you a pie chart. That chart is a claim, and it is usually part guess. Khata refuses to blur the difference:

| State | Meaning |
|---|---|
| **Unexplained** | Money left the account and nothing accounts for it. The headline number |
| **Provisional** | A rule guessed. Re-runnable, reversible, and clearly not your word |
| **Confirmed** | You said so. A machine may never overwrite it |

A transaction's explanation is its **set of allocations** — a ₹2,300 order can be ₹1,500 groceries plus ₹800 household — and the unexplained remainder is *computed, never stored*, so it cannot drift from the rows it summarises.

The design consequence that matters: **a confident wrong label is worse than no label.** It doesn't reduce unexplained money, it converts it into *wrongly explained* money — and now the number lies while looking healthier. Every feature here is judged against that.

## What's actually interesting in here

**A converging rules engine.** A rule run computes what the rule-allocations *should* be and makes the table match, rather than appending. The acceptance test is the whole guarantee: run `POST /rules/apply` twice and the second must report `created: 0, removed: 0`. It also takes a **transaction-level user lock** — any allocation you wrote and the engine skips the whole row — because without it you can never deliberately leave money unexplained, and "money you can't explain yet" is the entire product.

**Transfer detection ordered by evidence strength.** Money moving between your own accounts appears twice and is not spending. Three passes run stage-by-stage across the whole ledger: the shared 12-digit UPI reference first (strong enough to resolve without asking), then account keywords, then amount-and-date (which only ever *proposes*). Running all three per account instead would let a coincidence on one account claim a leg another was about to match on the bank's own reference number.

**Deterministic rule mining, with a mandatory dry run.** Unexplained narrations are clustered into candidate rules scored by **spread** — how many *distinct categories* the rows a rule would claim already carry. Reach is not ambiguity: `amazon` matches a fifth of the ledger at spread 1 and is a strong rule; `paytm` at spread 3 is a payment rail pretending to be a merchant. Creating a rule lives *inside* its preview, so it cannot be made from a summary.

**A migration runner with its ledger inside the database.** One transaction per migration (possible only because Postgres has transactional DDL), a `pg_try_advisory_lock` so a second runner backs off instead of racing, and a checksum so an edited-after-applied migration is refused rather than silently skipped.

**Integer paise throughout.** Money is `BIGINT`, never float. `pg` returns `BIGINT` and `NUMERIC` as *strings*, so `"-230000" < "-500000"` is true unless you coerce — a real bug, found once, now guarded.

## The local LLM, and why it does almost nothing

The most useful thing in this repo is a feature that was **built, measured, and then demoted on the evidence**. Full write-up: the design.

The constraint was privacy — bank narrations never leave the machine — so the model is local (Ollama, `qwen3:4b`, loopback only). Running it over every unexplained transaction gave:

```
155 / 177 answered "Unknown"          (87.6% abstention)
```

That is not a broken model. It is the model correctly reporting that **a bank narration usually does not contain what you need to categorise a transaction.** Meanwhile the token histogram showed the unexplained tail was ~15 clusters, not a flat spread — and a concentrated tail is a rules problem, because a rule is deterministic, inspectable, re-runnable and permanent where a model call is none of those.

A follow-up benchmark on the slice where no rule is possible (merchants appearing exactly once) had `qwen3:8b` name **one row more than `qwen3:4b` out of 52**, for 56% more latency.

So the engine is deterministic clustering, and the model keeps the ~6% of one-off merchants nothing else can reach. Two things the measurement also produced:

- **The output schema is the latency control.** A free-text field in the JSON schema let the model spend **501 seconds** reasoning inside it; removing it gave 2.7s. `think:false` does not stop a reasoning model reasoning — it relocates it into whatever unconstrained string you offer.
- **Self-reported confidence carries no information.** 0.95 on a correct answer, 0.95 on "Unknown", 0.80 on a wrong one.

## Stack

TypeScript · Node (Express 5) · Postgres 18 · React 19 + Vite · Python for statement ingestion.

```
src/            one file per job; pure logic split from anything touching the DB
  rules.ts        the matcher and the rule vocabulary — no DB, no clock
  mining.ts       clustering and scoring — no DB, no clock
  transfers.ts    reference extraction and pairing — no DB, no clock
  routes/         one file per resource, full paths declared
db/
  schema.sql      the destination, for a fresh database
  migrations/     the only legal route there from one that holds data
web/src/        grouped by feature — ledger, rules, reports, transfers, shared
ingest/         Python parsers: Slice PDF (geometric), HDFC + Indian Bank (xlsx)
```

The pure/impure split is deliberate and load-bearing: `rules.ts`, `mining.ts` and `transfers.ts` are the code that can silently reclassify real money, so they are the code that unit tests can reach without a database.

## Trying it without setting anything up

There is a hosted demo carrying **generated data** — somewhere to click around and decide
whether it is worth running properly. It is deliberately limited, and the limits are the
honest part:

- **No sign-in, and no user model at all.** One shared database. Anything you change,
  everyone sees, and it may be reset without warning. **Do not enter real financial
  details.** Auth is not a missing feature here so much as an unmade decision — see below.
- **No local model.** Category suggestions run a model on *your* machine, which is the
  entire privacy design, so that one endpoint answers `501` on the demo and says so.
- Everything else is real: import, transfer detection, rules, mining, bulk confirm,
  reports, the trend.

The app says all of this in a banner rather than leaving you to find out.

### Deploying your own

One process serves the API *and* the built frontend, so it is one service and one database:

```sh
DEMO_MODE=1     # banner on, local-model endpoint answers 501 honestly
SERVE_WEB=1     # this process also serves web/dist
DATABASE_URL=…  # provided by the host

npm ci && npm ci --prefix web && npm run build --prefix web
npm run seed:demo      # refuses to run against a database that already holds data
npm run start:demo
curl -X POST $URL/rules/apply   # once, so the demo opens on rules having done something
```

`render.yaml` wires exactly that up, but nothing about it is Render-specific — it maps onto
any host that runs a Node process and hands it a `DATABASE_URL`.

**On authentication.** Khata is local-first: the intended deployment is your own machine,
where the operating-system account *is* the boundary, and adding a login would be
ceremony guarding a database only you can reach. That stops being true the moment it is
hosted, which is why the demo carries generated data and says so. Real multi-user auth is
not a small change — it decides whether accounts, rules and categories become per-user, and
that reaches the schema and every query — so it is deliberately unbuilt rather than
half-built.

## Running it

Requires **Node ≥ 24** (the server runs TypeScript directly, with no build step) and Postgres 18.

```sh
createdb finance
psql -d finance -f db/schema.sql
psql -d finance -f db/categories.sql
psql -d finance -f db/mock.sql        # 277 generated transactions to look at

echo "DATABASE_URL=postgres://…/finance" > .env
npm ci && npm run dev                 # API on :3000
cd web && npm ci && npm run dev       # app on :5173
```

Local-model suggestions are optional and need [Ollama](https://ollama.com) with `qwen3:4b`. Without it, that one feature reports that it cannot reach the model; everything else works.

```sh
npm test            # 97 tests, all pure — no database required
npm run typecheck
npm run migrate status
```

## Status

Working end to end: import → reconcile → transfer detection → user-editable categories → manual explain → rules engine → bulk confirm → reports, including the unexplained trend over time.

**Known gaps, recorded rather than hidden:** every test is pure, so the routes layer has no automated coverage. `scripts/snapshot.sh` captures every read plus every deliberate validation failure to one file per request, which is enough to prove a refactor changed nothing — but it is a manual tool, it has not been extended to the endpoints added most recently, and integration tests are the next thing CI should gain. Rows come back from `pg` untyped and are cast by hand at ~85 query sites. Connectors for Splitwise and email receipts — the only things that can reach payments to people, which no rule and no model can categorise — are designed in the design and unbuilt.

## Docs

The reasoning lives next to the code, not in commit messages:

- the design — how the pieces fit
- the design — convergence, the user lock, the scoped sweep
- the design — three passes, ordered by evidence strength
- the design — the balance walk, and why mid-history imports anchor to the bank's first stated balance
- the design — the design that changed its own conclusion
- the design — shared expenses, connectors, and why scraped APIs are ruled out
