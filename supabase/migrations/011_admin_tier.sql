-- Migration 011: Add admin tier for platform owner
-- Drops the existing tier CHECK constraint and re-creates it with 'admin' included.

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_subscription_tier_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_subscription_tier_check
  CHECK (subscription_tier IN ('free', 'pro', 'studio', 'admin'));
