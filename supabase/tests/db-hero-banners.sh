#!/bin/bash
# Local-only test of migration 0010 (hero banner media, atomic reorder, banner-media bucket).
# Runs against a THROWAWAY Docker Postgres container with NO network and NO published ports; it is reachable only via `docker exec`.
# It never touches Supabase, the VPS or any real database, and reads no credentials or .env files.
cd "$(dirname "${BASH_SOURCE[0]}")/../.."   # repository root, wherever the repo is checked out
cleanup() { docker rm -f o218-m10 >/dev/null 2>&1; }
trap cleanup EXIT INT TERM
cleanup
docker run -d --name o218-m10 --network none -e POSTGRES_PASSWORD=t postgres:17-alpine >/dev/null || { echo "could not start the throwaway container"; exit 1; }
for i in $(seq 1 30); do docker exec o218-m10 pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done; sleep 2
P="docker exec -i o218-m10 psql -U postgres -v ON_ERROR_STOP=1 -q -t -A"
$P -c "create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create schema storage; create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);" >/dev/null
for f in 0001_init 0002_backend_features; do $P < supabase/migrations/$f.sql >/dev/null 2>&1 || echo "FAILED $f"; done
$P < supabase/seed.sql >/dev/null 2>&1
for f in 0003_service_role_grants 0004_stock_message 0005_returns_cancellation 0006_product_policies_payments 0007_save_product_policies 0008_stock_message_modes 0009_email_log_attempts; do $P < supabase/migrations/$f.sql >/dev/null 2>&1 || echo "FAILED $f"; done
pass=0; fail=0
t() { if [ "$2" == "$3" ]; then echo "PASS  $1"; pass=$((pass+1)); else echo "FAIL  $1 (expected '$3', got '$2')"; fail=$((fail+1)); fi; }
SNAP="select md5(string_agg(concat_ws('|', id, kicker, title, body, desktop_image, mobile_image, cta, href, active, sort_order), ';' order by id)) from hero_slides"

echo "--- before 0010 (the three seeded banners are today's production shape)"
t "seed gave three banners" "$($P -c "select count(*) from hero_slides")" "3"
t "no media columns yet" "$($P -c "select count(*) from information_schema.columns where table_name='hero_slides' and column_name in ('desktop_video','mobile_video','use_desktop_on_mobile','updated_at')")" "0"
BEFORE=$($P -c "$SNAP")
BEFORE_IDS=$($P -c "select string_agg(id::text, ',' order by id) from hero_slides")

echo "--- apply 0010 (twice: must be idempotent)"
$P < supabase/migrations/0010_hero_banner_media.sql >/dev/null 2>/tmp/e10 || { echo "0010 FAILED"; cat /tmp/e10; exit 1; }
$P < supabase/migrations/0010_hero_banner_media.sql >/dev/null 2>/tmp/e10 || { echo "0010 2nd run FAILED"; cat /tmp/e10; exit 1; }
t "re-running 0010 succeeds" "ok" "ok"

echo "--- existing banners are preserved"
t "same ids, headlines, copy, images, destinations, active state and order" "$($P -c "$SNAP")" "$BEFORE"
t "same ids" "$($P -c "select string_agg(id::text, ',' order by id) from hero_slides")" "$BEFORE_IDS"
t "every existing banner defaults to image slots" "$($P -c "select count(*) from hero_slides where desktop_media_type='image' and mobile_media_type='image' and desktop_video='' and mobile_video=''")" "3"
t "every existing banner keeps its own mobile image (not desktop-on-mobile)" "$($P -c "select count(*) from hero_slides where use_desktop_on_mobile = false")" "3"
t "alt text defaults to empty; created_at / updated_at are filled" "$($P -c "select count(*) from hero_slides where alt_text='' and created_at is not null and updated_at is not null")" "3"

echo "--- media type rules"
t "an unknown media type is refused" "$($P -c "update hero_slides set desktop_media_type='gif' where sort_order=1" 2>&1 | grep -c 'violates check')" "1"
t "video media can be stored without a poster" "$($P -c "update hero_slides set desktop_media_type='video', desktop_video='banners/2026/11/x.mp4', desktop_image='' where sort_order=1 returning desktop_media_type")" "video"
$P -c "update hero_slides set desktop_media_type='image', desktop_video='', desktop_image='/images/campaign/menswear-editorial-wide.webp' where sort_order=1" >/dev/null

echo "--- no banner-count limit"
$P -c "insert into hero_slides (title, desktop_image, mobile_image, sort_order) select 'extra '||g, '/d.webp', '/m.webp', 3+g from generate_series(1,12) g" >/dev/null
t "15 banners exist (3 + 12)" "$($P -c "select count(*) from hero_slides")" "15"

echo "--- reorder_hero_slides"
IDS=$($P -c "select string_agg(quote_literal(id::text), ',' order by sort_order desc, id) from hero_slides")
t "a complete list reverses the order in one call" "$($P -c "select reorder_hero_slides(array[$IDS]::uuid[])")" "15"
t "sort_order is now 1..15 without gaps" "$($P -c "select min(sort_order)||'-'||max(sort_order)||'-'||count(distinct sort_order) from hero_slides")" "1-15-15"
FIRST=$($P -c "select id from hero_slides order by sort_order limit 1")
t "the first id of the list is first" "$($P -c "select (array[$IDS])[1]")" "$FIRST"
t "a list missing a banner is refused as stale" "$($P -c "select reorder_hero_slides((select array_agg(id) from (select id from hero_slides limit 14) q))" 2>&1 | grep -c 'order_stale')" "1"
t "a list with a repeated banner is refused" "$($P -c "select reorder_hero_slides((select array_agg(id) from (select id from hero_slides order by id limit 14) q) || (select id from hero_slides order by id limit 1))" 2>&1 | grep -c 'order_stale')" "1"
t "a list with an unknown id is refused" "$($P -c "select reorder_hero_slides((select array_agg(id) from (select id from hero_slides limit 14) q) || gen_random_uuid())" 2>&1 | grep -c 'order_stale')" "1"
t "a refused call changed nothing" "$($P -c "select min(sort_order)||'-'||max(sort_order)||'-'||count(distinct sort_order) from hero_slides")" "1-15-15"
t "reordering does not change the edit version stamp" "$($P -c "select count(*) from hero_slides where updated_at > now()")" "0"

echo "--- function privileges"
t "anon may NOT execute reorder" "$($P -c "select has_function_privilege('anon','reorder_hero_slides(uuid[])','execute')")" "f"
t "authenticated may NOT execute reorder" "$($P -c "select has_function_privilege('authenticated','reorder_hero_slides(uuid[])','execute')")" "f"
t "service_role may execute reorder" "$($P -c "select has_function_privilege('service_role','reorder_hero_slides(uuid[])','execute')")" "t"

echo "--- banner-media bucket"
t "public read, 12 MB, MP4 and WebM only" "$($P -c "select public||'|'||file_size_limit||'|'||array_to_string(allowed_mime_types, ',') from storage.buckets where id='banner-media'")" "true|12582912|video/mp4,video/webm"
t "re-running did not duplicate the bucket" "$($P -c "select count(*) from storage.buckets where id='banner-media'")" "1"

echo; echo "passed: $pass  failed: $fail"
[ "$fail" -eq 0 ]
