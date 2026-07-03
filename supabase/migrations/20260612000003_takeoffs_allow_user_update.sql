CREATE POLICY "Users can update own takeoffs"
ON public.takeoffs
FOR UPDATE
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);
