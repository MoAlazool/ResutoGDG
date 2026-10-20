-- CR-12: guest menus and public sites were served the uploaded originals (up to 15 MB). Uploads to the guest-facing
-- folders (menu, studio) now store WebP derivatives next to the original (<uuid>.w320.webp, .w640.webp, .w1280.webp,
-- never wider than the original) and record them here with the original's dimensions (width/height already exist,
-- so pages can reserve space and avoid layout shift).
--   variants             [{"w": 640, "h": 427, "path": "<org>/menu/<uuid>.w640.webp", "bytes": 31544}, ...]
--   variants_checked_at  set once derivatives were produced (or found unnecessary); null = the backfill job
--                        (media.derivatives) has not looked at this object yet.
-- Reverse: alter table media_assets drop column variants, drop column variants_checked_at;
alter table public.media_assets add column if not exists variants jsonb not null default '[]'::jsonb;
alter table public.media_assets add column if not exists variants_checked_at timestamptz;
alter table public.media_assets add constraint media_assets_variants_array check (jsonb_typeof(variants) = 'array');
-- Backfill queue: guest-facing images not yet processed.
create index if not exists media_assets_variants_pending_idx on public.media_assets (created_at)
  where variants_checked_at is null and content_type in ('image/png', 'image/jpeg', 'image/webp');
