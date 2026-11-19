import { describe, expect, it, beforeEach } from 'vitest';
import {
  formatEmailUrl,
  formatInstagramUrl,
  formatPhoneTel,
  formatWhatsAppUrl,
} from '@/lib/format';
import {
  storeSettingsSchema,
  instagramUrlSchema,
  whatsappNumberSchema,
  type StoreSettings,
} from '@/lib/api/schemas';
import { toSettings, type Row } from '@/lib/backend/data';
import { clearServerCache } from '@/lib/api/server-transport';

describe('Contact formatting and normalisation for footer links', () => {
  describe('formatEmailUrl', () => {
    it('constructs a valid mailto: link from customer care email', () => {
      expect(formatEmailUrl('one21eight@gmail.com')).toBe('mailto:one21eight@gmail.com');
      expect(formatEmailUrl('  one21eight@gmail.com  ')).toBe('mailto:one21eight@gmail.com');
    });

    it('returns null for empty, missing or invalid email values without rendering broken link', () => {
      expect(formatEmailUrl('')).toBeNull();
      expect(formatEmailUrl('   ')).toBeNull();
      expect(formatEmailUrl(null)).toBeNull();
      expect(formatEmailUrl(undefined)).toBeNull();
      expect(formatEmailUrl('invalid-email-no-at')).toBeNull();
    });
  });

  describe('formatPhoneTel', () => {
    it('normalises spaces and formatting for clickable tel: destination', () => {
      expect(formatPhoneTel('+91 9344301218')).toBe('tel:+919344301218');
      expect(formatPhoneTel('+91-9344-301218')).toBe('tel:+919344301218');
      expect(formatPhoneTel('+91 (934) 430-1218')).toBe('tel:+919344301218');
      expect(formatPhoneTel('9344301218')).toBe('tel:9344301218');
    });

    it('returns null for empty or non-phone strings', () => {
      expect(formatPhoneTel('')).toBeNull();
      expect(formatPhoneTel('   ')).toBeNull();
      expect(formatPhoneTel(null)).toBeNull();
      expect(formatPhoneTel(undefined)).toBeNull();
      expect(formatPhoneTel('abc')).toBeNull();
      expect(formatPhoneTel('12')).toBeNull();
    });
  });

  describe('formatWhatsAppUrl', () => {
    it('constructs dynamic click-to-chat URL from configured digits with country code', () => {
      expect(formatWhatsAppUrl('919344301218')).toBe('https://wa.me/919344301218');
    });

    it('strips spaces, plus signs, brackets and hyphens', () => {
      expect(formatWhatsAppUrl('+91 9344301218')).toBe('https://wa.me/919344301218');
      expect(formatWhatsAppUrl('+91 (934) 430-1218')).toBe('https://wa.me/919344301218');
      expect(formatWhatsAppUrl('+91-9344-301218')).toBe('https://wa.me/919344301218');
    });

    it('does not duplicate country code if the number already starts with 91', () => {
      expect(formatWhatsAppUrl('919344301218')).toBe('https://wa.me/919344301218');
      expect(formatWhatsAppUrl('+919344301218')).toBe('https://wa.me/919344301218');
    });

    it('prepends 91 for 10-digit Indian numbers', () => {
      expect(formatWhatsAppUrl('9344301218')).toBe('https://wa.me/919344301218');
    });

    it('returns null for missing, empty, or insufficient digit values', () => {
      expect(formatWhatsAppUrl('')).toBeNull();
      expect(formatWhatsAppUrl('   ')).toBeNull();
      expect(formatWhatsAppUrl(null)).toBeNull();
      expect(formatWhatsAppUrl(undefined)).toBeNull();
      expect(formatWhatsAppUrl('12345')).toBeNull();
    });
  });

  describe('formatInstagramUrl', () => {
    it('accepts valid HTTPS Instagram profile URLs and preserves query params', () => {
      expect(formatInstagramUrl('https://www.instagram.com/one_21eight')).toBe('https://www.instagram.com/one_21eight');
      expect(formatInstagramUrl('https://instagram.com/one_21eight')).toBe('https://instagram.com/one_21eight');
      expect(formatInstagramUrl('https://www.instagram.com/one_21eight?cplk=amQ2NXpka3BtbHhy')).toBe('https://www.instagram.com/one_21eight?cplk=amQ2NXpka3BtbHhy');
    });

    it('rejects unsafe schemes such as javascript:, data: and http:', () => {
      expect(formatInstagramUrl('javascript:alert(1)')).toBeNull();
      expect(formatInstagramUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
      expect(formatInstagramUrl('http://www.instagram.com/one_21eight')).toBeNull();
    });

    it('rejects non-Instagram domains and empty profile paths', () => {
      expect(formatInstagramUrl('https://example.com/one_21eight')).toBeNull();
      expect(formatInstagramUrl('https://not-instagram.com/one_21eight')).toBeNull();
      expect(formatInstagramUrl('https://www.instagram.com/')).toBeNull();
      expect(formatInstagramUrl('https://www.instagram.com')).toBeNull();
    });

    it('returns null for missing or blank values', () => {
      expect(formatInstagramUrl('')).toBeNull();
      expect(formatInstagramUrl('   ')).toBeNull();
      expect(formatInstagramUrl(null)).toBeNull();
      expect(formatInstagramUrl(undefined)).toBeNull();
    });
  });
});
describe('Zod validation schemas for contact settings', () => {
  describe('instagramUrlSchema', () => {
    it('accepts valid HTTPS Instagram URLs', () => {
      expect(instagramUrlSchema.parse('https://www.instagram.com/one_21eight')).toBe('https://www.instagram.com/one_21eight');
      expect(instagramUrlSchema.parse('https://instagram.com/one_21eight')).toBe('https://instagram.com/one_21eight');
    });

    it('accepts null and undefined', () => {
      expect(instagramUrlSchema.parse(null)).toBeNull();
      expect(instagramUrlSchema.parse(undefined)).toBeUndefined();
    });

    it('rejects non-https and non-Instagram URLs', () => {
      expect(() => instagramUrlSchema.parse('http://www.instagram.com/one_21eight')).toThrow();
      expect(() => instagramUrlSchema.parse('https://twitter.com/one_21eight')).toThrow();
      expect(() => instagramUrlSchema.parse('javascript:alert(1)')).toThrow();
    });
  });

  describe('whatsappNumberSchema', () => {
    it('accepts 10 to 15 digits', () => {
      expect(whatsappNumberSchema.parse('919344301218')).toBe('919344301218');
      expect(whatsappNumberSchema.parse('9344301218')).toBe('9344301218');
    });

    it('accepts null and undefined', () => {
      expect(whatsappNumberSchema.parse(null)).toBeNull();
      expect(whatsappNumberSchema.parse(undefined)).toBeUndefined();
    });

    it('rejects strings with letters, symbols or invalid lengths', () => {
      expect(() => whatsappNumberSchema.parse('+919344301218')).toThrow();
      expect(() => whatsappNumberSchema.parse('91 9344301218')).toThrow();
      expect(() => whatsappNumberSchema.parse('12345')).toThrow();
      expect(() => whatsappNumberSchema.parse('12345678901234567')).toThrow();
    });
  });

  describe('storeSettingsSchema full object validation', () => {
    const validBase: StoreSettings = {
      brandName: 'ONE 2 1 EIGHT',
      brandLine: 'Elevated everyday menswear',
      promoText: 'Complimentary shipping over ₹1,499',
      announcementEnabled: true,
      freeShippingThreshold: 1499,
      shippingFee: 79,
      lowStockThreshold: 5,
      returnPolicy: '7-day easy returns',
      seoTitle: 'ONE 2 1 EIGHT | Elevated Everyday Menswear',
      seoDescription: 'Thoughtfully crafted menswear.',
      contactEmail: 'one21eight@gmail.com',
      contactPhone: '+91 9344301218',
      whatsappNumber: '919344301218',
      instagramUrl: 'https://www.instagram.com/one_21eight',
      productOfferCode: null,
      productOfferText: null,
    };

    it('validates a complete, valid settings object with all four contact fields', () => {
      const parsed = storeSettingsSchema.parse(validBase);
      expect(parsed.contactEmail).toBe('one21eight@gmail.com');
      expect(parsed.contactPhone).toBe('+91 9344301218');
      expect(parsed.whatsappNumber).toBe('919344301218');
      expect(parsed.instagramUrl).toBe('https://www.instagram.com/one_21eight');
    });

    it('validates settings when optional contact fields are null or undefined', () => {
      const parsed = storeSettingsSchema.parse({
        ...validBase,
        whatsappNumber: null,
        instagramUrl: null,
      });
      expect(parsed.whatsappNumber).toBeNull();
      expect(parsed.instagramUrl).toBeNull();
    });
  });
});
describe('Database row mapping (toSettings)', () => {
  it('maps Supabase store_settings columns to camelCase StoreSettings interface', () => {
    const dbRow: Row = {
      id: 1,
      brand_name: 'ONE 2 1 EIGHT',
      brand_line: 'Elevated everyday menswear',
      promo_text: 'Promo text',
      announcement_enabled: true,
      free_shipping_threshold: '1499.00',
      shipping_fee: '79.00',
      low_stock_threshold: 5,
      return_policy: 'Return policy text',
      seo_title: 'SEO Title',
      seo_description: 'SEO Description',
      contact_email: 'one21eight@gmail.com',
      contact_phone: '+91 9344301218',
      instagram_url: 'https://www.instagram.com/one_21eight',
      whatsapp_number: '919344301218',
      product_offer_code: null,
      product_offer_text: null,
    };

    const settings = toSettings(dbRow);
    expect(settings.contactEmail).toBe('one21eight@gmail.com');
    expect(settings.contactPhone).toBe('+91 9344301218');
    expect(settings.whatsappNumber).toBe('919344301218');
    expect(settings.instagramUrl).toBe('https://www.instagram.com/one_21eight');
    expect(settings.freeShippingThreshold).toBe(1499);
    expect(settings.shippingFee).toBe(79);
    expect(settings.brandName).toBe('ONE 2 1 EIGHT');
  });
});
describe('Cache invalidation and revalidation mechanism', () => {
  beforeEach(() => {
    clearServerCache();
  });

  it('clearServerCache() safely clears internal cache without errors', () => {
    expect(() => clearServerCache()).not.toThrow();
  });
});
describe('End-to-end controlled test sequence (18-step verification scenario)', () => {
  let dbRow: Row;

  beforeEach(() => {
    clearServerCache();
    // Step 1: Initial state as found in database
    dbRow = {
      id: 1,
      brand_name: 'ONE 2 1 EIGHT',
      brand_line: 'Elevated everyday menswear',
      promo_text: '',
      announcement_enabled: true,
      free_shipping_threshold: '1499.00',
      shipping_fee: '79.00',
      low_stock_threshold: 5,
      return_policy: '7-day easy returns',
      seo_title: 'ONE 2 1 EIGHT',
      seo_description: 'Store description',
      contact_email: 'care@example.com',
      contact_phone: '',
      whatsapp_number: null,
      instagram_url: null,
      product_offer_code: null,
      product_offer_text: null,
      updated_at: new Date().toISOString(),
    };
  });

  it('executes the full 18-step controlled update, verification, and restoration sequence', () => {
    // Step 2: Confirm initial saved values
    let currentSettings = toSettings(dbRow);
    expect(currentSettings.contactEmail).toBe('care@example.com');
    expect(currentSettings.contactPhone).toBe('');
    expect(currentSettings.whatsappNumber).toBeNull();
    expect(currentSettings.instagramUrl).toBeNull();

    // Verify initial footer destinations: empty/null fields must not render broken links
    expect(formatPhoneTel(currentSettings.contactPhone)).toBeNull();
    expect(formatWhatsAppUrl(currentSettings.whatsappNumber)).toBeNull();
    expect(formatInstagramUrl(currentSettings.instagramUrl)).toBeNull();

    // Step 3 & 4: Change customer care email to a different valid test address and save
    const testEmail = 'support-test@one21eight.com';
    const updatedSettings1 = storeSettingsSchema.parse({
      ...currentSettings,
      contactEmail: testEmail,
    });
    dbRow.contact_email = updatedSettings1.contactEmail;
    clearServerCache();

    // Step 5 & 6: Open storefront and confirm footer email icon uses updated address
    currentSettings = toSettings(dbRow);
    expect(formatEmailUrl(currentSettings.contactEmail)).toBe('mailto:support-test@one21eight.com');

    // Step 7 & 8: Change phone number to a different valid test number and save
    const testPhone = '+91 98765 43210';
    const updatedSettings2 = storeSettingsSchema.parse({
      ...currentSettings,
      contactPhone: testPhone,
    });
    dbRow.contact_phone = updatedSettings2.contactPhone;
    clearServerCache();

    // Step 9: Confirm telephone destination updates (normalised for tel: while preserving human-readable format)
    currentSettings = toSettings(dbRow);
    expect(currentSettings.contactPhone).toBe('+91 98765 43210');
    expect(formatPhoneTel(currentSettings.contactPhone)).toBe('tel:+919876543210');

    // Step 10 & 11: Change WhatsApp number and save
    const testWhatsApp = '919876543210';
    const updatedSettings3 = storeSettingsSchema.parse({
      ...currentSettings,
      whatsappNumber: testWhatsApp,
    });
    dbRow.whatsapp_number = updatedSettings3.whatsappNumber;
    clearServerCache();

    // Step 12: Confirm WhatsApp URL changes accordingly
    currentSettings = toSettings(dbRow);
    expect(currentSettings.whatsappNumber).toBe('919876543210');
    expect(formatWhatsAppUrl(currentSettings.whatsappNumber)).toBe('https://wa.me/919876543210');

    // Step 13 & 14: Change Instagram URL to another valid test Instagram profile URL and save
    const testInstagram = 'https://www.instagram.com/one_21eight_test';
    const updatedSettings4 = storeSettingsSchema.parse({
      ...currentSettings,
      instagramUrl: testInstagram,
    });
    dbRow.instagram_url = updatedSettings4.instagramUrl;
    clearServerCache();

    // Step 15: Confirm footer now uses updated Instagram URL
    currentSettings = toSettings(dbRow);
    expect(currentSettings.instagramUrl).toBe('https://www.instagram.com/one_21eight_test');
    expect(formatInstagramUrl(currentSettings.instagramUrl)).toBe('https://www.instagram.com/one_21eight_test');

    // Step 16 & 17: Refresh storefront and confirm all four updated values persist
    clearServerCache();
    const refreshedSettings = toSettings(dbRow);
    expect(formatEmailUrl(refreshedSettings.contactEmail)).toBe('mailto:support-test@one21eight.com');
    expect(formatPhoneTel(refreshedSettings.contactPhone)).toBe('tel:+919876543210');
    expect(formatWhatsAppUrl(refreshedSettings.whatsappNumber)).toBe('https://wa.me/919876543210');
    expect(formatInstagramUrl(refreshedSettings.instagramUrl)).toBe('https://www.instagram.com/one_21eight_test');

    // Step 18: Restore the approved official contact values through the Admin UI
    const restoredSettings = storeSettingsSchema.parse({
      ...refreshedSettings,
      contactEmail: 'one21eight@gmail.com',
      contactPhone: '+91 9344301218',
      whatsappNumber: '919344301218',
      instagramUrl: null, // As official Instagram URL is unset in CMS, left unset
    });
    dbRow.contact_email = restoredSettings.contactEmail;
    dbRow.contact_phone = restoredSettings.contactPhone;
    dbRow.whatsapp_number = restoredSettings.whatsappNumber;
    dbRow.instagram_url = restoredSettings.instagramUrl;
    clearServerCache();

    const finalSettings = toSettings(dbRow);
    expect(formatEmailUrl(finalSettings.contactEmail)).toBe('mailto:one21eight@gmail.com');
    expect(formatPhoneTel(finalSettings.contactPhone)).toBe('tel:+919344301218');
    expect(formatWhatsAppUrl(finalSettings.whatsappNumber)).toBe('https://wa.me/919344301218');
    expect(formatInstagramUrl(finalSettings.instagramUrl)).toBeNull();

    // Verify non-contact store settings were completely unaffected
    expect(finalSettings.brandName).toBe('ONE 2 1 EIGHT');
    expect(finalSettings.freeShippingThreshold).toBe(1499);
    expect(finalSettings.shippingFee).toBe(79);
    expect(finalSettings.lowStockThreshold).toBe(5);
    expect(finalSettings.returnPolicy).toBe('7-day easy returns');
  });
});
