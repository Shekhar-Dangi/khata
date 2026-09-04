-- 009 — income is not consumption.
--
-- Found by running src/consumption.ts against real data: the total came out NEGATIVE, which
-- is impossible for "what did I use up". Salary credits are allocated to Income categories,
-- those allocations are positive, and the union was summing them alongside spending.
--
-- EXPLAINABLE_SPEND did not catch it and should not be expected to: it excludes an opening
-- balance and a transfer, both of which are whole transactions of your own money moving.
-- Income is neither. It is a real inflow — just not something you consumed.
--
-- The flag from 005 is exactly the right mechanism, and this is the second thing it has
-- turned out to describe. `excluded_from_spend` reads as "allocations here are money that
-- moved but was not consumption", which is as true of a salary as it is of the part of a
-- restaurant bill you fronted for a flatmate.
UPDATE categories SET excluded_from_spend = true
 WHERE name = 'Income' AND parent_id IS NULL;

-- NOTE: children are covered by the query rule, not by this statement. src/consumption.ts
-- excludes a category when IT or ITS PARENT carries the flag, so flagging one parent covers
-- every child — including children added later, which a one-off UPDATE over today's rows
-- would silently miss. Allocations point at leaves like `Income > Salary`, so without the
-- parent rule this migration would have done nothing at all.

-- KNOWN LIMIT, recorded rather than solved: a refund allocated to `Income > Refunds` is now
-- excluded too, so it no longer reduces consumption. Arguably a refund belongs in the
-- category it reverses rather than under Income, which is a modelling question about refunds
-- and not about consumption. Left alone deliberately.
