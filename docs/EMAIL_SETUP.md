# Customer email: Resend setup, retry and operations

All transactional email (order confirmations, status and shipping updates, return updates, enquiry acknowledgements and the internal enquiry notice) is sent through
**Resend** only. There is no other external provider and no fallback: the visible sender never changes silently.

- Planned sender: **ONE 2 1 EIGHT <orders@send.one21eight.com>** (works only after the domain is verified in Resend, section 2).
- Reply-To: **one21eight@gmail.com** (customers who reply reach this inbox).
- Until `RESEND_API_KEY` and `EMAIL_FROM` are set in production, **transactional email is not enabled**: orders and enquiries still save, and the emails are kept in `email_log`
  as `skipped_unconfigured`.

## 1. How it behaves

| Situation | What happens |
|---|---|
| Order placed / paid / status changed | The email is attempted right away. A failure never affects the order or status change. |
| Resend briefly unavailable (5xx, network error, timeout) | Row stays in `email_log` as `failed`; retried after 5, 15, 45, 120, 360 minutes (max 6 attempts, max 24 h). Every attempt sends the same `Idempotency-Key` (the notification's unique key), so a retry after an unclear outcome cannot produce a second email. |
| Rate limit (429) | Retried later, like any other temporary failure. |
| API key rejected or sender not allowed (401/403) | Notifications are kept; retried every 15 minutes (no attempts used) until the configuration is fixed. An alert is written to the server log and `email_log` once per day. It is also emailed to `INTERNAL_NOTIFICATION_EMAIL`, which cannot work if Resend itself rejects the key, so rely on the log and the `tripped` field of the cron response. |
| Credentials missing | Row is `skipped_unconfigured`; sent automatically once Resend is configured, if the order is less than 24 hours old. |
| Resend rejects the request itself (bad address, invalid sender) | `failed`, never retried. |
| Application crash after the order was saved but before the email attempt | The retry job rebuilds the missing emails from the order data and sends them once. It recovers only the order confirmation and the **latest** status notification of each order (never an older Processing or Packed once the order is Delivered), and the 24-hour limit is counted from the original event, not from recovery. |
| A queued status email is overtaken by a later status (e.g. a retried "packed" after "delivered") | It is dropped, not sent. |
| Notifications recorded before this system existed (e.g. the old `skipped_unconfigured` rows) | Never replayed. Only rows scheduled by the new system are retried, and only events from the last 24 hours are recovered. |
| A retry run that is taking long | It stops claiming new notifications after about 22 s (40 s budget) and never interrupts a send already in progress; the rest waits for the next run. |
| Application crash in the middle of a send | After 10 minutes the claim is marked `uncertain` (not resent). Check Resend's dashboard (Emails) for that notification before sending it by hand. |
| Late payment on an already-cancelled order | No "order received" email. The money is flagged for manual refund (`[payment] captured after cancel` in the server log). |

Duplicates are prevented by a unique key per notification, an atomic claim in the database (`claim_email_log`) and Resend's idempotency key, so overlapping
workers or a retried webhook cannot send the same email twice.

Delivery is never guaranteed: `accepted` means Resend took the message. If you configure the webhook (below), Resend later reports `delivered`, `bounced`, `complained` or `failed`,
and `email_log` is updated.

## 2. Resend setup (you do this in the Resend dashboard)

1. Create or open your Resend account. **Domains → Add Domain** and enter `send.one21eight.com` (a sending subdomain, so the main domain's mail is untouched). Choose the
   region carefully: it cannot be changed afterwards.
2. Resend shows the DNS records to create. **Copy them exactly from the dashboard; they are generated for your domain and are not listed here.** Expect, in general, DKIM and SPF
   TXT records and an MX record for bounce handling on the sending subdomain, plus an optional DMARC record.
3. Add them where `one21eight.com` DNS is managed (its nameservers are Cloudflare, so Cloudflare → DNS → Records). Set every record to **DNS only** (grey cloud), never proxied.
   `_dmarc.one21eight.com` already exists with relaxed alignment, which covers a `send.` subdomain, so a second DMARC record is not needed.
4. Click **Verify** in Resend and wait until the domain shows **Verified**. Do not send before then: Resend rejects sender addresses on an unverified domain (HTTP 403, treated as a configuration error here).
5. **API Keys → Create API Key** with the *Sending access* permission restricted to this domain. Copy it once into the server configuration (section 4). Never paste it into chat, Git or a ticket.
6. **Webhooks → Add Endpoint:** URL `https://one21eight.com/api/webhooks/resend`, events `email.delivered`, `email.bounced`, `email.complained`, `email.failed`. Copy the signing secret
   (starts with `whsec_`) into `RESEND_WEBHOOK_SECRET`. Without it the endpoint answers 503 and delivery tracking is off.

## 3. Environment variable names (values go ONLY in the server's private configuration)

| Name | Value / purpose |
|---|---|
| `EMAIL_PROVIDER` | `resend` |
| `RESEND_API_KEY` | The Resend API key. Must be set together with `EMAIL_FROM` (setting only one stops the application at start-up). |
| `EMAIL_FROM` | `ONE 2 1 EIGHT <orders@send.one21eight.com>` (an address on the verified domain). |
| `EMAIL_REPLY_TO` | `one21eight@gmail.com` |
| `INTERNAL_NOTIFICATION_EMAIL` | `one21eight@gmail.com`. Receives the internal copy of each new enquiry and the daily alert. If unset, no internal enquiry email is sent. |
| `RESEND_WEBHOOK_SECRET` | Signing secret of the Resend webhook (delivery tracking). |
| `EMAIL_RETRY_SECRET` | Min 24 characters. Protects `POST /api/internal/email-retry` (section 5). |

The old `GMAIL_*` variables no longer exist. `EMAIL_PROVIDER=mailpit` is for local testing only and is refused in production.

Admin → Settings → **contact email** should be `one21eight@gmail.com`: the order page's "Contact us about this order" button uses it.

## 4. Hostinger VPS: configure without exposing secrets

1. SSH in. Edit the **untracked** environment file your containers load (the same one that already holds `SUPABASE_*` and `RAZORPAY_*`; confirm the
   path with `docker compose config | grep -i env_file`). Never put these values in Git, in GitHub Actions secrets or in the compose file.
2. Make sure only the deploy user can read it: `chmod 600 <that file>`; `ls -l` should show your user as owner and no group/other access.
3. Create the retry secret with the command in section 5, step A. It generates the secret on the server and writes it straight into the env file and the cron header file,
   so it is never typed, printed, passed as an argument or kept in shell history. (The env file is `.env.production` for `docker-compose.prod.yml`; confirm the path first.)
4. Recreate the container so it reads the new values: `docker compose up -d --force-recreate web` (a plain restart can keep the old environment).
5. The application never logs credentials, tokens or request bodies, only short codes such as `invalid_grant`. Do not run it with debug logging that dumps the environment.

## 5. Cron job (every 5 minutes)

The cron job calls `POST /api/internal/email-retry` on the VPS itself (`docker-compose.prod.yml` publishes the app only on `127.0.0.1:3000`), authenticated by a shared secret.
**The secret must never appear in a command line, shell history, a process listing, a URL or a log.** So it lives only in two root-only places: the container's env file
(`EMAIL_RETRY_SECRET`) and a header file that `curl` reads with `-H @file` (curl 7.55 or newer; check with `curl --version`). `flock` (util-linux) is preinstalled on Ubuntu and Debian.

**Step A. Create the secret and the header file in one step (nothing is shown, typed or left in history).** Adjust the env-file path if yours differs:

```
sudo bash -c 'umask 077; s=$(openssl rand -hex 32); printf "x-email-retry-secret: %s\n" "$s" > /etc/one2oneight-email-retry.header; printf "\nEMAIL_RETRY_SECRET=%s\n" "$s" >> /var/www/one2oneight/.env.production'
```

Only the command text is recorded in history; the secret is generated and consumed inside that one shell, using builtins (`printf`), so it is never an argument of any process.
If you would rather choose the value yourself, use the interactive prompt (input is hidden and not recorded):

```
sudo bash -c 'umask 077; read -r -s -p "Paste EMAIL_RETRY_SECRET: " s; echo; printf "x-email-retry-secret: %s\n" "$s" > /etc/one2oneight-email-retry.header'
```

and put the same value in the env file with an editor (`sudoedit`), never with `echo`.

**Step B. Restrict permissions to root and check them** (no secret is printed):

```
sudo chown root:root /etc/one2oneight-email-retry.header && sudo chmod 600 /etc/one2oneight-email-retry.header
sudo ls -l /etc/one2oneight-email-retry.header           # expect: -rw------- 1 root root
sudo grep -c '^EMAIL_RETRY_SECRET=' /var/www/one2oneight/.env.production   # expect: 1 (the count, not the value)
sudo install -m 640 -o root -g root /dev/null /var/log/one2oneight-email-retry.log
```

Recreate the container so it reads the new value: `docker compose -f docker-compose.prod.yml up -d --force-recreate web`.

**Step C. Check the route is protected, without triggering a run.** A request with no secret must be refused:

```
curl -sS -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:3000/api/internal/email-retry     # expect 401
```

`503` here means `EMAIL_RETRY_SECRET` did not reach the container (re-check step B and the recreate). The first call that *includes* the secret performs a real run,
so make it only after the read-only preview in section 7.

**Step D. Add the cron entry** (`sudo crontab -e`, root's crontab, one line):

```
*/5 * * * * /usr/bin/flock -n /run/lock/one2oneight-email-retry.lock /usr/bin/curl -fsS --max-time 90 -X POST -H @/etc/one2oneight-email-retry.header http://127.0.0.1:3000/api/internal/email-retry >> /var/log/one2oneight-email-retry.log 2>&1
```

- `flock -n` skips a run when the previous one is still going, so invocations never overlap (it exits quietly with status 1 in that case). Even without it, overlapping runs could not
  double-send, because every notification is claimed atomically in the database.
- Each run stops claiming new notifications after roughly 22 seconds (a 40-second budget minus the worst case for one more send) and never interrupts a send already in progress.
  `--max-time 90` leaves a comfortable margin. If curl ever gave up early, the server still finishes the send it is doing, and a claim whose worker died becomes `uncertain` after
  10 minutes (never resent).
- `-H @file`: curl reads the header from the file, so the process list shows only `@/etc/one2oneight-email-retry.header`, never the secret. The URL carries no secret.
- The log holds only the response, which is operational counts (`swept`, `reconciled`, `considered`, `accepted`, `failed`, `uncertain`, `tripped`, `stoppedForBudget`, ...). Never run the
  command with `set -x`, `curl -v` or a wrapper that prints headers. Do not call the endpoint through the public domain.
- A 503 `migration_required` response means migration `0009_email_log_attempts.sql` has not been applied yet.
- Recommended: also block `/api/internal/` for public traffic in your reverse proxy / Cloudflare. The cron job uses `127.0.0.1`, so nothing legitimate needs it from outside.

## 6. Monitoring (read-only queries for the Supabase SQL editor)

```sql
-- status overview for the last 24 hours
select status, count(*) from email_log where created_at > now() - interval '24 hours' and kind <> 'system_alert' group by 1 order by 2 desc;
-- anything waiting for a retry, or needing a human
select kind, status, attempts, next_attempt_at, error, created_at from email_log
where status in ('failed','skipped_unconfigured','uncertain') and created_at > now() - interval '48 hours' order by created_at desc;
```

`uncertain` rows (rare: a crash in the middle of a send): look the message up in the Resend dashboard (Emails) by recipient and subject. If the customer was not emailed, resend it by hand.

## 7. Roll-out checklist

1. Apply `supabase/migrations/0009_email_log_attempts.sql` (additive, idempotent). Do this **before** deploying the code that uses it.
2. Complete the Resend setup (section 2), add the environment values (sections 3 and 4) and recreate the container.
3. Place a test COD order with your own address and confirm the email arrives from orders@send.one21eight.com (the message headers should show SPF and DKIM `pass`), that replying goes to one21eight@gmail.com, and that it carries the order number and the signed order link.
4. Mark that order Processing → Packed → Shipped (courier, tracking number and an https tracking link) → Delivered and check each email.
5. **Before activating cron, preview what the first run would recover** (read-only; it mirrors the recovery rule: the order confirmation plus only the LATEST status of each order, last 24 hours, never system cancellations). Expect no rows, or only rows you recognise:

   ```sql
   with ev as (
     select h.order_id, h.to_status, h.actor_type, h.created_at,
            case when h.to_status = 'confirmed' then 'order:' || h.order_id || ':confirmation' else 'order:' || h.order_id || ':' || h.to_status end as key,
            row_number() over (partition by h.order_id, (h.to_status = 'confirmed') order by h.created_at desc) as rn
     from order_status_history h
     where h.created_at > now() - interval '24 hours' and h.created_at < now() - interval '2 minutes'
       and h.to_status in ('confirmed','processing','packed','shipped','delivered','cancelled','refunded')
       and not (h.to_status = 'cancelled' and h.actor_type = 'system')
   )
   select ev.order_id, ev.to_status, ev.actor_type, ev.created_at
   from ev left join email_log e on e.dedupe_key = ev.key
   where ev.rn = 1 and e.id is null;

   -- notifications that never got a first attempt (they would be sent after two minutes)
   select kind, status, attempts, created_at from email_log where status = 'queued' and created_at > now() - interval '24 hours';
   ```

   Rows recorded earlier as `skipped_unconfigured` (email was not configured then) are **not** replayed: they have no retry time, so neither the recovery nor the retry ever touches them.
6. Add the cron job (section 5) and confirm the log shows `200` responses.
7. Optional failure drill on a staging copy: use a wrong `RESEND_API_KEY`, place an order, confirm the order succeeds, the email stays queued and the alert line appears in the log; restore the key and confirm the queued email is delivered.
