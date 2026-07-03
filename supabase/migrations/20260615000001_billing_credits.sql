-- Prepaid credit wallet + per-bid charges. The server (service role) owns all writes:
-- Stripe top-ups add a positive `topup` row; finalizing a bid adds a negative `charge`
-- row. Balance = SUM(amount_cents) per user. Clients only read their own rows via RLS.
CREATE TABLE credit_transactions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('topup', 'charge')),
  -- Positive for a top-up, negative for a per-bid charge.
  amount_cents      INTEGER NOT NULL,
  -- Set on charges (the bid that was paid for); null on top-ups.
  takeoff_id        UUID REFERENCES takeoffs(id) ON DELETE SET NULL,
  tier              TEXT,
  -- Set on top-ups (the Stripe Checkout session); null on charges.
  stripe_session_id TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX credit_transactions_user_idx ON credit_transactions (user_id);

-- Idempotency: credit a Stripe session at most once (webhook + confirm-on-return can both
-- fire), and charge a takeoff at most once (re-finalize after un-finalize must not re-charge).
CREATE UNIQUE INDEX credit_transactions_session_idx
  ON credit_transactions (stripe_session_id) WHERE stripe_session_id IS NOT NULL;
CREATE UNIQUE INDEX credit_transactions_charge_idx
  ON credit_transactions (takeoff_id) WHERE kind = 'charge';

ALTER TABLE credit_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own credit_transactions" ON credit_transactions
  FOR SELECT USING (auth.uid() = user_id);

-- Per-user balance rollup (cents). security_invoker makes the view honor the base-table
-- RLS, so a client reading the view only ever sees its own balance.
CREATE VIEW user_credit_balance
  WITH (security_invoker = on) AS
SELECT
  user_id,
  COALESCE(SUM(amount_cents), 0)::INTEGER AS balance_cents
FROM credit_transactions
GROUP BY user_id;
