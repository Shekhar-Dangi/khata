// What counts as EXPLAINABLE SPEND — the one definition, shared by the rules engine
// and by every number the UI reports. A SQL predicate over `transactions`.
//
//  - `opening_balance` is a ledger seed, not money you spent.
//  - `type = 'transfer'` is how the import classified it; `transfer_status = 'resolved'`
//    is how detection confirmed it. Either way it is your own money moving between your
//    own accounts, so it is neither spend nor income.
//
// Kept in ONE string on purpose. Two copies of a definition drift, and then the headline
// metric and the engine quietly disagree about what "unexplained" means — the same class
// of bug as the duplicated rule vocabulary.
//
// It lives in its own file for exactly that reason. It used to be a `const` two thirds of
// the way down a 2,600-line server.ts, which is a hard place to find and an easy place to
// re-declare "just for this query". A module you have to import is a module you notice you
// are importing.
export const EXPLAINABLE_SPEND = `type <> 'opening_balance'
   AND type <> 'transfer'
   AND transfer_status IS DISTINCT FROM 'resolved'`;

// The imported `type` column's legal values. Set at import time; transfer-ness proper
// lives in `transfer_status`, which detection owns.
export const ALLOWED_TYPES = ["opening_balance", "transfer", "regular"];

// Identifiers that let one of your accounts be recognised in another's narration.
// account_number and upi_handle are STRONG; name is weak and never auto-resolves.
export const KEYWORD_KINDS = ["account_number", "upi_handle", "name"];

// The four states a transfer leg can be in, and which ones are still counted as spending:
//   pending    strongly identified as a transfer, partner leg not imported yet
//   resolved   paired with its partner. The ONLY state that leaves EXPLAINABLE_SPEND
//   suspected  an amount+date proposal awaiting a person's confirmation
//   rejected   a person said "not a transfer", which means "yes, this is spend"
export const TRANSFER_STATUSES = ["pending", "resolved", "suspected", "rejected"];
