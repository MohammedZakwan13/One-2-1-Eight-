#!/bin/bash
# Local-only test of migration 0008 (strict save_product inventory protection, stock message rules, migration safety).
# Runs against a THROWAWAY Docker Postgres container with NO network and NO published ports; it is reachable only via `docker exec`.
# It never touches Supabase, the VPS or any real database, and reads no credentials or .env files.
cd "$(dirname "${BASH_SOURCE[0]}")/../.."   # repository root, wherever the repo is checked out
cleanup() { docker rm -f o218-m8 >/dev/null 2>&1; }
trap cleanup EXIT INT TERM
cleanup
docker run -d --name o218-m8 --network none -e POSTGRES_PASSWORD=t postgres:17-alpine >/dev/null || { echo "could not start the throwaway container"; exit 1; }
for i in $(seq 1 30); do docker exec o218-m8 pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done; sleep 2
P="docker exec -i o218-m8 psql -U postgres -v ON_ERROR_STOP=1 -q -t -A"
$P -c "create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create schema storage; create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);" >/dev/null
for f in 0001_init 0002_backend_features; do $P < supabase/migrations/$f.sql >/dev/null 2>&1 || echo "FAILED $f"; done
$P < supabase/seed.sql >/dev/null 2>&1
# 0003..0007 = the schema production has BEFORE 0008 (0007 = the verified production save_product)
for f in 0003_service_role_grants 0004_stock_message 0005_returns_cancellation 0006_product_policies_payments 0007_save_product_policies; do $P < supabase/migrations/$f.sql >/dev/null 2>&1 || echo "FAILED $f"; done
pass=0; fail=0
t() { if [ "$2" == "$3" ]; then echo "PASS  $1"; pass=$((pass+1)); else echo "FAIL  $1 (expected '$3', got '$2')"; fail=$((fail+1)); fi; }
CAT=$($P -c "select id from categories limit 1")
# save <id|''> <extra json members> <variants json or ''> <expected json or ''>   (extras are MERGED over the base object)
save() {
  local v=""; [ -n "$3" ] && v=",'variants',$3"; [ -n "$4" ] && v="$v,'expected_stock',$4"
  local x="$2$v"; x="${x#,}"
  $P -c "select save_product(jsonb_build_object('id','$1','slug','qa-sc','name','QA','category_id','$CAT','price',500,'compare_at',0,'color','Black','color_hex','#000000','badge','','images',jsonb_build_array('uploads/a.webp'),'fit','f','material','m','description','d','best_seller',false,'new_arrival',false,'luxe',false,'status','active','stock_display','status') || jsonb_build_object($x), null)" 2>&1 | head -1; }
VAR='jsonb_build_array(jsonb_build_object($$size$$,$$S$$,$$stock$$,10),jsonb_build_object($$size$$,$$M$$,$$stock$$,3))'

echo "=== A. data that exists BEFORE 0008 (created with the 0007 function)"
L1=$(save "" ",'slug','legacy-msg','stock_message','Only 1 left'" "$VAR" "")
L2=$(save "" ",'slug','legacy-none'" "$VAR" "")
SUM0=$($P -c "select sum(stock) from product_variants"); MOV0=$($P -c "select count(*) from inventory_movements")
FNQ="select md5(string_agg(pg_get_functiondef(p.oid), '' order by p.proname, p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' and p.proname <> 'save_product'"
FN0=$($P -c "$FNQ")

echo "=== B. migration safety: a failing run must apply NOTHING (all-or-nothing)"
sed 's/^commit;/select 1\/0;\ncommit;/' supabase/migrations/0008_stock_message_modes.sql | $P >/dev/null 2>&1
RC=$?   # psql exits non-zero (3) when the script errors
t "failing 0008 run is rejected (non-zero exit)" "$([ $RC -ne 0 ] && echo rejected)" "rejected"
t "failing run leaves no new columns" "$($P -c "select count(*) from information_schema.columns where table_schema='public' and table_name='products' and column_name in ('stock_message_mode','stock_message_number','stock_message_review')")" "0"

echo "=== C. real apply: backfill preserves messages and inventory"
$P < supabase/migrations/0008_stock_message_modes.sql >/dev/null 2>&1 || echo "FAILED 0008"
t "message product becomes custom" "$($P -c "select stock_message_mode from products where id='$L1'")" "custom"
t "message product is flagged for review" "$($P -c "select stock_message_review from products where id='$L1'")" "t"
t "existing message text preserved" "$($P -c "select stock_message from products where id='$L1'")" "Only 1 left"
t "no custom number invented from old text" "$($P -c "select coalesce(stock_message_number::text,'null') from products where id='$L1'")" "null"
t "product without message stays none/unflagged" "$($P -c "select stock_message_mode||'/'||stock_message_review from products where id='$L2'")" "none/false"
t "real inventory unchanged by migration" "$($P -c "select sum(stock) from product_variants")" "$SUM0"
t "no inventory movement created by migration" "$($P -c "select count(*) from inventory_movements")" "$MOV0"
t "every other function (orders, payments, restock) unchanged" "$($P -c "$FNQ")" "$FN0"
t "save_product keeps service_role-only execute" "$($P -c "select string_agg(r, ',' order by r) from (select (aclexplode(proacl)).grantee::regrole::text r from pg_proc where proname='save_product') x where r not in ('postgres')")" "service_role"

echo "=== D. rerun safety"
$P < supabase/migrations/0008_stock_message_modes.sql >/dev/null 2>&1 || echo "FAILED rerun"
t "rerun keeps the review flag" "$($P -c "select stock_message_review from products where id='$L1'")" "t"
$P -c "update products set stock_message='kept', stock_message_mode='none' where id='$L2'" >/dev/null
$P < supabase/migrations/0008_stock_message_modes.sql >/dev/null 2>&1 || echo "FAILED rerun 2"
t "rerun does not re-flag or overwrite admin choices" "$($P -c "select stock_message_mode||'/'||stock_message_review from products where id='$L2'")" "none/false"
$P -c "alter table products drop constraint products_stock_message_number_mode_chk" >/dev/null
$P < supabase/migrations/0008_stock_message_modes.sql >/dev/null 2>&1 || echo "FAILED rerun 3"
t "rerun restores a missing constraint (partial-state robustness)" "$($P -c "select count(*) from pg_constraint where conname='products_stock_message_number_mode_chk'")" "1"

echo "=== E. save_product behaviour"
PID=$(save "" "" "$VAR" "")
stock() { $P -c "select stock from product_variants where product_id='$PID' and size='$1'"; }
moves() { $P -c "select count(*) from inventory_movements m join product_variants v on v.id=m.variant_id where v.product_id='$PID'"; }
pname() { $P -c "select name from products where id='$PID'"; }
M0=$(moves)
t "create requires variants" "$(save '' '' '' '' | grep -c variants_required)" "1"
# 1) metadata-only (NEW api): no variants key
save "$PID" ",'name','Renamed','stock_message_mode','custom','stock_message','Limited drop'" "" "" >/dev/null
t "metadata-only save applied" "$(pname)" "Renamed"
t "metadata-only keeps S stock" "$(stock S)" "10"
t "metadata-only keeps M stock" "$(stock M)" "3"
t "metadata-only writes no movements" "$(moves)" "$M0"
t "metadata-only keeps sizes active" "$($P -c "select count(*) from product_variants where product_id='$PID' and active")" "2"
# 2) an order lowers M from 3 to 2 after the editor loaded (snapshot S=10, M=3)
$P -c "update product_variants set stock = 2 where product_id='$PID' and size='M'" >/dev/null
EXP='jsonb_build_object($$S$$,10,$$M$$,3)'
save "$PID" "" 'jsonb_build_array(jsonb_build_object($$size$$,$$S$$,$$stock$$,12),jsonb_build_object($$size$$,$$M$$,$$stock$$,3))' "$EXP" >/dev/null
t "NEW payload with valid snapshot works: admin change to S applied" "$(stock S)" "12"
t "unchanged size keeps the order's change" "$(stock M)" "2"
OUT=$(save "$PID" ",'name','ShouldNotSave'" 'jsonb_build_array(jsonb_build_object($$size$$,$$S$$,$$stock$$,12),jsonb_build_object($$size$$,$$M$$,$$stock$$,9))' 'jsonb_build_object($$S$$,12,$$M$$,3)')
t "stock change on a moved size is rejected" "$(echo "$OUT" | grep -c stock_conflict)" "1"
t "conflict leaves M untouched" "$(stock M)" "2"
t "conflict rolls back metadata too (name not changed)" "$(pname)" "QA"
# 3) genuine adjustment still logs a movement
MB=$(moves); save "$PID" "" 'jsonb_build_array(jsonb_build_object($$size$$,$$S$$,$$stock$$,12),jsonb_build_object($$size$$,$$M$$,$$stock$$,6))' 'jsonb_build_object($$S$$,12,$$M$$,2)' >/dev/null
t "intentional adjustment applied" "$(stock M)" "6"
t "intentional adjustment logged exactly one movement" "$(( $(moves) - MB ))" "1"
t "logged movement has the right delta, balance and reason" "$($P -c "select m.delta||'/'||m.stock_after||'/'||m.reason from inventory_movements m join product_variants v on v.id=m.variant_id where v.product_id='$PID' and v.size='M' order by m.created_at desc, m.id desc limit 1")" "4/6/admin_adjustment"
# 4) size removal only when stock unchanged
OUT=$(save "$PID" "" 'jsonb_build_array(jsonb_build_object($$size$$,$$S$$,$$stock$$,12))' 'jsonb_build_object($$S$$,12,$$M$$,5)')
t "removing a moved size is rejected" "$(echo "$OUT" | grep -c stock_conflict)" "1"
# 5) custom number rules
save "$PID" ",'stock_message_mode','custom','stock_message_number',3,'stock_message','left'" "" "" >/dev/null
t "custom number saved" "$($P -c "select stock_message_number from products where id='$PID'")" "3"
t "custom number never touches stock" "$(stock M)" "6"
save "$PID" ",'stock_message_mode','real','stock_message','left'" "" "" >/dev/null
t "number cleared when switching to real" "$($P -c "select coalesce(stock_message_number::text,'null') from products where id='$PID'")" "null"
t "db rejects a number outside custom mode" "$($P -c "update products set stock_message_number = 5 where id='$PID'" 2>&1 | grep -c products_stock_message_number_mode_chk)" "1"
save "$PID" ",'stock_message_mode','custom','stock_message_number',4,'stock_message','left'" "" "" >/dev/null
save "$PID" ",'stock_message_mode','none'" "" "" >/dev/null
t "number cleared when switching to none" "$($P -c "select coalesce(stock_message_number::text,'null') from products where id='$PID'")" "null"
# 6) review flag: only when mode/message actually changes
$P -c "update products set stock_message_mode='custom', stock_message='Old text', stock_message_review=true, stock_message_number=null where id='$PID'" >/dev/null
save "$PID" ",'price',999,'stock_message_mode','custom','stock_message','Old text'" "" "" >/dev/null
t "unrelated edit keeps the review flag" "$($P -c "select stock_message_review from products where id='$PID'")" "t"
t "unrelated edit really applied (price)" "$($P -c "select price from products where id='$PID'")" "999.00"
save "$PID" ",'stock_message_mode','custom','stock_message','Limited drop'" "" "" >/dev/null
t "changing the message clears the review flag" "$($P -c "select stock_message_review from products where id='$PID'")" "f"

echo "=== F. STRICT guard: the OLD application payload (variants WITHOUT a stock snapshot) is rejected"
$P -c "update product_variants set stock = 0 where product_id='$PID' and size='M'" >/dev/null     # an order sells out M after the old admin page loaded
S1=$(stock S); MB=$(moves); N1=$(pname); PR1=$($P -c "select price from products where id='$PID'"); MSG1=$($P -c "select stock_message from products where id='$PID'"); MODE1=$($P -c "select stock_message_mode from products where id='$PID'")
OUT=$(save "$PID" ",'name','OldAppRename','price',1,'stock_message_mode','custom','stock_message','Hacked'" 'jsonb_build_array(jsonb_build_object($$size$$,$$S$$,$$stock$$,1),jsonb_build_object($$size$$,$$M$$,$$stock$$,5))' "")
t "old payload rejected with stock_snapshot_required" "$(echo "$OUT" | grep -c stock_snapshot_required)" "1"
t "old payload: M stock unchanged (order's 0 kept)" "$(stock M)" "0"
t "old payload: S stock unchanged" "$(stock S)" "$S1"
t "old payload: no product metadata partially saved (name)" "$(pname)" "$N1"
t "old payload: no product metadata partially saved (price)" "$($P -c "select price from products where id='$PID'")" "$PR1"
t "old payload: no message/mode partially saved" "$($P -c "select stock_message_mode||'/'||stock_message from products where id='$PID'")" "$MODE1/$MSG1"
t "old payload: no inventory movement inserted" "$(moves)" "$MB"
t "old application can still CREATE a product (nothing to overwrite)" "$(save '' ",'slug','old-created'" "$VAR" '' | grep -Ec '^[0-9a-f-]{36}$')" "1"
t "new payload still works after the rejection" "$(save "$PID" ",'name','Back'" '' '' | grep -Ec '^[0-9a-f-]{36}$')" "1"

echo "---- $pass passed, $fail failed"
[ "$fail" == 0 ]
