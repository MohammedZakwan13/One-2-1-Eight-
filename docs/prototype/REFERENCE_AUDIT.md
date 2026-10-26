# Reference UX audit — Snitch menswear ecommerce

## Audit boundary

The available reference material is the user's desktop and responsive/mobile screenshots, plus publicly indexed Snitch homepage, collection and product-policy pages. The live homepage is client-rendered and the page inspection returned its loading shell, so this is **not** a claim of exhaustive browser instrumentation or source-level tracing of every animation. The audit distinguishes visible behavior from indexed information and proposed design improvements.

## What the screenshots and indexed pages show

### Homepage and top-level navigation

- Desktop uses a quiet white header, centered wordmark, hamburger/menu entry and utility icons for search, bag, wishlist and account.
- Hero campaigns dominate the first fold, use full-bleed editorial fashion photography and have concise typography over the image. Campaign art is intended to take shoppers straight into a curated range.
- The homepage has a shop-by-category area and a sequence of merchandising sections, including product styles/edit imagery and product tiles.
- A floating Stores affordance appears in the supplied desktop examples. The responsive screenshots show a much narrower single-column reading surface and a persistent bottom-navigation pattern.
- The indexed homepage highlights campaign edits including Festive Edit, The Puffer Edit, Outerwear, Baggy Jeans, Statement Shirts and Perfumes, alongside core product discovery. [Reference: Snitch homepage](https://www.snitch.com/)

### Search and collection listing

- The screenshot of search shows a dominant search field, trending/top searches as image tiles, category chips and product results below.
- The new-arrivals screenshot shows a multi-column catalogue grid, top-level sort/filter controls and a mobile sort sheet. It suggests sorting/filtering is presented as a space-efficient overlay on narrow screens rather than a desktop-style rail.
- Publicly indexed product-discovery descriptions list filters such as size, colour, pattern, fit, material, collar and sleeves, and sort options including popularity, newness and price. [Reference: collection page](https://www.snitch.com/men-new/304845553826); [third-party UX audit](https://suplex.design/audit/snitch)

### Product detail page

- The supplied desktop screenshots show a broad image gallery on the left and a product information column on the right. The information column includes name/price/rating, offer cards, colour selection, size buttons and size guide, a strong Add button, a pincode delivery check and collapsible description/fit information.
- More than one garment view is present; the full-page screenshot also shows review/policy content and a floating style assistant widget.
- The indexed policy text states return/exchange eligibility varies by customer/order and product/promotion. This is a strong reason to show policy eligibility clearly in the product and checkout flows rather than implying all items have identical rules. [Reference: indexed product policy](https://www.snitch.com/men-shirts/slim-fit-black-shirt-4mss4575-06/9319059292322/buy)

### Login, bag and responsive states

- Login uses a split view: fashion imagery on one side and a compact mobile-number/OTP panel on the other, with legal consent text below the main action.
- The empty-bag screenshot uses whitespace, a compact illustration and two clear next actions (start shopping / add from wishlist).
- The mobile screenshots reveal why image focal points and page-specific responsive behavior matter: the campaign art needs a dedicated portrait crop; catalogue sorting/filtering should use a sheet/panel; product detail needs a focused image-first sequence with sizes and buy action easy to reach.

## Opportunities to improve on the reference

1. **Keep the campaign bold, improve its resilience.** Separate mobile and desktop imagery, retain the complete subject in product photography, use a controlled dark overlay behind text, and make every slide CTA and image destination editable in CMS.
2. **Clarify the brand story.** Use an editorial intro and product narrative, not only a stack of collection tiles. Keep this to one high-impact story section so merchandising still wins.
3. **Make product confidence easy.** Keep size guidance and delivery checks close to selection, show a concise fit/material summary, surface review distribution and review cards instead of hiding all feedback, and keep a mobile sticky Add action above the bottom navigation.
4. **Respect mobile screen space.** Provide category chips, a compact sort control and an explicit filter panel. Keep the header and sticky actions from covering the bottom of the content. Preserve the product image's source aspect ratio and use `contain` in product media.
5. **Treat admin as an operations product.** Keep it off public navigation and give it explicit controls for homepage slides, offers, product flags, categories, image URLs, stock, orders, reviews, leads and metadata. Save and preview behavior should be obvious.
6. **Make promises precise.** Policies and review claims should be business-approved and sourced. The prototype's policies, review counts, availability, address and order data are examples only.

## Prototype design response

- A calm paper/ink palette with warm metallic accents, distinctive display typography and restrained borders; art direction is different from Snitch rather than a pixel clone.
- A 3-second autoplay hero carousel, editable campaign links, top moving offer marquee, eight requested categories, best sellers, new arrivals and a dedicated Luxe edit.
- Category and product grids, working search/filter/sort, local wishlist/bag, coupons, address and demo payment selection, product image navigation, size guide, review cards, policy pages and bulk/custom lead capture.
- A separate authenticated-by-demo-gate CMS with direct-edit product fields and immediate browser-state syncing. The CMS is not linked from public storefront navigation.
- SEO scaffolding for metadata, Open Graph, Organization/WebSite/SearchAction/Product/Breadcrumb JSON-LD, robots and sitemap routes. The placeholder domain must be replaced and all schema data must be connected to the real source of truth before production.

## Validation still required before production

- Browser QA at 320, 360, 390, 430, 768, 1024, 1280, 1440 and wide desktop; landscape mobile; long product names; keyboard-only, focus trap and screen-reader flows.
- Replace remote placeholder images with approved owned/licensed assets and verify all image focal points at exact target breakpoints.
- Test backend persistence, concurrency, auth, roles, API failures and empty/error/loading states; do not treat browser localStorage as a CMS backend.
- Run Lighthouse/Core Web Vitals, accessibility checks and production crawl/structured-data validation after the final domain and real data are in place.
