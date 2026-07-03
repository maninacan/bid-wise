-- Editable project display name. Falls back to the uploaded file name when null, so the
-- original filename is always preserved. Clients rename via an UPDATE (RLS-scoped to the
-- owner); house_plans previously had no UPDATE policy.
ALTER TABLE house_plans ADD COLUMN name TEXT;

CREATE POLICY "Users can update own plans" ON house_plans
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
