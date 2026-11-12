-- 0012_storage_image_upload_limit.sql
-- Increase file size limit for the public 'media' bucket to 10 MB (10485760 bytes).
-- This accommodates 10 MB images and compressed outputs from the browser image optimizer.
-- Hero video bucket ('banner-media', 12 MB) and existing policies remain unchanged.

update storage.buckets
set file_size_limit = 10485760
where id = 'media';

-- If the bucket was not yet present (e.g. fresh installation), insert or update idempotently:
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', true, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'image/avif'])
on conflict (id) do update set file_size_limit = 10485760;
