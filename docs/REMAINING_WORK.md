# Remaining work

Status of the former blockers after the Supabase backend (see docs/IMPLEMENTATION_AND_QA.md for evidence).

## Done in this repository
Backend + database, admin authentication (Supabase Auth + allow-list + roles), image upload to Storage, per-size inventory with
atomic order placement, order lifecycle + tracking, leads, reviews moderation, settings/pages CMS, Swagger/OpenAPI, Docker.

## Needs your accounts / decisions (nothing is faked in the meantime)
| Item | Status without it | Steps |
| --- | --- | --- |
| Supabase keys + schema applied | App cannot start | docs/SETUP.md §1 |
| Resend (domain, API key, webhook) | Orders/leads save; emails logged `skipped_unconfigured` | docs/SETUP.md §3 |
| Razorpay keys + webhook | Only Cash on delivery offered | docs/SETUP.md §3 |
| MSG91 / DLT-registered SMS | No customer sign-in, so nobody can check out (checkout, wishlist, reviews and account all need sign-in) | docs/SETUP.md §3 |
| Legal pages, seller/GSTIN details | Terms/privacy links hidden until published | Admin → Store & SEO |
| Real catalogue and approved size charts | Empty store; size-guide table is the prototype's illustrative one | Admin → Products |
| Courier integration (AWB, live tracking) | Admin enters carrier + tracking number by hand | later |
| Refunds | Admin can mark an order `refunded` (records only); money is returned in the Razorpay dashboard | later |

## Known limitations
* Abandoned online checkout: the cart is emptied when the order is created; unpaid orders release their stock after 60 min (needs pg_cron) and the shopper re-adds items.
* No admin screens yet for coupons, delivery rules (pincode prefixes), customers, or inbound-email leads (inbound e-mail is not implemented; leads come from the website form).
* Order e-mails for `packed` are not sent (processing/shipped/delivered/cancelled/refunded are).
* MFA for admins is not enabled (Supabase Auth MFA can be added).
* Splash screen delay, accessibility follow-ups and Next 16 upgrade notes from the original frontend review still apply.
