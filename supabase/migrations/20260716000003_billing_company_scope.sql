-- Phase 4: re-scopes the billing/credit-wallet tables from per-user to per-company, so a
-- company's members share one Stripe customer, one saved card, one credit balance, and one
-- subscription (decision 2: shared company wallet). Both tables already carry a nullable
-- company_id (added additively in the Phase 1 companies migration and backfilled for every
-- pre-existing row) - this migration finishes the cutover now that the API/client code that
-- reads/writes them is being switched over in the same deploy.

-- ── billing_customers: company_id becomes the primary key ───────────────────────
-- user_id is kept (renamed) purely as an audit trail of who first set up billing for the
-- company - it's no longer how the row is looked up.
alter table public.billing_customers rename column user_id to created_by_user_id;
alter table public.billing_customers alter column company_id set not null;
alter table public.billing_customers drop constraint billing_customers_pkey;
alter table public.billing_customers add primary key (company_id);

-- ── credit_transactions: user_id becomes actor_user_id (who triggered it) ────────
-- company_id (whose wallet) already exists from Phase 1; kept nullable for now per the
-- Phase 5 cleanup plan (NOT NULL everywhere lands once the old code path is fully retired).
alter table public.credit_transactions rename column user_id to actor_user_id;

-- Shared-wallet balance view, company-scoped equivalent of user_credit_balance.
-- security_invoker = on re-checks the caller's RLS on credit_transactions (same pattern as
-- the view it replaces), so a member only ever sees their own company's balance.
create view public.company_credit_balance with (security_invoker = on) as
  select company_id, coalesce(sum(amount_cents), 0)::integer as balance_cents
  from public.credit_transactions
  where company_id is not null
  group by company_id;

-- ── create_company_with_owner: seed companies.billing_email from the owner's auth email ──
-- Stripe customer creation (ensureStripeCustomerId) now prefers companies.billing_email over
-- an individual member's email, since the customer belongs to the company, not one person.
drop function if exists public.create_company_with_owner(text, uuid);

create function public.create_company_with_owner(p_name text, p_owner uuid, p_owner_email text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_company_id uuid;
begin
  insert into public.companies (name, created_by, billing_email) values (p_name, p_owner, p_owner_email) returning id into v_company_id;
  insert into public.company_members (company_id, user_id, role) values (v_company_id, p_owner, 'owner');
  insert into public.company_settings (company_id) values (v_company_id);
  return v_company_id;
end; $$;
revoke execute on function public.create_company_with_owner(text, uuid, text) from public, anon, authenticated;
