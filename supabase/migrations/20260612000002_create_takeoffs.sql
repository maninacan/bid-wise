-- Structured quantity takeoffs generated from uploaded house plans
create table public.takeoffs (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.house_plans (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  model text not null,
  data jsonb not null,
  created_at timestamptz not null default now()
);

create index takeoffs_plan_id_idx on public.takeoffs (plan_id);

alter table public.takeoffs enable row level security;

create policy "Users can view own takeoffs"
  on public.takeoffs for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can delete own takeoffs"
  on public.takeoffs for delete
  to authenticated
  using ((select auth.uid()) = user_id);
-- Inserts happen via the generate-takeoff edge function (service role).
