-- Adds an optional flat-rate monthly plan alongside the existing per-bid pricing. A user's
-- plan lives on billing_customers (same service-role-only table as their Stripe customer/card) —
-- 'per_bid' is the existing default; 'monthly' means bids are unlocked without a per-bid charge
-- for as long as subscription_status is 'active'/'trialing'. Kept user-scoped, matching every
-- other billing table/resolver today; not folded into the company_id migration in progress.
ALTER TABLE billing_customers
  ADD COLUMN plan TEXT NOT NULL DEFAULT 'per_bid' CHECK (plan IN ('per_bid', 'monthly')),
  ADD COLUMN stripe_subscription_id TEXT,
  -- Mirrors Stripe's Subscription.status verbatim (active, trialing, past_due, canceled, ...).
  ADD COLUMN subscription_status TEXT,
  ADD COLUMN subscription_cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN subscription_current_period_end TIMESTAMPTZ;
