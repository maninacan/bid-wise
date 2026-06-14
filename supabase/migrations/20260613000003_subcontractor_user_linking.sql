-- Track which auth user IS this subcontractor (distinct from user_id = the GC who owns the record)
ALTER TABLE public.subcontractors
  ADD COLUMN linked_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX subcontractors_linked_user_id_idx
  ON public.subcontractors(linked_user_id)
  WHERE linked_user_id IS NOT NULL;

-- Backfill: link existing subcontractors to already-confirmed users
UPDATE public.subcontractors s
SET linked_user_id = u.id
FROM auth.users u
WHERE lower(u.email) = lower(s.contact_email)
  AND u.email_confirmed_at IS NOT NULL
  AND s.contact_email IS NOT NULL
  AND s.linked_user_id IS NULL;

-- ── Trigger 1: fired when a user confirms their email ────────────────────────
-- Links any subcontractor records whose contact_email matches.
CREATE OR REPLACE FUNCTION public.link_user_to_subcontractors()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only act when the user has a confirmed email
  IF NEW.email IS NULL OR NEW.email_confirmed_at IS NULL THEN
    RETURN NEW;
  END IF;

  -- For UPDATE rows, only fire the first time email_confirmed_at is set
  IF TG_OP = 'UPDATE' AND OLD.email_confirmed_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  UPDATE public.subcontractors
  SET linked_user_id = NEW.id
  WHERE lower(contact_email) = lower(NEW.email)
    AND linked_user_id IS NULL;

  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_email_confirmed
  AFTER INSERT OR UPDATE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.link_user_to_subcontractors();

-- ── Trigger 2: fired when a subcontractor record is created or its email changes ──
-- Immediately links to the user if one already exists with that email.
CREATE OR REPLACE FUNCTION public.link_subcontractor_to_existing_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.contact_email IS NULL THEN
    NEW.linked_user_id := NULL;
    RETURN NEW;
  END IF;

  SELECT id INTO NEW.linked_user_id
  FROM auth.users
  WHERE lower(email) = lower(NEW.contact_email)
    AND email_confirmed_at IS NOT NULL
  LIMIT 1;

  RETURN NEW;
END;
$$;

CREATE TRIGGER on_subcontractor_email_set
  BEFORE INSERT OR UPDATE OF contact_email ON public.subcontractors
  FOR EACH ROW EXECUTE FUNCTION public.link_subcontractor_to_existing_user();
