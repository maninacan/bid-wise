-- Persist the model's streamed narration so it can be restored when a client
-- reattaches to a running job after a page refresh. Written throttled by the server.
ALTER TABLE takeoff_jobs ADD COLUMN narration TEXT;
