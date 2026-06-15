-- Tracks in-progress takeoff generation so progress survives a page refresh and
-- acts as a per-plan single-in-flight lock. Server (service role) owns all writes;
-- the client only reads (RLS) and watches changes via Supabase Realtime.
CREATE TABLE takeoff_jobs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan_id     UUID NOT NULL REFERENCES house_plans(id) ON DELETE CASCADE,
  status      TEXT NOT NULL CHECK (status IN ('running','done','error')),
  phase       TEXT,
  trades      TEXT[] NOT NULL DEFAULT '{}',
  error       TEXT,
  takeoff_id  UUID REFERENCES takeoffs(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX takeoff_jobs_active_idx ON takeoff_jobs (user_id, plan_id) WHERE status = 'running';

-- DB-enforced lock: at most one running job per (user, plan); backstops the app-level check.
CREATE UNIQUE INDEX takeoff_jobs_one_running_idx ON takeoff_jobs (user_id, plan_id) WHERE status = 'running';

ALTER TABLE takeoff_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own takeoff_jobs" ON takeoff_jobs
  FOR SELECT USING (auth.uid() = user_id);

-- Realtime: full row identity so filtered change payloads carry the columns the client filters on.
ALTER TABLE takeoff_jobs REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE takeoff_jobs;
