-- 0011: editable "THE PRIVATE EDIT" (Luxe feature) band on the homepage.
-- One nullable jsonb column on the existing single-row store_settings table. No table, no data change, nothing dropped or renamed.
-- NULL (the state right after this migration) means "use the built-in copy", so the homepage looks exactly as before until an admin saves.
-- Shape (validated by the API, never trusted from the database):
--   { enabled, image, imageAlt, eyebrow, heading, bodyLine1, bodyLine2, ctaLabel, ctaHref }
-- `image` is a Supabase Storage path in the existing public images bucket (same convention as products, categories and hero banners).
alter table public.store_settings add column if not exists luxe_feature jsonb;
comment on column public.store_settings.luxe_feature is 'Homepage Luxe feature band content (see supabase/migrations/0011_luxe_feature.sql). NULL = built-in defaults.';
