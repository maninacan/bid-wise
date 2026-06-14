ALTER TABLE public.user_settings
  ADD COLUMN trades TEXT[] NOT NULL DEFAULT '{}';
