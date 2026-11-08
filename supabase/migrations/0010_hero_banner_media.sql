-- 0010_hero_banner_media.sql
-- Local draft. NOT applied to production by the assistant. Review and run it yourself in the Supabase SQL Editor,
-- BEFORE deploying the application version that manages banner media.
--
-- Hero banners: video support, independent desktop / mobile media, "use desktop media on mobile", alt text, edit versioning and
-- atomic reordering. Purely additive and idempotent: no table, column or row is dropped or rewritten, banner ids / headlines / copy /
-- destinations / order / active state / image references are untouched, and the previous application version keeps working.
--
--   desktop_media_type / mobile_media_type   'image' (default: exactly today's behaviour) | 'video'
--   desktop_video / mobile_video             storage path in the `banner-media` bucket ('' = none). The existing desktop_image / mobile_image
--                                            columns stay the still pictures and become the POSTER of a video slot ('' = no poster).
--   use_desktop_on_mobile                    true = phones receive the desktop media (default false: today's separate mobile image)
--   alt_text                                 optional accessible description of the banner
--   created_at / updated_at                  updated_at is the version stamp that makes two admins' edits conflict instead of overwrite
--   reorder_hero_slides(uuid[])              rewrites sort_order for ALL banners in one transaction (stale lists are refused)
--   banner-media bucket                      public read, 12 MB, MP4 / WebM only. Uploads go through the admin API (service role) only.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.hero_slides add column if not exists desktop_media_type  text        not null default 'image';
alter table public.hero_slides add column if not exists desktop_video       text        not null default '';
alter table public.hero_slides add column if not exists mobile_media_type   text        not null default 'image';
alter table public.hero_slides add column if not exists mobile_video        text        not null default '';
alter table public.hero_slides add column if not exists use_desktop_on_mobile boolean   not null default false;
alter table public.hero_slides add column if not exists alt_text            text        not null default '';
alter table public.hero_slides add column if not exists created_at          timestamptz not null default now();
alter table public.hero_slides add column if not exists updated_at          timestamptz not null default now();

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.hero_slides'::regclass and conname = 'hero_slides_media_type_chk') then
    alter table public.hero_slides add constraint hero_slides_media_type_chk
      check (desktop_media_type in ('image', 'video') and mobile_media_type in ('image', 'video'));
  end if;
end $$;

create index if not exists hero_slides_order_idx on public.hero_slides (sort_order, id);

-- Atomic reorder. `p_ids` must contain every banner exactly once, otherwise the list the admin saw is stale and nothing is changed.
create or replace function public.reorder_hero_slides(p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  lock table public.hero_slides in share row exclusive mode;
  if coalesce(array_length(p_ids, 1), 0) <> (select count(*) from public.hero_slides)
     or (select count(distinct x) from unnest(p_ids) as x) <> coalesce(array_length(p_ids, 1), 0)
     or exists (select 1 from public.hero_slides h where h.id <> all (p_ids)) then
    raise exception 'order_stale' using errcode = 'P0001';
  end if;
  update public.hero_slides h set sort_order = o.pos
    from unnest(p_ids) with ordinality as o(id, pos)
   where h.id = o.id;
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.reorder_hero_slides(uuid[]) from public, anon, authenticated;
grant execute on function public.reorder_hero_slides(uuid[]) to service_role;

-- Video bucket: separate from `media` (whose image-only, 5 MB rules are untouched). 12582912 bytes = 12 MB, the same cap the app enforces.
-- The project-wide Storage upload limit (Dashboard -> Storage -> Settings) must be at least this value.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('banner-media', 'banner-media', true, 12582912, array['video/mp4', 'video/webm'])
on conflict (id) do update set public = true, file_size_limit = 12582912, allowed_mime_types = array['video/mp4', 'video/webm'];

commit;
