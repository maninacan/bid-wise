-- Allow subcontractor users to read takeoffs that have been delegated to them.
-- A sub is identified by the linked_user_id on their subcontractors record.
-- We check whether any delegation entry in data.bid.delegations has a subId
-- matching one of the current user's linked subcontractor records.

CREATE POLICY "subs_can_read_delegated_takeoffs"
ON takeoffs FOR SELECT
USING (
  EXISTS (
    SELECT 1
    FROM subcontractors s
    CROSS JOIN LATERAL jsonb_each(
      COALESCE(data->'bid'->'delegations', '{}'::jsonb)
    ) AS d(key, val)
    WHERE s.linked_user_id = auth.uid()
    AND (d.val->>'subId') = s.id::text
  )
);
