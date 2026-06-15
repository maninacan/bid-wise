-- User-initiated cancellation of an in-progress takeoff generation. The client asks
-- the api to cancel (it can't write the row directly — RLS is read-only for clients);
-- the api flips cancel_requested, the running handler polls it, aborts the model
-- stream, and finalizes the job as 'canceled'.
ALTER TABLE takeoff_jobs ADD COLUMN cancel_requested BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE takeoff_jobs DROP CONSTRAINT takeoff_jobs_status_check;
ALTER TABLE takeoff_jobs ADD CONSTRAINT takeoff_jobs_status_check
  CHECK (status IN ('running', 'done', 'error', 'canceled'));
