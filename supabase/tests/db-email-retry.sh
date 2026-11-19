#!/bin/bash
# Local-only test of migration 0009 (email retry queue) and of the late-payment facts the email code relies on.
# Runs against a THROWAWAY Docker Postgres container with NO network and NO published ports; it is reachable only via `docker exec`.
# It never touches Supabase, the VPS or any real database, and reads no credentials or .env files.
cd "$(dirname "${BASH_SOURCE[0]}")/../.."   # repository root, wherever the repo is checked out
cleanup() { docker rm -f o218-m9 >/dev/null 2>&1; }
trap cleanup EXIT INT TERM
cleanup
docker run -d --name o218-m9 --network none -e POSTGRES_PASSWORD=t postgres:17-alpine >/dev/null || { echo "could not start the throwaway container"; exit 1; }
for i in $(seq 1 30); do docker exec o218-m9 pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done; sleep 2
P="docker exec -i o218-m9 psql -U postgres -v ON_ERROR_STOP=1 -q -t -A"
$P -c "create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create schema storage; create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);" >/dev/null
for f in 0001_init 0002_backend_features; do $P < supabase/migrations/$f.sql >/dev/null 2>&1 || echo "FAILED $f"; done
$P < supabase/seed.sql >/dev/null 2>&1
for f in 0003_service_role_grants 0004_stock_message 0005_returns_cancellation 0006_product_policies_payments 0007_save_product_policies 0008_stock_message_modes; do $P < supabase/migrations/$f.sql >/dev/null 2>&1 || echo "FAILED $f"; done
pass=0; fail=0
t() { if [ "$2" == "$3" ]; then echo "PASS  $1"; pass=$((pass+1)); else echo "FAIL  $1 (expected '$3', got '$2')"; fail=$((fail+1)); fi; }
row() { $P -c "insert into email_log (kind, to_email, subject, dedupe_key, status, next_attempt_at) values ('order_status','a@b.co','s','$1','$2',$3) returning id"; }

echo "--- before 0009"
t "old status CHECK rejects 'uncertain'" "$($P -c "insert into email_log (kind,to_email,subject,status) values ('k','a@b.co','s','uncertain')" 2>&1 | grep -c 'violates check')" "1"

echo "--- apply 0009 (twice: must be idempotent)"
$P < supabase/migrations/0009_email_log_attempts.sql >/dev/null 2>/tmp/e9 || { echo "0009 FAILED"; cat /tmp/e9; exit 1; }
$P < supabase/migrations/0009_email_log_attempts.sql >/dev/null 2>/tmp/e9 || { echo "0009 2nd run FAILED"; cat /tmp/e9; exit 1; }
t "re-running 0009 succeeds" "ok" "ok"
t "four new columns" "$($P -c "select count(*) from information_schema.columns where table_name='email_log' and column_name in ('attempts','last_attempt_at','next_attempt_at','provider')")" "4"
t "exactly one status CHECK remains" "$($P -c "select count(*) from pg_constraint where conrelid='public.email_log'::regclass and contype='c' and pg_get_constraintdef(oid) ilike '%status%'")" "1"
for s in queued sending accepted delivered bounced complained failed skipped_unconfigured uncertain; do
  t "status '$s' is allowed" "$($P -c "insert into email_log (kind,to_email,subject,status) values ('k','a@b.co','s','$s') returning 1" 2>&1 | head -1)" "1"
done
t "unknown status rejected" "$($P -c "insert into email_log (kind,to_email,subject,status) values ('k','a@b.co','s','bogus')" 2>&1 | grep -c 'violates check')" "1"
t "dedupe_key stays unique" "$(row dup-1 queued null >/dev/null; row dup-1 queued null 2>&1 | grep -c 'duplicate key')" "1"

echo "--- claim_email_log"
Q=$(row claim-q queued null)
C1=$($P -c "select claim_email_log('$Q') is not null"); t "queued row is claimed" "$C1" "t"
t "claim sets sending, attempts=1" "$($P -c "select status||attempts from email_log where id='$Q'")" "sending1"
t "second claim of the same row returns nothing" "$($P -c "select claim_email_log('$Q') is null")" "t"
FD=$(row claim-fd failed "now() - interval '1 minute'"); t "failed + due is claimable" "$($P -c "select claim_email_log('$FD') is not null")" "t"
FF=$(row claim-ff failed "now() + interval '1 hour'"); t "failed + not yet due is NOT claimable" "$($P -c "select claim_email_log('$FF') is null")" "t"
FP=$(row claim-fp failed null); t "failed + permanent (no next attempt) is NOT claimable" "$($P -c "select claim_email_log('$FP') is null")" "t"
SK=$(row claim-sk skipped_unconfigured "now() - interval '1 minute'"); t "skipped_unconfigured + due is claimable" "$($P -c "select claim_email_log('$SK') is not null")" "t"
UC=$(row claim-uc uncertain "now() - interval '1 minute'"); t "uncertain is NEVER claimable" "$($P -c "select claim_email_log('$UC') is null")" "t"
AC=$(row claim-ac accepted null); t "accepted is NEVER claimable" "$($P -c "select claim_email_log('$AC') is null")" "t"
t "unknown id returns nothing" "$($P -c "select claim_email_log(gen_random_uuid()) is null")" "t"

echo "--- two concurrent workers claim the same row: exactly one wins"
RC=$(row claim-race queued null)
( echo "begin; select 'A:'||(claim_email_log('$RC') is not null); select pg_sleep(2); commit;" | docker exec -i o218-m9 psql -U postgres -q -t -A > /tmp/raceA ) &
sleep 0.7
echo "select 'B:'||(claim_email_log('$RC') is not null);" | docker exec -i o218-m9 psql -U postgres -q -t -A > /tmp/raceB
wait
t "worker A won"  "$(grep -c 'A:true' /tmp/raceA)" "1"
t "worker B lost" "$(grep -c 'B:false' /tmp/raceB)" "1"
t "attempts counted once" "$($P -c "select attempts from email_log where id='$RC'")" "1"

echo "--- sweep_stale_email_sending (a crashed worker must not cause a resend)"
S1=$(row sweep-old sending null); $P -c "update email_log set last_attempt_at = now() - interval '20 minutes' where id='$S1'" >/dev/null
S2=$(row sweep-new sending null); $P -c "update email_log set last_attempt_at = now() where id='$S2'" >/dev/null
$P -c "select sweep_stale_email_sending(600)" >/dev/null
t "stale 'sending' becomes 'uncertain'" "$($P -c "select status from email_log where id='$S1'")" "uncertain"
t "fresh 'sending' is untouched" "$($P -c "select status from email_log where id='$S2'")" "sending"
t "swept row is then not claimable" "$($P -c "select claim_email_log('$S1') is null")" "t"

echo "--- D4: ineligible rows cannot starve eligible ones (same predicates as the application's two candidate queries)"
$P -c "delete from email_log where kind = 'starve'" >/dev/null
# 300 ineligible rows, all OLDER than the eligible ones and ALL matching the old query's status filter: permanent failures, retries not
# yet due, old-style skipped rows (no retry time), and queued rows still inside the live request's two-minute grace
$P -c "insert into email_log (kind,to_email,subject,dedupe_key,status,attempts,created_at,next_attempt_at)
  select 'starve','a@b.co','s','starve-bad-'||g,
         (array['failed','failed','skipped_unconfigured','failed','failed','queued'])[1 + g % 6],
         1,
         now() - interval '20 hours' + (g || ' seconds')::interval,
         case g % 6 when 1 then now() + interval '1 hour' when 4 then now() + interval '3 hours' else null end
  from generate_series(1,300) g" >/dev/null
$P -c "update email_log set created_at = now() where kind='starve' and status='queued'" >/dev/null   # queued rows younger than the 2-minute grace
$P -c "insert into email_log (kind,to_email,subject,dedupe_key,status,attempts,created_at,next_attempt_at) values
  ('starve','a@b.co','s','starve-good-q','queued',0, now() - interval '30 minutes', null),
  ('starve','a@b.co','s','starve-good-f','failed',1, now() - interval '20 minutes', now() - interval '1 minute'),
  ('starve','a@b.co','s','starve-good-s','skipped_unconfigured',0, now() - interval '10 minutes', now() - interval '1 minute')" >/dev/null
ELIGIBLE="select dedupe_key, created_at from email_log where kind <> 'system_alert' and kind = 'starve' and created_at >= now() - interval '24 hours' and attempts < 6
  and ((status = 'queued' and created_at <= now() - interval '2 minutes')
    or (status in ('failed','skipped_unconfigured') and next_attempt_at is not null and next_attempt_at <= now()))"
t "300 ineligible rows exist, more than the 200-row limit" "$($P -c "select count(*) = 300 from email_log where kind='starve' and dedupe_key like 'starve-bad-%'")" "t"
t "the eligibility predicate selects only the 3 eligible rows" "$($P -c "select count(*) from ($ELIGIBLE) x")" "3"
t "with the 200-row limit applied AFTER eligibility, all 3 are returned, oldest first" "$($P -c "select string_agg(dedupe_key, ',' order by created_at) from (select * from ($ELIGIBLE) y order by created_at limit 200) x")" "starve-good-q,starve-good-f,starve-good-s"
t "the OLD approach (limit before eligibility) would have missed them" "$($P -c "select count(*) from (select * from email_log where kind='starve' and status in ('queued','failed','skipped_unconfigured') and created_at >= now() - interval '24 hours' and attempts < 6 order by created_at limit 200) x where dedupe_key like 'starve-good-%'")" "0"
t "pre-0009 style skipped_unconfigured rows (no next_attempt_at) are never eligible" "$($P -c "insert into email_log (kind,to_email,subject,dedupe_key,status) values ('starve','a@b.co','s','starve-old-skipped','skipped_unconfigured') returning 1" | head -1)$($P -c "select count(*) from ($ELIGIBLE) x where dedupe_key='starve-old-skipped'")" "10"
t "a recovered row keeps the event time it is given (created_at is a plain column)" "$($P -c "insert into email_log (kind,to_email,subject,dedupe_key,status,created_at) values ('order_status','a@b.co','s','order:o9:delivered','queued', now() - interval '90 minutes') returning (created_at < now() - interval '89 minutes')" | head -1)" "t"
$P -c "delete from email_log where kind = 'starve'" >/dev/null

echo "--- privileges"
t "service_role may execute claim"  "$($P -c "select has_function_privilege('service_role','claim_email_log(uuid)','execute')")" "t"
t "anon may NOT execute claim"      "$($P -c "select has_function_privilege('anon','claim_email_log(uuid)','execute')")" "f"
t "authenticated may NOT execute claim" "$($P -c "select has_function_privilege('authenticated','claim_email_log(uuid)','execute')")" "f"
t "anon may NOT execute sweep"      "$($P -c "select has_function_privilege('anon','sweep_stale_email_sending(integer)','execute')")" "f"
t "email_log has RLS enabled"       "$($P -c "select relrowsecurity from pg_class where oid='public.email_log'::regclass")" "t"

echo "--- late payment facts the email code depends on (existing settle_payment, untouched)"
CAT=$($P -c "select id from categories limit 1")
SP="'images',jsonb_build_array('uploads/a.webp'),'fit','','material','','description','','best_seller',false,'new_arrival',false,'luxe',false,'status','active','stock_display','status'"
PR=$($P -c "select save_product(jsonb_build_object('id','','slug','late','name','late','category_id','$CAT','price',500,'compare_at',0,'color','x','color_hex','#000000','badge','',$SP,'variants',jsonb_build_array(jsonb_build_object('size','M','sku','','stock',10))), null)" | head -1)
order() { local v c; v=$($P -c "select id from product_variants where product_id='$1'"); c=$($P -c "insert into carts default values returning id" | head -1)
  $P -c "insert into cart_items(cart_id,variant_id,quantity) values ('$c','$v',$2)" >/dev/null
  $P -c "select place_order(jsonb_build_object('cart_id','$c','customer_id','','contact','{\"name\":\"QA\",\"phone\":\"9876543210\"}'::jsonb,'shipping_address','{}'::jsonb,'payment_method','$3','coupon_code','','discount',0,'shipping',0,'expected_subtotal',$((500*$2)),'lookup_token_hash','h','provider','$3'))" | head -1; }
# online order, cancelled before payment, then money arrives
LATE=$(order $PR 1 upi)
$P -c "select transition_order('$LATE','cancelled',null,'Payment could not be started')" >/dev/null
SET=$($P -c "select settle_payment('$LATE','pay_late',true)")
t "late payment on a cancelled order reports changed=true" "$(echo "$SET" | grep -c '"changed": true')" "1"
t "late payment is flagged needs_refund=true" "$(echo "$SET" | grep -c '"needs_refund": true')" "1"
t "no 'confirmed' history row is created for it (so the reconciler never invents a confirmation)" "$($P -c "select count(*) from order_status_history where order_id='$LATE' and to_status='confirmed'")" "0"
# normal online payment: confirmed history row exists, no needs_refund
OK1=$(order $PR 1 upi)
SET2=$($P -c "select settle_payment('$OK1','pay_ok',true)")
t "normal payment: changed=true, no needs_refund" "$(echo "$SET2" | grep -c '"changed": true')$(echo "$SET2" | grep -c needs_refund)" "10"
t "normal payment records exactly one 'confirmed' history row" "$($P -c "select count(*) from order_status_history where order_id='$OK1' and to_status='confirmed'")" "1"
t "second settle (duplicate webhook) reports changed=false" "$($P -c "select settle_payment('$OK1','pay_ok',true)" | grep -c '"changed": false')" "1"
# COD: confirmed history row at placement
COD=$(order $PR 1 cod)
t "COD order has its 'confirmed' history row from placement" "$($P -c "select count(*) from order_status_history where order_id='$COD' and to_status='confirmed'")" "1"
# a system cancellation records actor 'system' (the reconciler must not email those)
t "system cancellation is recorded with actor_type='system'" "$($P -c "select actor_type from order_status_history where order_id='$LATE' and to_status='cancelled'")" "system"

echo "-----"
echo "$pass passed, $fail failed"
[ "$fail" == "0" ]
