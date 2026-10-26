# ONE 2 1 EIGHT — prototype QA patch

## Fixes included

- Replaced external/mismatched seed catalogue photography with locally bundled, men's-only product image sets. Each seeded product now has its own four-view gallery (front, back, angle, detail) for consistent PDP views; category tiles and hero assets use matching men's fashion imagery.
- Composed separate wide and portrait campaign images so the desktop hero and mobile hero use purpose-fit imagery. Hero imagery contains no external brand marks or baked-in text.
- Moved desktop product-page thumbnails into a vertical rail to the left of the main gallery. The existing small-screen gallery layout remains the original stacked/mobile interaction.
- Fixed the empty image `src` warning by rendering a fallback when a source is missing.
- Moved the size guide into a `document.body` portal, added dialog semantics, Escape-to-close, backdrop close and body-scroll locking.
- Replaced the hardcoded PDP review cards with a premium review form. Customers can enter a name, rating, title and text; submissions appear immediately, update the rating summary, persist in the prototype store, and show in the CMS moderation list.
- Reduced non-Luxe collection masthead/filter vertical space so products appear higher on the page.
- De-duplicated mobile wishlist/bag/account shortcuts by keeping those actions in the mobile bottom navigation, while restoring the Luxe shortcut in the mobile header.
- Changed the CMS sidebar from dark charcoal to a warm, light neutral theme and removed the dashboard observation card's forced multi-row height.
- Bumped the prototype local-storage key to `one218-prototype-v2` so old persisted demo content does not override the corrected seed imagery and colours.

## Verification status

- TypeScript/TSX syntax transpilation: passed for the edited application files.
- Local image path audit: passed; all referenced `/images/...` files exist.
- External Unsplash seed references: removed from the seeded catalogue, hero, and default login/new-product imagery.
- ZIP integrity: checked after packaging.
- A full Next.js build and real browser/responsive screenshot test were not completed in this environment because `npm install` timed out. Run `npm install` followed by `npm run build` locally before client sign-off.

## Prototype vs production

Review submissions and CMS state are persisted in browser local storage. This makes the client demo interactive, but it is not a secure, multi-user backend. Replace demo review/order data with the production database and moderation/authentication services before launch. The current size table is illustrative and must be replaced with approved measurements for each garment.


## Hero / imagery / motion follow-up (23 Oct 2026)

- Replaced framed/blurred campaign compositions with three true full-bleed panoramic campaign images and matching portrait mobile crops. No women are included in the campaign assets.
- Removed hero CTA, arrows, dots and caption overlays. The complete campaign image is keyboard accessible and links directly to Shop All. The copy is reduced to a concise headline plus one support line.
- Slowed the timed carousel to 5.4 seconds and added a soft Ken Burns pan/zoom, with reduced-motion safeguards.
- Added Intersection Observer-based scroll reveals for home sections and collection/product content, respecting reduced-motion settings.
- Trimmed the visible next-panel gutter from product images and made product-card media use one consistent 3:4 crop that fills the same frame across the grid.
- Rebalanced the CMS category manager so the editor panel stretches to match its category list; Luxe title spacing has been relaxed for legibility.
- Changed the demo storage namespace to v3 so old saved hero imagery/copy does not override the corrected campaign defaults.
