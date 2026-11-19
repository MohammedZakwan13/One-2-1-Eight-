-- 0013: raise the banner video bucket's per-file limit from 12 MB to 50 MB (52428800 bytes = 50 MiB).
-- The admin now chooses how a homepage video is optimised (Original Quality by default, or automatic compression), so the old fixed 12 MB
-- output limit is gone. 50 MiB matches the project-wide per-file upload limit of the Supabase Free plan (Dashboard -> Storage -> Settings):
-- a larger bucket limit would have no effect, because Supabase refuses files above the project-wide limit regardless of the bucket.
-- Only the banner-media bucket's file_size_limit changes. Its public setting and allowed MIME types (video/mp4, video/webm), the `media`
-- bucket, and every row and file are left exactly as they are.
update storage.buckets
   set file_size_limit = 52428800
 where id = 'banner-media';
