import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ provider: 'resend', alert: vi.fn(async () => undefined) }));

vi.mock('@/lib/env', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/env')>()), getServerEnv: () => ({ emailProvider: h.provider }) }));
vi.mock('@/lib/backend/core', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/backend/core')>()), db: () => { throw new Error('no database in this test'); } }));
vi.mock('@/lib/backend/data', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/backend/data')>()) }));
vi.mock('@/lib/backend/integrations', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/backend/integrations')>()), alertAdmin: h.alert }));

import { supabaseRetryDeps } from '@/lib/backend/email/retry-supabase';

beforeEach(() => { h.alert.mockClear(); h.provider = 'resend'; });

describe('provider-neutral administrator alerts (Resend)', () => {
  it('a stalled provider (quota, temporary failures) raises the email_stalled alert and names Resend', async () => {
    await supabaseRetryDeps().onTrip!('transient');
    expect(h.alert).toHaveBeenCalledTimes(1);
    const [kind, subject, body] = h.alert.mock.calls[0] as unknown as [string, string, string];
    expect(kind).toBe('email_stalled');
    expect(subject).toBe('Email sending is stalled');
    expect(body).toContain('Resend');
    expect(`${subject} ${body}`).not.toMatch(/gmail|google/i);
  });

  it('a quota trip alerts too', async () => {
    await supabaseRetryDeps().onTrip!('quota');
    expect(h.alert).toHaveBeenCalledTimes(1);
  });

  it('an authentication trip is not alerted here: the delivery attempt already raised email_auth', async () => {
    await supabaseRetryDeps().onTrip!('auth');
    expect(h.alert).not.toHaveBeenCalled();
  });

  it('local Mailpit testing never raises alerts', async () => {
    h.provider = 'mailpit';
    await supabaseRetryDeps().onTrip!('transient');
    expect(h.alert).not.toHaveBeenCalled();
  });
});
