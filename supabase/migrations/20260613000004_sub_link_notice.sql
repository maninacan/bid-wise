-- Allow a linked sub to see the subcontractor records that reference them
CREATE POLICY "Linked users can view their own sub records" ON public.subcontractors
  FOR SELECT USING (linked_user_id = auth.uid());

-- Store which one-time notices a user has permanently dismissed
ALTER TABLE public.user_settings
  ADD COLUMN dismissed_notices TEXT[] NOT NULL DEFAULT '{}';
