/**
 * Development / test seed data ONLY. Imported exclusively by the mock API (mocks/*).
 * Never import this from application code – production data comes from the backend.
 */
// Seeded imagery is kept locally in /public/images so galleries stay consistent and load deterministically.
export const SEED_PRODUCTS = [
  {
    id: 'p1', slug: 'essential-box-fit-tee-black', name: 'Essential Box Fit T-Shirt', category: 'T-Shirt', price: 899, compareAt: 1199,
    color: 'Washed Black', colorHex: '#252525', sizes: ['S','M','L','XL','XXL'], rating: 4.8, reviewCount: 126, badge: 'BESTSELLER',
    images: ['/images/products/black-tee-front.webp', '/images/products/black-tee-back.webp', '/images/products/black-tee-angle.webp', '/images/products/black-tee-detail.webp'],
    fit: 'Relaxed / Box fit', material: '100% Cotton · 240 GSM', description: 'A heavyweight everyday essential with a structured shoulder, premium hand-feel and a silhouette made to fall just right. Cut from breathable cotton jersey and garment-washed for a soft, lived-in finish.', stock: 42, bestSeller: true, newArrival: false, luxe: false,
  },
  {
    id: 'p2', slug: 'studio-drop-shoulder-tee-ivory', name: 'Studio Drop Shoulder Tee', category: 'Drop Shoulder', price: 1099, compareAt: 1399,
    color: 'Ivory', colorHex: '#eae5db', sizes: ['S','M','L','XL','XXL'], rating: 4.7, reviewCount: 84, badge: 'JUST IN',
    images: ['/images/products/ivory-tee-front.webp', '/images/products/ivory-tee-back.webp', '/images/products/ivory-tee-angle.webp', '/images/products/ivory-tee-detail.webp'],
    fit: 'Oversized / Drop shoulder', material: '100% Combed Cotton · 260 GSM', description: 'Volume where it matters, softness where it counts. Designed with an easy drape and a clean neckline for a considered off-duty uniform.', stock: 35, bestSeller: true, newArrival: true, luxe: false,
  },
  {
    id: 'p3', slug: 'elevated-polo-knit-olive', name: 'Elevated Knit Polo', category: 'Polo', price: 1499, compareAt: 1899,
    color: 'Olive', colorHex: '#666a49', sizes: ['S','M','L','XL'], rating: 4.9, reviewCount: 67, badge: 'LIMITED EDITION',
    images: ['/images/products/olive-polo-front.webp', '/images/products/olive-polo-back.webp', '/images/products/olive-polo-angle.webp', '/images/products/olive-polo-detail.webp'],
    fit: 'Regular fit', material: 'Cotton-rich textured knit', description: 'A modern classic, refined through texture. Wear it buttoned up with tailored trousers or open over your favourite tee.', stock: 18, bestSeller: true, newArrival: false, luxe: true,
  },
  {
    id: 'p4', slug: 'weekend-fleece-hoodie-stone', name: 'Weekend Fleece Hoodie', category: 'Hoodie', price: 1799, compareAt: 2299,
    color: 'Stone Grey', colorHex: '#aaa9a3', sizes: ['S','M','L','XL','XXL'], rating: 4.6, reviewCount: 53, badge: 'CORE',
    images: ['/images/products/stone-hoodie-front.webp', '/images/products/stone-hoodie-back.webp', '/images/products/stone-hoodie-angle.webp', '/images/products/stone-hoodie-detail.webp'],
    fit: 'Relaxed fit', material: 'Brushed cotton fleece · 360 GSM', description: 'A substantial fleece layer with a clean shape, soft brushed interior and understated finishing. Built for cool mornings and long weekends.', stock: 23, bestSeller: false, newArrival: true, luxe: false,
  },
  {
    id: 'p5', slug: 'afterhours-premium-sweatshirt-charcoal', name: 'Afterhours Premium Sweatshirt', category: 'Sweatshirt', price: 1599, compareAt: 1999,
    color: 'Charcoal', colorHex: '#424242', sizes: ['S','M','L','XL'], rating: 4.8, reviewCount: 41, badge: 'NEW DROP',
    images: ['/images/products/charcoal-sweatshirt-front.webp', '/images/products/charcoal-sweatshirt-back.webp', '/images/products/charcoal-sweatshirt-angle.webp', '/images/products/charcoal-sweatshirt-detail.webp'],
    fit: 'Regular fit', material: 'Cotton blend · 320 GSM', description: 'A refined layer with a soft structured hand-feel, ribbed trims and an elevated, pared-back finish.', stock: 29, bestSeller: false, newArrival: true, luxe: true,
  },
  {
    id: 'p6', slug: 'everyday-regular-fit-tee-sage', name: 'Everyday Regular Fit Tee', category: 'Regular Fit', price: 699, compareAt: 899,
    color: 'Sage', colorHex: '#8e9a79', sizes: ['S','M','L','XL','XXL'], rating: 4.5, reviewCount: 98, badge: 'EVERYDAY ICON',
    images: ['/images/products/sage-tee-front.webp', '/images/products/sage-tee-back.webp', '/images/products/sage-tee-angle.webp', '/images/products/sage-tee-detail.webp'],
    fit: 'Regular fit', material: '100% Cotton · 220 GSM', description: 'Your repeat-wear essential: comfortable, dependable and intentionally minimal. Made to work with every layer in your wardrobe.', stock: 57, bestSeller: true, newArrival: false, luxe: false,
  },
  {
    id: 'p7', slug: 'motion-tapered-track-pant-black', name: 'Motion Tapered Track Pant', category: 'Track Pant', price: 1299, compareAt: 1699,
    color: 'Black', colorHex: '#171717', sizes: ['S','M','L','XL','XXL'], rating: 4.6, reviewCount: 77,
    images: ['/images/products/black-trackpant-front.webp', '/images/products/black-trackpant-back.webp', '/images/products/black-trackpant-angle.webp', '/images/products/black-trackpant-detail.webp'],
    fit: 'Tapered fit', material: 'Cotton-rich stretch interlock', description: 'A clean technical track pant with an easy waistband, considered taper and enough stretch for daily movement.', stock: 30, bestSeller: true, newArrival: false, luxe: false,
  },
  {
    id: 'p8', slug: 'off-duty-jogger-pant-sand', name: 'Off-Duty Jogger Pant', category: 'Joggers', price: 1199, compareAt: 1499,
    color: 'Sand', colorHex: '#c9b99c', sizes: ['S','M','L','XL','XXL'], rating: 4.7, reviewCount: 62, badge: 'TRENDING',
    images: ['/images/products/sand-jogger-front.webp', '/images/products/sand-jogger-back.webp', '/images/products/sand-jogger-angle.webp', '/images/products/sand-jogger-detail.webp'],
    fit: 'Relaxed tapered', material: 'Cotton blend · Soft-touch finish', description: 'Easy-on, easy-off comfort with a tapered finish that still looks put together. The everyday trouser alternative.', stock: 26, bestSeller: false, newArrival: true, luxe: false,
  },
  {
    id: 'p9', slug: 'luxe-merino-polo-midnight', name: 'Luxe Merino Blend Polo', category: 'Polo', price: 2499, compareAt: 2999,
    color: 'Midnight', colorHex: '#202d37', sizes: ['S','M','L','XL'], rating: 4.9, reviewCount: 29, badge: 'LUXE EXCLUSIVE',
    images: ['/images/products/navy-polo-front.webp', '/images/products/navy-polo-back.webp', '/images/products/navy-polo-angle.webp', '/images/products/navy-polo-detail.webp'],
    fit: 'Tailored regular fit', material: 'Merino blend · Fine-gauge knit', description: 'The quiet luxury piece. Fine-gauge texture, a refined collar and a fluid silhouette designed for after-hours dressing.', stock: 11, bestSeller: false, newArrival: false, luxe: true,
  },
  {
    id: 'p10', slug: 'terrain-relaxed-cargo-jogger-olive', name: 'Terrain Relaxed Cargo Jogger', category: 'Joggers', price: 1699, compareAt: 1999,
    color: 'Field Olive', colorHex: '#777552', sizes: ['S','M','L','XL','XXL'], rating: 4.5, reviewCount: 34,
    images: ['/images/products/olive-cargo-front.webp', '/images/products/olive-cargo-back.webp', '/images/products/olive-cargo-angle.webp', '/images/products/olive-cargo-detail.webp'],
    fit: 'Relaxed fit', material: 'Cotton twill stretch', description: 'Utility influence, everyday ease. Refined cargo pockets and a relaxed profile create a functional statement.', stock: 17, bestSeller: true, newArrival: true, luxe: false,
  },
  {
    id: 'p11', slug: 'signature-longline-tee-white', name: 'Signature Longline Tee', category: 'T-Shirt', price: 799, compareAt: 999,
    color: 'Optic White', colorHex: '#f4f1e8', sizes: ['S','M','L','XL','XXL'], rating: 4.6, reviewCount: 88,
    images: ['/images/products/longline-white-front.webp', '/images/products/longline-white-back.webp', '/images/products/longline-white-angle.webp', '/images/products/longline-white-detail.webp'],
    fit: 'Longline regular fit', material: '100% Cotton · 230 GSM', description: 'A clean longline profile that gives a simple tee a more deliberate proportion. Made for repeat styling.', stock: 39, bestSeller: false, newArrival: true, luxe: false,
  },
  {
    id: 'p12', slug: 'atelier-textured-sweatshirt-ecru', name: 'Atelier Textured Sweatshirt', category: 'Sweatshirt', price: 2299, compareAt: 2799,
    color: 'Ecru', colorHex: '#e6ddcc', sizes: ['S','M','L','XL'], rating: 4.9, reviewCount: 21, badge: 'LUXE EXCLUSIVE',
    images: ['/images/products/ecru-sweatshirt-front.webp', '/images/products/ecru-sweatshirt-back.webp', '/images/products/ecru-sweatshirt-angle.webp', '/images/products/ecru-sweatshirt-detail.webp'],
    fit: 'Relaxed premium fit', material: 'Cotton loopback · 340 GSM', description: 'A tactile premium layer with a subtle surface texture, refined construction and a softly sculpted silhouette.', stock: 9, bestSeller: false, newArrival: true, luxe: true,
  },
];

export const SEED_HERO = [
  {
    id: 'hero-1', kicker: 'THE NEW UNIFORM', title: 'ELEVATED ESSENTIALS', body: 'A better standard for everyday menswear.', desktopImage: '/images/campaign/menswear-editorial-wide.webp', mobileImage: '/images/campaign/menswear-mobile.webp', cta: '', href: '/collections/all', active: true,
  },
  {
    id: 'hero-2', kicker: 'THE LAYERING EDIT', title: 'MADE TO MOVE.', body: 'Considered layers. Effortless every day.', desktopImage: '/images/campaign/hoodie-model-wide.webp', mobileImage: '/images/campaign/hoodie-mobile.webp', cta: '', href: '/collections/all', active: true,
  },
  {
    id: 'hero-3', kicker: 'ONE 2 1 EIGHT LUXE', title: 'QUIETLY EXCEPTIONAL.', body: 'Refined textures for your everyday rotation.', desktopImage: '/images/campaign/polo-model-wide.webp', mobileImage: '/images/campaign/polo-mobile.webp', cta: '', href: '/collections/all', active: true,
  },
];

export const SEED_CATEGORIES = [
  { id: 'cat-1', name: 'T-Shirt', slug: 't-shirt', image: '/images/products/black-tee-front.webp', active: true },
  { id: 'cat-2', name: 'Drop Shoulder', slug: 'drop-shoulder', image: '/images/products/ivory-tee-angle.webp', active: true },
  { id: 'cat-3', name: 'Sweatshirt', slug: 'sweatshirt', image: '/images/products/charcoal-sweatshirt-front.webp', active: true },
  { id: 'cat-4', name: 'Hoodie', slug: 'hoodie', image: '/images/products/stone-hoodie-front.webp', active: true },
  { id: 'cat-5', name: 'Polo', slug: 'polo', image: '/images/products/olive-polo-front.webp', active: true },
  { id: 'cat-6', name: 'Regular Fit', slug: 'regular-fit', image: '/images/products/sage-tee-front.webp', active: true },
  { id: 'cat-7', name: 'Track Pant', slug: 'track-pant', image: '/images/products/black-trackpant-front.webp', active: false },
  { id: 'cat-8', name: 'Joggers', slug: 'joggers', image: '/images/products/sand-jogger-front.webp', active: false },
];

export const SEED_SETTINGS = {
  brandName: 'ONE 2 1 EIGHT',
  brandLine: 'Wear your own standard.',
  promoText: 'COMPLIMENTARY SHIPPING OVER ₹1,499   •   7-DAY EASY RETURNS   •   USE WELCOME10 FOR 10% OFF YOUR FIRST ORDER',
  announcementEnabled: true,
  freeShippingThreshold: 1499,
  returnPolicy: 'Easy returns within 7 days of delivery. Items must be unworn, unwashed and in their original packaging. Final-sale products are excluded.',
  seoTitle: 'ONE 2 1 EIGHT — Elevated everyday menswear',
  seoDescription: 'Discover premium everyday menswear: T-shirts, drop shoulders, sweatshirts, hoodies, polos, track pants and joggers, designed with comfort and considered detail.',
  contactEmail: 'care@one2oneight.example',
  contactPhone: '+91 90000 12181',
};

export const SEED_ORDERS = [
  { id: '1218-1042', customer: 'Arjun Nair', date: '2026-10-21', amount: 2698, status: 'Processing', items: 2 },
  { id: '1218-1041', customer: 'Kabir Shah', date: '2026-10-21', amount: 1799, status: 'Shipped', items: 1 },
  { id: '1218-1040', customer: 'Vihaan Mehta', date: '2026-10-20', amount: 3498, status: 'Delivered', items: 2 },
  { id: '1218-1039', customer: 'Ishaan Rao', date: '2026-10-20', amount: 899, status: 'Processing', items: 1 },
];

export const SEED_REVIEWS = [
  { id: 'r1', product: 'Essential Box Fit T-Shirt', customer: 'Rahul S.', rating: 5, text: 'The weight and fit feel premium. Exactly the kind of tee I keep reaching for.', date: '18 Oct 2026', status: 'Published' },
  { id: 'r2', product: 'Elevated Knit Polo', customer: 'Nikhil P.', rating: 5, text: 'Beautiful texture and a great fit. Works just as well with jeans as with trousers.', date: '15 Oct 2026', status: 'Published' },
  { id: 'r3', product: 'Studio Drop Shoulder Tee', customer: 'Aditya R.', rating: 4, text: 'Very good quality and drape. I would love to see more colours.', date: '12 Oct 2026', status: 'Pending' },
];
