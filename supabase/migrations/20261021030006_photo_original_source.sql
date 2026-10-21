-- FT-04 review: food-photo originals are private inputs (they keep the camera's EXIF/GPS metadata and are never
-- modified), so they get their own media source 'photo_original' and stay out of the website media library and
-- website sections, like menu-import originals ('import'). Existing originals are relabelled.
-- Reverse: update media_assets set source = 'upload' where source = 'photo_original'; restore the check without it.
alter table public.media_assets drop constraint if exists media_assets_source_check;
alter table public.media_assets add constraint media_assets_source_check
  check (source in ('upload', 'ai_generated', 'import', 'legacy', 'studio_enhanced', 'photo_original'));

update public.media_assets m set source = 'photo_original'
  from public.studio_photo_jobs j
 where j.source_media_id = m.id and m.source = 'upload';
