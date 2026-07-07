-- Migration 017 — race-safe usage metering + unique version numbers
--
-- Two data-integrity fixes:
--   1. try_increment_usage(): an ATOMIC "increment only if under the limit"
--      counter. The old flow read the count in JS, compared it to the tier
--      limit, then called increment_*_usage — two concurrent generations could
--      both pass the read and both increment, letting a user exceed their tier.
--      This function takes a row lock so the check and increment are one step.
--   2. A UNIQUE index on (project_id, version_number). Versions were numbered as
--      max(version_number)+1 read-then-insert, so simultaneous uploads to one
--      project produced duplicate "v2"s. A dedupe pass renumbers any existing
--      collisions before the constraint is added.

-- ============================================================
-- 1. Atomic, limit-enforcing usage increment (SECURITY DEFINER)
-- ============================================================
CREATE OR REPLACE FUNCTION public.try_increment_usage(
  p_user_id UUID,
  p_month   TEXT,
  p_feature TEXT,   -- 'artwork' | 'video'
  p_limit   INT
)
RETURNS TABLE(allowed BOOLEAN, used INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_used INT;
BEGIN
  -- Make sure a row exists so it can be locked and read atomically.
  INSERT INTO public.mb_usage (user_id, month, artwork_generations, video_generations, updated_at)
  VALUES (p_user_id, p_month, 0, 0, now())
  ON CONFLICT (user_id, month) DO NOTHING;

  -- Lock this user's month row; concurrent callers serialize here.
  SELECT CASE WHEN p_feature = 'artwork' THEN artwork_generations ELSE video_generations END
    INTO v_used
    FROM public.mb_usage
   WHERE user_id = p_user_id AND month = p_month
   FOR UPDATE;

  IF v_used >= p_limit THEN
    allowed := FALSE;
    used    := v_used;
    RETURN NEXT;
    RETURN;
  END IF;

  IF p_feature = 'artwork' THEN
    UPDATE public.mb_usage
       SET artwork_generations = artwork_generations + 1, updated_at = now()
     WHERE user_id = p_user_id AND month = p_month;
  ELSE
    UPDATE public.mb_usage
       SET video_generations = video_generations + 1, updated_at = now()
     WHERE user_id = p_user_id AND month = p_month;
  END IF;

  allowed := TRUE;
  used    := v_used + 1;
  RETURN NEXT;
END;
$$;

-- Only service-role may call it (arbitrary p_user_id must not be client-callable).
REVOKE EXECUTE ON FUNCTION public.try_increment_usage(uuid, text, text, int) FROM anon, authenticated;

-- ============================================================
-- 2. Unique (project_id, version_number) — dedupe then constrain
-- ============================================================
-- Dense-renumber each project's versions by (version_number, created_at) so any
-- duplicates become distinct. Idempotent: rows already correctly numbered are
-- left untouched, so this is safe to re-run (e.g. from the runtime self-heal).
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY project_id
           ORDER BY version_number ASC, created_at ASC, id ASC
         ) AS rn
    FROM public.mb_versions
)
UPDATE public.mb_versions v
   SET version_number = ranked.rn
  FROM ranked
 WHERE v.id = ranked.id
   AND v.version_number <> ranked.rn;

CREATE UNIQUE INDEX IF NOT EXISTS mb_versions_project_version_uidx
  ON public.mb_versions (project_id, version_number);
