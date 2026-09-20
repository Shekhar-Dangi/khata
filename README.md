# Khata

[![CI](https://github.com/Shekhar-Dangi/khata/actions/workflows/ci.yml/badge.svg)](https://github.com/Shekhar-Dangi/khata/actions/workflows/ci.yml)

Khata is a local-first tool for making sense of your own bank statements. You import them, and
it keeps score of one number: how much of your money you have not explained yet.

Everything runs on your machine, against your database. Nothing is uploaded anywhere.

## Why a statement alone is not enough

A statement is a reliable record of cash moving. It is a poor record of what that cash was for.

Take a single row:

```
06-Aug-2026   UPI-Debit-123456789012-BLINKIT-HDFC        -1,240.00
```

From the narration you can tell the money went to Blinkit. That is genuinely useful, and for a
lot of rows it is enough to file them. It is also where the narration stops. That order could be
a week of groceries, or groceries plus a phone charger plus a delivery fee, or mostly a cleaning
kit you would file under Household. Putting the whole amount under Groceries is a guess, and it
will quietly stay wrong for as long as you keep the ledger.

Other rows are harder than that:

* Payments to people, where the narration is a name and a UPI handle and nothing else.
* Wallet loads. Money moves to Amazon Pay today and gets spent over the next month, so the
  statement date and the purchase date are different things.
* Payment rails standing in for merchants. A row that says `PAYTM` tells you how the money
  travelled, not who received it.
* Transfers between your own accounts, which look exactly like spending on both sides unless
  something pairs them up.

So narration-based categorising gives you a decent first pass and a hard ceiling. It can tell you
roughly where money goes. It cannot tell you what you actually bought, and it cannot tell you when
it has guessed.

Khata starts from that first pass, keeps it honest by marking it as a guess, and then adds a
second layer of evidence for the rows that deserve one.

## Receipts are where the detail lives

An invoice for that same Blinkit order lists every item, its quantity and its price, with the
delivery and handling charges separated out. That is the information the bank row is missing.

Once an order is on the ledger as evidence:

* Its line items become category allocations, so one order can be part Groceries and part
  Household instead of all one thing.
* Fees stay fees rather than being smeared across the products.
* Anything the app cannot classify stays visible as a remainder rather than being absorbed
  into a category that happens to be nearby.
* You get an actual answer to "what do I buy", not just "where do I spend".

## Getting receipts in bulk is a separate problem

This is the part worth being upfront about, because it shapes what this project does and does not
try to do.

* Some providers give you a bulk export. Amazon, for example, lets you request your order history
  and the invoices behind it, so a few hundred documents arrive together.
* Some do not. Blinkit shows invoices one order at a time in the app, so collecting them is manual.
* Some send the receipt only by email, which means the collecting problem becomes a mailbox
  problem.

Khata does not solve acquisition. There is no scraping, no unofficial API, no account of yours
being logged into. That is a different problem with its own failure modes, and doing it badly is
worse than not doing it.

What Khata assumes instead is that you can get the files somehow, however tedious that is, and its
job starts there. You drop a folder of PDFs onto the Sources screen and it takes it from there.

## How a document becomes a line on your ledger

1. **The bytes are stored first.** Before anything tries to read a file, it is saved. A parser bug
   then costs a re-run, not the document.
2. **A deterministic parser reads it if one exists.** Amazon invoices have one today. It knows the
   template, pulls out the order id, the line items and the totals, and refuses anything that does
   not add up to the paise.
3. **Otherwise a local model can read it.** For templates with no parser yet, the PDF is converted
   to text and a model running on your machine extracts the same shape. Four checks decide whether
   to believe the answer: is this actually an invoice, are all the fields there, does the
   arithmetic reconcile exactly, and does every line it claims to have read really appear in the
   document. The model is never asked how confident it is, because that answer turned out to carry
   no information when it was measured.
4. **Nothing lands until you confirm it.** Parsed orders wait in a review screen where you can see
   what was read and what it will do. Confirming is a human action, always.
5. **The order is matched to the bank row that paid for it**, by amount and date inside a window,
   with the merchant as a hard filter. When it is ambiguous, it asks instead of picking.

## Products, and why they need normalising

The same product does not arrive with the same name twice. A single item can print as:

```
Example Dairy Pouch Curd, 400 G | B0XXXXXXX1 ( B0XXXXXXX1 )
Example Dairy Pouch Curd, 400 G | B0XXXXXXX1 (
Example Dairy Curd 400g Pouch
```

If the catalogue is keyed on the printed string, one product becomes three, and classifying it
once does nothing for the next basket. So the app keeps a catalogue of products with an alias
table pointing at it, and resolves each raw line to a product before filing anything.

Today the resolver works like this:

* It strips the noise merchants add, the ids and the truncation.
* It strips quantity and pack size, so 150 g and 50 g of the same coffee are one product bought in
  two sizes. Each size keeps its own alias, so nothing is lost.
* It compares what remains using trigram similarity in Postgres.
* It refuses to merge two lines automatically when the merchant gave them different SKUs, however
  similar the text looks. Two ids means the merchant is saying two things.
* When it is unsure, it creates a new product and puts the pair in a merge queue for you. A
  duplicate is visible and easy to fix. A wrong merge is silent and permanent, so the bias is
  deliberate.

This is the weakest part of the app and it is meant to improve. The plan is a better deterministic
algorithm first, with the local model used only where the algorithm cannot decide, and never as
the thing that makes the final call on its own.

Once a product has a category, that category applies backwards. Filing "rolled oats" once files
every basket that already contains it and every basket that will.

## Shared expenses

If you split costs with people, your statement is misleading in both directions. You paid ₹3,000
for a dinner and got ₹2,000 back later, so the statement says you spent ₹3,000 and received
₹2,000, when what you actually consumed was ₹1,000.

Khata imports a Splitwise export and models this properly:

* Your share of a shared expense is what counts as yours.
* The part you fronted for other people is money that moved, not money you consumed.
* When someone else pays for something you consumed, it never touches your bank at all, so it is
  recorded separately.

The reports screen has a toggle for this. **Spent** is what left your accounts. **Consumed** is
what you actually used, whoever paid, and it shows you the arithmetic that connects the two rather
than asking you to trust it.

## Rules, and being honest about guesses

Narration-based categorising is a rules engine here, and every row it touches is marked as a
guess. There are three states:

* **Unexplained.** Money left and nothing accounts for it. This is the headline number.
* **Provisional.** A rule guessed. Re-runnable, reversible, and clearly not your word.
* **Confirmed.** You said so. Nothing automatic may overwrite it.

The engine converges rather than accumulating: running it twice changes nothing the second time.
It also skips any transaction you have explained yourself, because being able to leave something
deliberately unexplained is the whole point of the number.

Rules do not have to be written by hand. The app clusters the unexplained narrations and proposes
rules, scored by how many different categories the rows they would claim already carry. A rule
that would cover a fifth of your ledger with one meaning is a good rule. One that would cover
three different meanings is a payment rail pretending to be a merchant, and it is shown as such.
Every proposed rule has to be previewed before it can be created.

## Transfers between your own accounts

Money you move between your own accounts appears as a debit in one and a credit in another. Left
alone, it inflates spending on one side and income on the other.

Detection runs in three passes, strongest evidence first: the 12-digit UPI reference both legs
quote, then account identifiers you have taught it, then amount and date. Only the first resolves
on its own. The others propose, and you decide.

## The local model, and why it does so little

The model is local (Ollama, on loopback) because bank narrations should not leave your machine.
That constraint came first, and then the measurement made the feature smaller.

Asked to categorise unexplained transactions from narration alone, a 4B model answered "Unknown"
on 155 of 177 rows. That is not a broken model. It is the model correctly reporting that a bank
narration usually does not contain what you need. A bigger model named one more row out of 52, for
56% more latency.

Meanwhile the unexplained rows clustered into about fifteen groups rather than spreading evenly,
and a concentrated tail is a rules problem. Rules are deterministic, inspectable, re-runnable and
permanent. A model call is none of those.

So the model does two narrow jobs: reading invoices no parser can read, and suggesting a category
for the handful of one-off merchants no rule can ever cover. Both write suggestions, never
ledger rows.

## What works today

* Importing statements: HDFC and Indian Bank spreadsheets, Slice PDFs.
* Reconciling imported rows against the balances the bank itself states.
* Transfer detection across accounts.
* Categories you control, manual explanations, and the rules engine with mined rule candidates.
* Reports: by category, by rule, month over month, and the unexplained trend over time.
* Splitwise import, with the consumption view described above.
* Invoice ingestion end to end: store, parse, review, confirm, and match to the bank row.
* A product catalogue with a merge queue, and categories that apply backwards.

## What is not built yet

* **Refunds.** Credit notes are recognised and stored, but not posted to the ledger. A refund is
  its own event, not a reversal of the purchase, and modelling it properly is pending.
* **A general statement importer.** Adding a new bank means writing a parser today. Uploading a
  spreadsheet and mapping its columns yourself is planned.
* **Better product matching**, as described above.
* **Email receipt ingestion.** It would remove most of the collecting problem. It is designed and
  not built.
* **Integration tests.** Every unit test here is pure and none of them touch the routes layer.
  `scripts/snapshot.sh` captures every read endpoint's exact response so a refactor can be proved
  not to have changed behaviour, but it is a manual tool and not a substitute.
* **Authentication.** There is none, deliberately. The intended deployment is your own machine,
  where your OS account is the boundary. Real multi-user auth decides whether accounts, rules and
  categories become per-user, which reaches the schema and every query, so it is unbuilt rather
  than half-built.

## Stack

TypeScript, Node (Express 5), Postgres 18, React 19 with Vite, and Python for reading statements
and invoices.

```
src/                    the API. Pure logic is split from anything touching the database,
                        because that is the code that can silently reclassify real money
  routes/               one file per resource
  rules/                the matcher, the engine run, the miner
  transfers/            detection and the balance walk
  evidence/             matching external records to bank rows
  splitwise/            the export parser and the shared-expense model
  receipts/             the artifact store, extraction, review staging
  receipts/model/       the local model path and its job queue
  llm/                  model configuration and category suggestions
  items/                the product catalogue
db/
  schema.sql            the destination, for a fresh database
  migrations/           the only legal route there from a database that holds data
web/src/                React, grouped by feature
ingest/                 Python: statement parsers, and the invoice reader
```

## Running it

Needs Node 24 or newer (the server runs TypeScript directly, with no build step) and Postgres 18.

```sh
createdb finance
psql -d finance -f db/schema.sql
psql -d finance -f db/categories.sql
psql -d finance -f db/mock.sql        # 277 generated transactions, so the app is not empty

echo "DATABASE_URL=postgres://…/finance" > .env
npm ci && npm run dev                 # API on :3000
cd web && npm ci && npm run dev       # app on :5173
```

Reading invoices with a model is optional and needs [Ollama](https://ollama.com). Without it that
one feature says it cannot reach a model, and everything else works. See `.env.example` for the
settings, which model to use, how big a context window, how long to wait.

```sh
npm test               # unit tests, all pure, no database needed
npm run typecheck
npm run migrate status # what is applied and what is pending
```

## The hosted demo

There is a demo carrying generated data, so you can click around before deciding whether to run it
properly. Its limits are deliberate:

* No sign-in and no user model. One shared database, so anything you change everyone sees, and it
  may be reset without warning. Do not put real financial details into it.
* No local model, since that runs on your machine by design. That one endpoint answers 501 and
  says why.
* Everything else is the real app: import, transfers, rules, mining, bulk confirm, reports.

The app says all of this in a banner rather than letting you find out.

### Deploying your own

One process serves the API and the built frontend, so a deployment is one service and one
database:

```sh
DEMO_MODE=1     # banner on, local-model endpoint answers 501
SERVE_WEB=1     # this process also serves web/dist
DATABASE_URL=…  # provided by the host

npm ci && npm ci --prefix web && npm run build --prefix web
npm run seed:demo      # refuses to run against a database that already holds data
npm run start:demo
BASE=$URL npm run demo:activity   # applies rules, then confirms a slice
```

`demo:activity` exists so the demo shows all three states instead of two. A freshly seeded
database has unexplained rows and rule guesses but nothing confirmed, because confirming is a
human act, and a demo of a three-state model that only ever shows two states explains the wrong
thing.

`fly.toml` with the `Dockerfile` wires this up, and `render.yaml` is the alternative. Neither is
vendor-specific: both map onto any host that runs a Node process and hands it a `DATABASE_URL`.

## Where the reasoning lives

In the code, next to the thing it explains. Every non-obvious decision has a comment at the place
it applies, and each file in `db/migrations/` opens with why that schema change was made.
