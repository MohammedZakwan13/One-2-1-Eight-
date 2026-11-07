import { readFileSync } from 'node:fs';
import { linkifyText } from '@/lib/format';
import { describe, expect, it } from 'vitest';

const footer = readFileSync('components/storefront/footer.tsx', 'utf8');

describe('footer email disclosure', () => {
  it('describes the order emails as future ("will be sent … once email sending is enabled") and names Resend, not Gmail or Google', () => {
    expect(footer).toMatch(/will be sent through our email service, Resend, once email sending is enabled/);
    expect(footer).not.toMatch(/gmail|google/i);
  });
  it('links to the published privacy page via the legal-page list, with no hard-coded URL', () => {
    expect(footer).toContain("legalPages.find(page => page.slug === 'privacy')");
    expect(footer).toContain('`/policies/${privacyPage.slug}`');
    expect(footer).not.toMatch(/href="\/policies\/privacy"/);
  });
});

describe('legal page links', () => {
  it('turns https URLs and email addresses into links, keeps trailing punctuation as text and ignores everything else', () => {
    const parts = linkifyText('See https://resend.com/legal/privacy-policy. Write to one21eight@gmail.com, or [x](http://evil.example) <b>hi</b>.');
    expect(parts.filter(p => p.href)).toEqual([
      { text: 'https://resend.com/legal/privacy-policy', href: 'https://resend.com/legal/privacy-policy' },
      { text: 'one21eight@gmail.com', href: 'mailto:one21eight@gmail.com' },
    ]);
    expect(parts.map(p => p.text).join('')).toBe('See https://resend.com/legal/privacy-policy. Write to one21eight@gmail.com, or [x](http://evil.example) <b>hi</b>.');
  });
});

describe('newsletter confirmation copy', () => {
  it('never tells people to check their inbox, because no confirmation email is sent', () => {
    expect(footer).not.toMatch(/check your inbox/i);
    expect(footer).toContain('your email address has been saved');
    expect(footer).toContain("Thanks — we've saved your email address for future updates.");
    expect(footer).not.toContain('Welcome in');
  });
});
