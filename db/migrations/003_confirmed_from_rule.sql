-- 003 — remember which rule a confirmed allocation came from.
--
-- Why: confirming a rule's guess flips source 'rule' -> 'user', and the provenance CHECK
-- requires rule_id IS NULL on a user row. That is right — a user allocation naming a rule
-- would be a lie about who decided it — but it meant the link was DESTROYED, not moved.
--
-- The consequence only became visible at scale. Confirming 253 rows in one action took
-- every rule in the ledger to zero in /reports/by-rule: 20 rules all reporting "matched
-- nothing", when what actually happened was that their work had been claimed. A report
-- whose whole job is "what is this rule doing to my money" answering "nothing" for every
-- rule is worse than no report, because zero is a number people act on.
--
-- So: a SEPARATE column for a separate fact. `rule_id` means "a rule owns this row and the
-- engine manages it". `confirmed_from_rule_id` means "a rule proposed this and a human
-- accepted it" — history, not ownership. Keeping them apart is what lets the engine's
-- scoped sweep stay exactly as narrow as it was: every DELETE it issues still carries
-- `AND source = 'rule'`, and a confirmed row is invisible to it.
ALTER TABLE allocations
  ADD COLUMN IF NOT EXISTS confirmed_from_rule_id BIGINT REFERENCES rules(id);

-- Make the illegal state unrepresentable, in the same spirit as the provenance CHECK
-- above it: only a USER row can have been confirmed from a rule. A 'rule' row still owns
-- its rule through rule_id, and an 'evidence' row was never proposed by one.
ALTER TABLE allocations DROP CONSTRAINT IF EXISTS allocations_confirmed_from_rule_check;
ALTER TABLE allocations ADD CONSTRAINT allocations_confirmed_from_rule_check
  CHECK (confirmed_from_rule_id IS NULL OR source = 'user');

-- /reports/by-rule now joins on this as well as rule_id, and that join needs an index for
-- the same reason rule_id has one.
CREATE INDEX IF NOT EXISTS allocations_confirmed_from_rule_idx
  ON allocations (confirmed_from_rule_id) WHERE confirmed_from_rule_id IS NOT NULL;

-- Backfill the rows confirmed BEFORE this column existed.
--
-- POST /transactions/confirm has been stamping `note` with 'confirmed from rule: <name>'
-- since it shipped, precisely so the origin would survive losing rule_id. rules.name is
-- UNIQUE, so the name identifies exactly one rule and this is not a guess.
--
-- Anchored with `|| '%'` rather than a bare LIKE '%...%': the note is an append-only trail
-- ('a | b | c'), so an unanchored match on one rule's name could also hit a note that
-- merely mentions it later. Matching the phrase plus the name to end-of-segment keeps it
-- to the rule that actually produced the row.
UPDATE allocations al
   SET confirmed_from_rule_id = r.id
  FROM rules r
 WHERE al.source = 'user'
   AND al.confirmed_from_rule_id IS NULL
   AND al.note LIKE '%confirmed from rule: ' || r.name;
