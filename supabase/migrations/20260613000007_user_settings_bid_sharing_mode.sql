ALTER TABLE public.user_settings
  ADD COLUMN bid_sharing_mode TEXT NOT NULL DEFAULT 'full';
