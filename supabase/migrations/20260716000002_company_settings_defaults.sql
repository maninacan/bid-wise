-- Phase 3 companion fix: the companies migration (20260715000002) gave company_settings
-- SELECT/UPDATE RLS policies but no INSERT policy, and create_company_with_owner never
-- seeded a row. Every *pre-existing* company got one via the Phase 1 backfill, but a
-- brand-new company (via the createCompany resolver) had neither a row nor a way for the
-- client's saveSettings() upsert to create one. Fix both: seed a default row atomically at
-- company creation, and add the missing INSERT policy as defense-in-depth (same member tier
-- as the existing UPDATE policy — decision 6: shared, member-editable business policy).

create policy "Company members can insert settings" on public.company_settings
  for insert to authenticated with check (is_company_member(company_id));

create or replace function public.create_company_with_owner(p_name text, p_owner uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_company_id uuid;
begin
  insert into public.companies (name, created_by) values (p_name, p_owner) returning id into v_company_id;
  insert into public.company_members (company_id, user_id, role) values (v_company_id, p_owner, 'owner');
  insert into public.company_settings (company_id) values (v_company_id);
  return v_company_id;
end; $$;
revoke execute on function public.create_company_with_owner(text, uuid) from public, anon, authenticated;
