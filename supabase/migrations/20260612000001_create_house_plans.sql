-- Table tracking uploaded house plan files
create table public.house_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  file_name text not null,
  storage_path text not null unique,
  file_size bigint not null,
  content_type text,
  created_at timestamptz not null default now()
);

alter table public.house_plans enable row level security;

create policy "Users can view own plans"
  on public.house_plans for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can insert own plans"
  on public.house_plans for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can delete own plans"
  on public.house_plans for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- Private storage bucket for house plans; files live under <user_id>/<filename>
insert into storage.buckets (id, name, public)
values ('house-plans', 'house-plans', false);

create policy "Users can upload own plan files"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'house-plans'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "Users can read own plan files"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'house-plans'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "Users can delete own plan files"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'house-plans'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
