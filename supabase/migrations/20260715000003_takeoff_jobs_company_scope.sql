-- Phase 2 companion migration: re-key the "one running takeoff per plan" concurrency
-- guard from per-user to per-company. Multiple members of the same company can now act
-- on the same plan (apps/api/src/generate-takeoff.ts checks company membership, not
-- user_id, before starting a run), so the lock — and its supporting indexes — must be
-- enforced at the company level or two different teammates could start concurrent runs
-- for the same plan.
DROP INDEX IF EXISTS takeoff_jobs_active_idx;
DROP INDEX IF EXISTS takeoff_jobs_one_running_idx;

CREATE INDEX takeoff_jobs_active_idx ON public.takeoff_jobs (company_id, plan_id) WHERE status = 'running';
CREATE UNIQUE INDEX takeoff_jobs_one_running_idx ON public.takeoff_jobs (company_id, plan_id) WHERE status = 'running';
