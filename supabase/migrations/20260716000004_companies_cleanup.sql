-- Phase 5 (cleanup): now that every app code path (client + API, dev and prod) is fully
-- company_id-scoped, retire the transitional user_id-based scaffolding from the companies
-- migration: drop the old per-user RLS policies (superseded by the company-scoped ones added
-- alongside them in Phase 1), drop the bridging triggers (no insert path relies on the
-- default-to-first-company fallback anymore), enforce company_id NOT NULL, and drop the
-- tables/views the companies migration replaced outright (user_settings, user_credit_balance).
--
-- Verified immediately before writing this migration: zero rows with a null company_id in
-- any of the six tables below (both dev and prod), and no remaining <user_id>/... storage
-- paths in the house-plans bucket (prod's 3 house_plans rows are already <company_id>/...) -
-- so the storage-path rename script from the original plan turned out to be unnecessary.

-- ── Drop the old user_id-based RLS policies ──────────────────────────────────────
-- "subs_can_read_delegated_takeoffs" (takeoffs) and "Linked users can view their own sub
-- records" (subcontractors) are left untouched - they're keyed off linked_user_id/jsonb
-- delegations, orthogonal to the company_id cutover.
drop policy if exists "Users can view own ai_usage" on public.ai_usage;
drop policy if exists "Users can view own credit_transactions" on public.credit_transactions;
drop policy if exists "Users can view own plans" on public.house_plans;
drop policy if exists "Users can insert own plans" on public.house_plans;
drop policy if exists "Users can update own plans" on public.house_plans;
drop policy if exists "Users can delete own plans" on public.house_plans;
drop policy if exists "Users manage own subcontractors" on public.subcontractors;
drop policy if exists "Users can view own takeoff_jobs" on public.takeoff_jobs;
drop policy if exists "Users can view own takeoffs" on public.takeoffs;
drop policy if exists "Users can update own takeoffs" on public.takeoffs;
drop policy if exists "Users can delete own takeoffs" on public.takeoffs;

-- Old per-user storage policies on the house-plans bucket.
drop policy if exists "Users can read own plan files" on storage.objects;
drop policy if exists "Users can upload own plan files" on storage.objects;
drop policy if exists "Users can delete own plan files" on storage.objects;

-- ── Drop the bridging triggers (every insert now sets company_id explicitly) ─────
drop trigger if exists house_plans_default_company on public.house_plans;
drop trigger if exists takeoffs_default_company on public.takeoffs;
drop trigger if exists subcontractors_default_company on public.subcontractors;
drop trigger if exists takeoff_jobs_default_company on public.takeoff_jobs;
drop trigger if exists ai_usage_default_company on public.ai_usage;
drop trigger if exists credit_transactions_default_company on public.credit_transactions;
drop function if exists public.default_company_id_from_user();

-- ── Contract: company_id NOT NULL everywhere ─────────────────────────────────────
alter table public.house_plans alter column company_id set not null;
alter table public.takeoffs alter column company_id set not null;
alter table public.subcontractors alter column company_id set not null;
alter table public.takeoff_jobs alter column company_id set not null;
alter table public.ai_usage alter column company_id set not null;
alter table public.credit_transactions alter column company_id set not null;

-- ── Drop what the companies migration superseded outright ────────────────────────
drop view if exists public.user_credit_balance;
drop table if exists public.user_settings;
