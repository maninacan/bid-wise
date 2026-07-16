-- Adds 'applied_to_subscription' as a valid credit_transactions kind: the ledger entry written
-- when a company manually sweeps its leftover per-bid credit balance into Stripe's native
-- Customer Balance (applyBalanceToSubscription, apps/api/src/billing.ts) so Stripe can apply it
-- to future monthly subscription invoices. Always a negative amount_cents (zeroes the balance
-- being swept) — no positive counterpart, unlike 'topup'.
ALTER TABLE credit_transactions DROP CONSTRAINT credit_transactions_kind_check;
ALTER TABLE credit_transactions ADD CONSTRAINT credit_transactions_kind_check
  CHECK (kind IN ('topup', 'charge', 'applied_to_subscription'));
