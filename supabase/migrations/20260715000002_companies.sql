-- Phase 1 of the "companies" (multi-tenancy) migration: purely additive.
-- Adds the company/membership/invite/settings schema, company-scoped RLS policies
-- ALONGSIDE the existing user_id-based ones (nothing is dropped), and backfills one
-- company per existing user. No app code changes are required for this migration to
-- apply cleanly — every existing user ends up sole owner of exactly one company, so
-- is_company_member()/is_company_owner() trivially reduce to the old auth.uid() = user_id
-- check for every pre-existing row.

-- ── Core tables ────────────────────────────────────────────────────────────────

create table public.companies (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  billing_email text,
  created_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id) on delete set null
);

create table public.company_members (
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null check (role in ('owner','member')),
  joined_at  timestamptz not null default now(),
  primary key (company_id, user_id)
);
create index company_members_user_id_idx on public.company_members(user_id);

-- Guard: never allow a company to end up with zero owners.
create or replace function public.prevent_last_owner_removal()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (TG_OP = 'DELETE' and OLD.role = 'owner')
     or (TG_OP = 'UPDATE' and OLD.role = 'owner' and NEW.role <> 'owner') then
    if (select count(*) from public.company_members
        where company_id = OLD.company_id and role = 'owner') <= 1 then
      raise exception 'Cannot remove the last owner of a company.';
    end if;
  end if;
  return coalesce(NEW, OLD);
end; $$;
create trigger company_members_protect_last_owner
  before update or delete on public.company_members
  for each row execute function public.prevent_last_owner_removal();

create table public.company_invites (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  email        text not null,
  role         text not null default 'member' check (role in ('owner','member')),
  token        uuid not null default gen_random_uuid(),
  status       text not null default 'pending' check (status in ('pending','accepted','revoked','expired')),
  invited_by   uuid not null references auth.users(id) on delete cascade,
  accepted_by  uuid references auth.users(id) on delete set null,
  accepted_at  timestamptz,
  expires_at   timestamptz not null default (now() + interval '7 days'),
  created_at   timestamptz not null default now()
);
create unique index company_invites_token_idx on public.company_invites(token);
create unique index company_invites_pending_email_idx
  on public.company_invites(company_id, lower(email)) where status = 'pending';
create index company_invites_email_idx on public.company_invites(lower(email));

-- Company-wide business settings (decision 6: pricing_matrix/trades/bid_sharing_mode
-- are shared, member-editable business policy, not owner-only).
create table public.company_settings (
  company_id       uuid primary key references public.companies(id) on delete cascade,
  pricing_matrix   jsonb not null default '{"unitDefaults":{},"tradeOverrides":[]}',
  trades           text[] not null default '{}',
  bid_sharing_mode text not null default 'full',
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users(id) on delete set null
);

-- Personal per-user UI preference, split out of user_settings (decision 6).
create table public.user_preferences (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  dismissed_notices text[] not null default '{}',
  updated_at        timestamptz not null default now()
);

-- ── RLS helper functions ─────────────────────────────────────────────────────────
-- SECURITY DEFINER so they don't recurse into company_members' own RLS (same
-- precedent as link_user_to_subcontractors / link_subcontractor_to_existing_user).

create or replace function public.is_company_member(target_company_id uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select exists (select 1 from public.company_members
    where company_id = target_company_id and user_id = auth.uid());
$$;

create or replace function public.is_company_owner(target_company_id uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select exists (select 1 from public.company_members
    where company_id = target_company_id and user_id = auth.uid() and role = 'owner');
$$;
grant execute on function public.is_company_member(uuid) to authenticated;
grant execute on function public.is_company_owner(uuid) to authenticated;

-- Atomic company + owner-membership creation, called by the server (createCompany resolver).
create or replace function public.create_company_with_owner(p_name text, p_owner uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_company_id uuid;
begin
  insert into public.companies (name, created_by) values (p_name, p_owner) returning id into v_company_id;
  insert into public.company_members (company_id, user_id, role) values (v_company_id, p_owner, 'owner');
  return v_company_id;
end; $$;
-- No grant to anon/authenticated: this takes an explicit p_owner, so it must only be
-- callable via the service-role client (apps/api's createCompany resolver), never
-- directly via PostgREST RPC by an arbitrary signed-in user.
revoke execute on function public.create_company_with_owner(text, uuid) from public, anon, authenticated;

-- ── RLS: companies / company_members / company_invites / company_settings / user_preferences ──

alter table public.companies enable row level security;
create policy "Company members can view their companies" on public.companies
  for select to authenticated using (is_company_member(id));

alter table public.company_members enable row level security;
create policy "Company members can view the roster" on public.company_members
  for select to authenticated using (is_company_member(company_id));
-- No client insert/update/delete policies — all membership writes go through resolvers
-- (service role), which enforce owner-only invite/remove and the last-owner guard.

alter table public.company_invites enable row level security;
-- Zero policies (deny-all for anon/authenticated), same idiom as billing_customers:
-- the token is sensitive and every access path is already a resolver.

alter table public.company_settings enable row level security;
create policy "Company members can view settings" on public.company_settings
  for select to authenticated using (is_company_member(company_id));
create policy "Company members can update settings" on public.company_settings
  for update to authenticated using (is_company_member(company_id)) with check (is_company_member(company_id));

alter table public.user_preferences enable row level security;
create policy "Users can view own preferences" on public.user_preferences
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users can insert own preferences" on public.user_preferences
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users can update own preferences" on public.user_preferences
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- ── Expand: add nullable company_id to every existing user-scoped table ─────────

alter table public.house_plans add column company_id uuid references public.companies(id) on delete cascade;
alter table public.takeoffs add column company_id uuid references public.companies(id) on delete cascade;
alter table public.subcontractors add column company_id uuid references public.companies(id) on delete cascade;
alter table public.takeoff_jobs add column company_id uuid references public.companies(id) on delete cascade;
alter table public.ai_usage add column company_id uuid references public.companies(id) on delete cascade;
alter table public.credit_transactions add column company_id uuid references public.companies(id) on delete cascade;
alter table public.billing_customers add column company_id uuid references public.companies(id) on delete cascade;

-- ── New company-scoped RLS policies, added ALONGSIDE the existing user_id-based ones ──

create policy "Company members can view plans" on public.house_plans
  for select to authenticated using (is_company_member(company_id));
create policy "Company members can insert plans" on public.house_plans
  for insert to authenticated with check (is_company_member(company_id) and user_id = (select auth.uid()));
create policy "Company members can update plans" on public.house_plans
  for update to authenticated using (is_company_member(company_id)) with check (is_company_member(company_id));
create policy "Company owners can delete plans" on public.house_plans
  for delete to authenticated using (is_company_owner(company_id));

create policy "Company members can view takeoffs" on public.takeoffs
  for select to authenticated using (is_company_member(company_id));
create policy "Company members can update takeoffs" on public.takeoffs
  for update to authenticated using (is_company_member(company_id)) with check (is_company_member(company_id));
create policy "Company owners can delete takeoffs" on public.takeoffs
  for delete to authenticated using (is_company_owner(company_id));

create policy "Company members can view subcontractors" on public.subcontractors
  for select to authenticated using (is_company_member(company_id));
create policy "Company members can insert subcontractors" on public.subcontractors
  for insert to authenticated with check (is_company_member(company_id) and user_id = (select auth.uid()));
create policy "Company members can update subcontractors" on public.subcontractors
  for update to authenticated using (is_company_member(company_id)) with check (is_company_member(company_id));
create policy "Company owners can delete subcontractors" on public.subcontractors
  for delete to authenticated using (is_company_owner(company_id));

create policy "Company members can view takeoff_jobs" on public.takeoff_jobs
  for select to authenticated using (is_company_member(company_id));

create policy "Company members can view ai_usage" on public.ai_usage
  for select to authenticated using (is_company_member(company_id));

create policy "Company members can view credit_transactions" on public.credit_transactions
  for select to authenticated using (is_company_member(company_id));

-- billing_customers keeps zero policies (deny-all) — unchanged in Phase 1.

-- ── Indexes on the new company_id / audit foreign keys (cheap, pure perf win) ────

create index house_plans_company_id_idx on public.house_plans(company_id);
create index takeoffs_company_id_idx on public.takeoffs(company_id);
create index subcontractors_company_id_idx on public.subcontractors(company_id);
create index takeoff_jobs_company_id_idx on public.takeoff_jobs(company_id);
create index ai_usage_company_id_idx on public.ai_usage(company_id);
create index credit_transactions_company_id_idx on public.credit_transactions(company_id);
create index billing_customers_company_id_idx on public.billing_customers(company_id);
create index companies_created_by_idx on public.companies(created_by);
create index company_invites_invited_by_idx on public.company_invites(invited_by);
create index company_invites_accepted_by_idx on public.company_invites(accepted_by);
create index company_settings_updated_by_idx on public.company_settings(updated_by);

-- ── Bridging trigger: lets unmigrated app code (no company_id yet) keep working ──
-- Defaults a new row's company_id to the inserting user's (first-joined) company.

create or replace function public.default_company_id_from_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if NEW.company_id is null then
    select company_id into NEW.company_id from public.company_members
    where user_id = NEW.user_id order by joined_at asc limit 1;
  end if;
  return NEW;
end; $$;

create trigger house_plans_default_company before insert on public.house_plans
  for each row execute function public.default_company_id_from_user();
create trigger takeoffs_default_company before insert on public.takeoffs
  for each row execute function public.default_company_id_from_user();
create trigger subcontractors_default_company before insert on public.subcontractors
  for each row execute function public.default_company_id_from_user();
create trigger takeoff_jobs_default_company before insert on public.takeoff_jobs
  for each row execute function public.default_company_id_from_user();
create trigger ai_usage_default_company before insert on public.ai_usage
  for each row execute function public.default_company_id_from_user();
create trigger credit_transactions_default_company before insert on public.credit_transactions
  for each row execute function public.default_company_id_from_user();

-- ── New company-scoped storage policies for the house-plans bucket ──────────────
-- Added alongside the existing <user_id>/... path policies. A separate one-time script
-- physically moves each house_plans file from <user_id>/... to <company_id>/... right
-- after the backfill below runs (not part of this SQL migration).

create policy "Company members can read plan files" on storage.objects for select to authenticated
  using (bucket_id = 'house-plans' and is_company_member(((storage.foldername(name))[1])::uuid));
create policy "Company members can upload plan files" on storage.objects for insert to authenticated
  with check (bucket_id = 'house-plans' and is_company_member(((storage.foldername(name))[1])::uuid));
create policy "Company owners can delete plan files" on storage.objects for delete to authenticated
  using (bucket_id = 'house-plans' and is_company_owner(((storage.foldername(name))[1])::uuid));

-- ── Backfill: one company per existing user, re-point all their existing rows ────

insert into public.companies (name, created_by)
select coalesce(u.raw_user_meta_data->>'full_name', split_part(u.email, '@', 1)) || '''s Company', u.id
from auth.users u
where not exists (select 1 from public.company_members m where m.user_id = u.id);

insert into public.company_members (company_id, user_id, role)
select c.id, c.created_by, 'owner'
from public.companies c
where c.created_by is not null
  and not exists (select 1 from public.company_members m where m.company_id = c.id);

update public.house_plans hp set company_id = m.company_id
from public.company_members m where m.user_id = hp.user_id and hp.company_id is null;

update public.takeoffs t set company_id = m.company_id
from public.company_members m where m.user_id = t.user_id and t.company_id is null;

update public.subcontractors s set company_id = m.company_id
from public.company_members m where m.user_id = s.user_id and s.company_id is null;

update public.takeoff_jobs tj set company_id = m.company_id
from public.company_members m where m.user_id = tj.user_id and tj.company_id is null;

update public.ai_usage au set company_id = m.company_id
from public.company_members m where m.user_id = au.user_id and au.company_id is null;

update public.credit_transactions ct set company_id = m.company_id
from public.company_members m where m.user_id = ct.user_id and ct.company_id is null;

update public.billing_customers bc set company_id = m.company_id
from public.company_members m where m.user_id = bc.user_id and bc.company_id is null;

insert into public.company_settings (company_id, pricing_matrix, trades, bid_sharing_mode)
select m.company_id, us.pricing_matrix, us.trades, us.bid_sharing_mode
from public.user_settings us
join public.company_members m on m.user_id = us.user_id
where not exists (select 1 from public.company_settings cs where cs.company_id = m.company_id);

insert into public.user_preferences (user_id, dismissed_notices)
select us.user_id, us.dismissed_notices
from public.user_settings us
where not exists (select 1 from public.user_preferences up where up.user_id = us.user_id);
