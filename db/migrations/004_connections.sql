-- 004 — external service connections, and the OAuth handshake state they need.
--
-- The first connector (Splitwise) needs somewhere to keep an access token, and the
-- authorization-code flow needs somewhere to keep one short-lived value BETWEEN two
-- separate HTTP requests. Those are different lifetimes and different risks, so they are
-- two tables rather than one with nullable halves.

-- ---------------------------------------------------------------------------------------
-- connections — a token we hold for an external service, on the user's behalf.
-- ---------------------------------------------------------------------------------------
--
-- Why a table and not `.env`: a token is not configuration. It is obtained at runtime, it
-- can be revoked by the other side at any moment, and re-connecting has to replace it
-- without a redeploy. Config is what you know before the process starts; this is not that.
CREATE TABLE IF NOT EXISTS connections (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- 'splitwise' today; the same shape serves any later OAuth source. UNIQUE because this
  -- app has one user with one Splitwise account, and that constraint is doing real work:
  -- it makes re-connecting an UPSERT instead of an ever-growing pile of tokens where the
  -- newest is merely *probably* the live one. A stale token that still authenticates is a
  -- worse bug than no token, because nothing fails — you just read someone's old session.
  source_type        TEXT NOT NULL UNIQUE,

  access_token       TEXT NOT NULL,

  -- Nullable, and both are nullable for the SAME honest reason: this provider's token
  -- lifetime is UNVERIFIED. If it issues long-lived
  -- tokens there is no refresh token and no expiry, and NULL says that truthfully. What we
  -- must not do is invent a default expiry — a wrong `expires_at` either refreshes a token
  -- that was fine or trusts one that is dead.
  refresh_token      TEXT,
  expires_at         TIMESTAMPTZ,

  -- Who Splitwise says we are connected as. Not decoration: it is the acceptance test for
  -- the whole handshake (slice 1 renders it), and later it is how a sync knows whose
  -- paid_share/owed_share to read out of a shared expense.
  external_user_id   TEXT,
  external_user_name TEXT,

  -- What the token is actually allowed to do, as returned by the provider — not what we
  -- asked for. Those differ when a provider narrows a grant, and the returned value is the
  -- one that will be true at 2am.
  scope              TEXT,

  connected_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- NOTE ON ENCRYPTION, deliberately deferred: these tokens are stored
-- in plaintext. The database next to them already holds the entire ledger, which is
-- strictly more sensitive than a read token scoped to one service, so encrypting this
-- column alone would buy an appearance of safety rather than safety. Revisit if this ever
-- becomes multi-tenant, where one leaked row stops being the operator's own problem.

-- ---------------------------------------------------------------------------------------
-- oauth_states — the CSRF nonce, alive for the length of one handshake.
-- ---------------------------------------------------------------------------------------
--
-- The flow spans two unconnected requests: we redirect the browser out to the provider,
-- and some seconds later the provider redirects it back. Between those two moments the
-- server must remember "I started this, and I started it for this browser". Nothing else
-- in this app needs that, because nothing else in this app has a session — there is no
-- auth here at all (see the note in src/server.ts), no cookie parser, and no session
-- middleware. So the handshake carries its own memory in a table.
--
-- An in-memory Map would also work until it doesn't: `npm start` runs without --watch and
-- gets restarted constantly during development, and a restart mid-handshake would drop the
-- state and reject a legitimate callback with the same error as an attack. Durable is both
-- more correct and easier to debug.
CREATE TABLE IF NOT EXISTS oauth_states (
  -- The nonce itself is the key. Generate it with node:crypto randomBytes — a value an
  -- attacker can predict is the same as no state at all.
  state       TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,

  -- Short. Minutes, not hours: this only has to survive one human clicking "Allow".
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- CONSUME IT IN ONE STATEMENT. The callback must do:
--
--   DELETE FROM oauth_states
--    WHERE state = $1 AND source_type = $2 AND expires_at > now()
--    RETURNING state;
--
-- and treat rowCount = 0 as rejection — invalid, expired and already-used are the same
-- answer to the caller, and should be the same answer in the logs too.
--
-- The reason this is one statement rather than a SELECT followed by a DELETE is the
-- check-then-act race src/http.ts already warns about: between a SELECT that finds the
-- state and a DELETE that removes it, a second request can pass the same check, which
-- turns a single-use nonce into a replayable one. DELETE ... RETURNING is atomic, so
-- exactly one caller can ever win.

-- Unredeemed states (the user opened the consent screen and wandered off) are never
-- consumed by the DELETE above, so sweep them opportunistically at the start of each new
-- handshake rather than adding a scheduled job for a table that will hold single digits:
--
--   DELETE FROM oauth_states WHERE expires_at < now();
CREATE INDEX IF NOT EXISTS oauth_states_expires_idx ON oauth_states (expires_at);
