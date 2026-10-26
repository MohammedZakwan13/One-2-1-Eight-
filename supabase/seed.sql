-- ONE 2 1 EIGHT — initial CMS content (NOT sample orders/customers/reviews).
-- Run AFTER 0001_init.sql. Safe to re-run: it only inserts what is missing and never overwrites your edits.
-- Everything here can be changed later in /admin (Store & SEO, Homepage & banners, Categories).

insert into public.store_settings (id, brand_name, brand_line, promo_text, announcement_enabled, free_shipping_threshold, shipping_fee,
  low_stock_threshold, return_policy, seo_title, seo_description, contact_email, contact_phone)
values (1, 'ONE 2 1 EIGHT', 'Wear your own standard.',
  'COMPLIMENTARY SHIPPING OVER ₹1,499   •   7-DAY EASY RETURNS',
  true, 1499, 79, 5,
  'Easy returns within 7 days of delivery. Items must be unworn, unwashed and in their original packaging. Final-sale products are excluded.',
  'ONE 2 1 EIGHT — Elevated everyday menswear',
  'Discover premium everyday menswear: T-shirts, drop shoulders, sweatshirts, hoodies, polos, track pants and joggers, designed with comfort and considered detail.',
  'care@example.com', '')
on conflict (id) do nothing;

insert into public.categories (slug, name, image, active, sort_order) values
  ('t-shirt',       'T-Shirt',       '/images/products/black-tee-front.webp',          true, 1),
  ('drop-shoulder', 'Drop Shoulder', '/images/products/ivory-tee-angle.webp',          true, 2),
  ('sweatshirt',    'Sweatshirt',    '/images/products/charcoal-sweatshirt-front.webp', true, 3),
  ('hoodie',        'Hoodie',        '/images/products/stone-hoodie-front.webp',        true, 4),
  ('polo',          'Polo',          '/images/products/olive-polo-front.webp',          true, 5),
  ('regular-fit',   'Regular Fit',   '/images/products/sage-tee-front.webp',            true, 6),
  ('track-pant',    'Track Pant',    '/images/products/black-trackpant-front.webp',     true, 7),
  ('joggers',       'Joggers',       '/images/products/sand-jogger-front.webp',         true, 8)
on conflict (slug) do nothing;

insert into public.hero_slides (kicker, title, body, desktop_image, mobile_image, cta, href, active, sort_order)
select * from (values
  ('THE NEW UNIFORM',    'ELEVATED ESSENTIALS',  'A better standard for everyday menswear.',        '/images/campaign/menswear-editorial-wide.webp', '/images/campaign/menswear-mobile.webp', '', '/collections/all',                 true, 1),
  ('THE LAYERING EDIT',  'MADE TO MOVE.',        'Considered layers. Effortless every day.',        '/images/campaign/hoodie-model-wide.webp',       '/images/campaign/hoodie-mobile.webp',   '', '/collections/layering-edit',        true, 2),
  ('ONE 2 1 EIGHT LUXE', 'QUIETLY EXCEPTIONAL.', 'Refined textures for your everyday rotation.',    '/images/campaign/polo-model-wide.webp',         '/images/campaign/polo-mobile.webp',     '', '/collections/one-2-1-eight-luxe',   true, 3)
) as v(kicker, title, body, desktop_image, mobile_image, cta, href, active, sort_order)
where not exists (select 1 from public.hero_slides);

-- Delivery: every pincode is serviceable, COD allowed, 3–7 days. Add longer prefixes (e.g. '9') to restrict areas.
insert into public.pincode_rules (prefix, serviceable, cod_available, min_days, max_days)
values ('', true, true, 3, 7)
on conflict (prefix) do nothing;
