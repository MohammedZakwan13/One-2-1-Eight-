import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Nodemailer is only the LOCAL Mailpit transport; production mail goes through Resend over fetch. These tests keep the dependency patched and the usage confined.
const major = (version: string) => Number(version.split('.')[0]);
const atLeast = (version: string, floor: [number, number, number]) => {
  const parts = version.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if (parts[i] !== floor[i]) return parts[i] > floor[i];
  return true;
};

describe('nodemailer (local Mailpit transport)', () => {
  it('is installed at a patched version (every published advisory affects 10.1.3 and older)', () => {
    const { version } = JSON.parse(readFileSync('node_modules/nodemailer/package.json', 'utf8')) as { version: string };
    expect(major(version)).toBeGreaterThanOrEqual(10);
    expect(atLeast(version, [10, 1, 4]), version).toBe(true);
  });
  it('still offers the API the Mailpit sender uses: createTransport(...).sendMail(...) returning a messageId', async () => {
    const { createTransport } = await import('nodemailer');
    const transport = createTransport({ jsonTransport: true });
    const info = await transport.sendMail({ from: 'ONE 2 1 EIGHT <orders@one2oneight.local>', to: 'qa@example.com', subject: 'Order', html: '<p>hi</p>', text: 'hi' });
    expect(String(info.messageId)).toMatch(/@/);
    expect(JSON.parse(String(info.message)).subject).toBe('Order');
  });
  it('is imported in one place, lazily inside the Mailpit sender, never at module load', () => {
    const source = readFileSync('lib/backend/integrations.ts', 'utf8');
    expect(source).toMatch(/await import\('nodemailer'\)/);
    expect(source).not.toMatch(/^import .*from 'nodemailer'/m);
  });
});
