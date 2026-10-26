# ONE 2 1 EIGHT — Storefront + CMS prototype

A responsive, client-review prototype for a premium menswear ecommerce experience. Built with Next.js 15 App Router, React 19, TypeScript and Tailwind CSS v4, with custom CSS for a deliberately art-directed UI.

> **Prototype note:** This project is a front-end demo. Product/order/catalogue/CMS state is saved in this browser's `localStorage`; checkout creates a demo order only. OTP is simulated. No real payment, inventory, SMS, shipping, email or production database is connected. The seed catalogue and review data are illustrative. Replace it with approved content before production.

## Run locally

Requirements: Node.js 20.9+ (Node 22 recommended) and npm.

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

Build for deployment:

```bash
npm run build
npm start
```

## Demo CMS access

Open `http://localhost:3000/admin` directly. There is intentionally no CMS/admin button in the public storefront.

- Email: `admin@one2oneight.com`
- Password: `1218admin`

This is a client-side demo gate only. Production must use server-side authentication, role-based authorisation, secure sessions, CSRF protection and audited write APIs.

## Included storefront flows

- Responsive top announcement marquee and header; desktop navigation and a mobile bottom bar.
- Auto-advancing homepage campaign carousel (3 seconds), with independently editable desktop/mobile image URLs, campaign copy and collection destination.
- Eight editable shop-by-category tiles.
- Best sellers, new arrivals and the One 2 1 Eight Luxe edit.
- Collection pages with sort, query filter, colour, size and price filters.
- Product details with multi-image gallery, size selection, size guide, colour information, delivery-pincode check, descriptions/care/shipping accordions, rating summaries, customer review examples and related products.
- Wishlist and bag persisted across route changes and page refreshes.
- Functional quantity controls, `WELCOME10` / `LUXE15` demo coupons, shipping progress, address form and demo checkout.
- Simulated mobile OTP sign-in flow (any six digits after selecting Send OTP).
- Bulk/custom order lead form stored in the CMS.
- Loading transition, reduced-motion support, keyboard focus styles, responsive breakpoints and image fallback treatment.
- Dedicated returns policy and size-guide routes.

## Included CMS areas

- Dashboard with demo metrics and recent orders.
- Products: edit/create/delete, image URL, category, price, stock and featured collection flags.
- Categories & edits: change category title/image/visibility; manage product collection flags.
- Homepage & banners: edit the moving announcement, hero image URLs for desktop/mobile, headline, support copy, CTA and route destination.
- Orders: view demo orders and change status.
- Reviews: moderate sample reviews.
- Bulk enquiries: view form submissions, update status and reply by email.
- Store & SEO: brand details, returns copy, shipping threshold, title and meta description.

Changes are shared between storefront and CMS in the same browser. The `storage` event also syncs updates between tabs on the same origin.

## Important setup before client handoff / production

1. Approve and replace the seed brand identity, logo, product names, prices, sizes, descriptions, stock, photos, policies and reviews.
2. Replace the `.example` domain in `app/layout.tsx`, `app/[[...slug]]/page.tsx`, `app/robots.ts` and `app/sitemap.ts` with the actual production domain. Verify canonical URLs, sitemap and Search Console ownership.
3. Replace remotely hosted Unsplash placeholder images with owned/licensed final campaign and product images. The CMS currently stores image URLs; connect upload/storage with image transformations and real image focal points for production.
4. Move CMS/catalogue/orders/leads/reviews into a backend/database. Local storage is per-browser and is not secure, transactional or shared across customers.
5. Connect OTP/SMS provider, auth, payment gateway, tax/invoice logic, stock reservation, shipping provider, email notifications, cancellations/returns, analytics, consent management and observability.
6. Use approved policy wording, verify shipping thresholds and returns eligibility, and use only verified-purchase review labels when backed by order data.
7. Validate all final image crops on a real device matrix; replace placeholders with separate desktop/portrait mobile creatives where the crop needs to be intentional.
8. Complete accessibility and Core Web Vitals testing with real assets, especially LCP image priorities, image sizing/compression, font loading, contrast and screen reader behavior.

## Image behavior

The starter photos are remote Unsplash CDN URLs so that the prototype can be changed quickly in CMS. The source ratio is preserved in the URL, product gallery images use `object-fit: contain`, and editorial/category banners use responsive cover crops. If a remote image is unavailable, a neutral branded fallback appears. Production images should be stored on an owned or licensed CDN with explicit mobile and desktop variants.

## SEO / GEO / AI search foundations

- Descriptive titles and meta descriptions, canonical URL metadata and Open Graph/Twitter cards.
- `Organization`, `WebSite`, `SearchAction`, `Product` and `BreadcrumbList` JSON-LD scaffolding.
- `robots.ts` disallows the CMS path; `sitemap.ts` lists collection and seeded product routes.
- Semantic headings, meaningful image alt text, readable policy/product descriptions and category taxonomy.

The structured data and crawlable product pages need to be wired to the approved production catalogue/backend. Product structured data must reflect the actual price, availability, image rights and canonical URL. GEO/AI visibility cannot be guaranteed by metadata alone: publish accurate first-party product information, transparent policies, business/contact details and useful fit/care answers, then monitor search/referral performance.

## Reference review

The supplied Snitch desktop and mobile screenshots were used to inspect the layout and interaction hierarchy. `REFERENCE_AUDIT.md` records the visible patterns, the related behavior supported by indexed pages, and the design choices made for this prototype.


## Latest QA fixes

The updated package includes product-specific, locally bundled men's image galleries; a mobile-specific hero image; desktop left-rail gallery thumbnails; a working size-guide dialog; customer review submission connected to the CMS review queue; compact collection headings; single-location mobile wishlist/bag/account actions with Luxe visible; and a light CMS sidebar with a compact dashboard observation card. See [`QA_PATCH_NOTES.md`](./QA_PATCH_NOTES.md) for the complete list and verification status.

The prototype uses the `one218-prototype-v2` browser-storage key so previous demo data from older versions won't replace the corrected starter imagery. A successful dependency installation and `npm run build` are still required on a machine with package access before client sign-off.


### Latest visual update
The homepage hero is a full-bleed, clickable campaign image (click anywhere to open Shop All), with a restrained headline, slower zoom transition, and desktop/mobile-specific campaign crops. Product cards use consistent full-frame media; product photos have been cleaned of visible split-panel artifacts. Section reveals respect the reduced-motion preference. The latest storage namespace is `one218-prototype-v3`, intentionally separating corrected demo defaults from earlier browser data.
