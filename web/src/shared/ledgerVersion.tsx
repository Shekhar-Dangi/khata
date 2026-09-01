import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

// A version number that anything derived from the ledger can watch.
//
// The problem it solves: applying rules happens in RulesToolbar, and the headline
// numbers live in Summary. Those are in DIFFERENT SUBTREES, so "callback up, data down"
// cannot reach — a component can tell its own parent, and Summary is not its parent.
// The result was a summary strip that silently went stale the moment a rule ran.
//
// So: one counter at the root. Any component that MUTATES the ledger bumps it; any
// component that DISPLAYS something derived from the ledger passes it to useFetch and
// re-reads when it changes. Deliberately coarse — a rule run changes categories,
// balances, unexplained totals and rule impact all at once, so per-key invalidation
// would be more machinery for the same outcome.
//
// This is the small, dependency-free version of what React Query or SWR do with a cache
// key. Worth swapping for the real thing if this ever needs partial invalidation or
// request de-duplication; not before.
type LedgerVersion = { version: number; bump: () => void };

const Ctx = createContext<LedgerVersion>({ version: 0, bump: () => {} });

export function LedgerVersionProvider({ children }: { children: ReactNode }) {
  const [version, setVersion] = useState(0);
  // useCallback so `bump` keeps a stable identity — it ends up in effect dependency
  // arrays downstream, and a new function every render would re-run them forever.
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  // Same reasoning for the value object: a fresh object each render re-renders every
  // consumer of this context, whether or not the number actually moved.
  const value = useMemo(() => ({ version, bump }), [version, bump]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLedgerVersion(): LedgerVersion {
  return useContext(Ctx);
}
