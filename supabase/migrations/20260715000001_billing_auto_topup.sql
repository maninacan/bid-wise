-- Saved card + auto top-up configuration, one row per user. Written only by the server
-- (service role, via GraphQL resolvers) — RLS is enabled with no policies, so the
-- anon/authenticated client role has zero access; everything here is read/written
-- through apps/api/src/billing.ts.
CREATE TABLE billing_customers (
  user_id                    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_customer_id         TEXT NOT NULL,
  stripe_payment_method_id   TEXT,
  card_brand                 TEXT,
  card_last4                 TEXT,
  auto_topup_enabled         BOOLEAN NOT NULL DEFAULT false,
  -- Balance (cents) that triggers an automatic top-up when crossed.
  auto_topup_threshold_cents INTEGER,
  -- Balance (cents) an automatic top-up brings the account back up to.
  auto_topup_target_cents    INTEGER,
  -- Set when an automatic charge fails (declined, needs authentication); surfaced in the
  -- billing UI and cleared the next time the card or settings are successfully updated.
  auto_topup_disabled_reason TEXT,
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE billing_customers ENABLE ROW LEVEL SECURITY;

-- Auto top-up charges are off-session PaymentIntents rather than Checkout Sessions, so they
-- need their own idempotency key alongside the existing stripe_session_id one.
ALTER TABLE credit_transactions ADD COLUMN stripe_payment_intent_id TEXT;

CREATE UNIQUE INDEX credit_transactions_payment_intent_idx
  ON credit_transactions (stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;
