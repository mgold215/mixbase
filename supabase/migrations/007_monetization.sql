-- Migration 007: Subscription tier + usage tracking schema
-- Adds monetization columns to profiles and creates mb_usage table with RLS.

-- ============================================================
-- 1. Add subscription / billing columns to profiles
-- ============================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS subscription_tier       TEXT NOT NULL DEFAULT 'free'
    CONSTRAINT profiles_subscription_tier_check CHECK (subscription_tier IN ('free', 'pro', 'studio')),
  ADD COLUMN IF NOT EXISTS subscription_source     TEXT,
  ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stripe_customer_id      TEXT,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id  TEXT,
  ADD COLUMN IF NOT EXISTS apple_original_transaction_id TEXT;

-- Unique partial indexes: same Stripe/Apple ID can't appear on two profiles,
-- but NULL values (no subscription) are allowed for every row.
CREATE UNIQUE INDEX IF NOT EXISTS profiles_stripe_customer_id_idx
  ON public.profiles (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS profiles_stripe_subscription_id_idx
  ON public.profiles (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

-- ============================================================
-- 2. Create mb_usage — tracks feature usage per user per month
-- ============================================================

CREATE TABLE IF NOT EXISTS public.mb_usage (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  month               TEXT        NOT NULL,   -- format: 'YYYY-MM'
  artwork_generations INT         NOT NULL DEFAULT 0,
  video_generations   INT         NOT NULL DEFAULT 0,
  updated_at          TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, month)
);

CREATE INDEX IF NOT EXISTS mb_usage_user_month_idx
  ON public.mb_usage (user_id, month);

ALTER TABLE public.mb_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own usage"   ON public.mb_usage;
DROP POLICY IF EXISTS "Users can insert their own usage" ON public.mb_usage;
DROP POLICY IF EXISTS "Users can update their own usage" ON public.mb_usage;

CREATE POLICY "Users can view their own usage"
  ON public.mb_usage FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Users can insert their own usage"
  ON public.mb_usage FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update their own usage"
  ON public.mb_usage FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ============================================================
-- 3. Atomic usage increment functions (SECURITY DEFINER)
--    Runs with owner privileges to bypass RLS on upsert.
--    Anon/authenticated roles are revoked from calling directly.
-- ============================================================

CREATE OR REPLACE FUNCTION public.increment_artwork_usage(
  p_user_id UUID,
  p_month   TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.mb_usage (user_id, month, artwork_generations, video_generations, updated_at)
  VALUES (p_user_id, p_month, 1, 0, now())
  ON CONFLICT (user_id, month)
  DO UPDATE SET
    artwork_generations = mb_usage.artwork_generations + 1,
    updated_at          = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.increment_video_usage(
  p_user_id UUID,
  p_month   TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.mb_usage (user_id, month, artwork_generations, video_generations, updated_at)
  VALUES (p_user_id, p_month, 0, 1, now())
  ON CONFLICT (user_id, month)
  DO UPDATE SET
    video_generations = mb_usage.video_generations + 1,
    updated_at        = now();
END;
$$;

-- Prevent client-side calls with arbitrary user IDs — only service-role can call
REVOKE EXECUTE ON FUNCTION public.increment_artwork_usage(uuid, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.increment_video_usage(uuid, text)   FROM anon, authenticated;
