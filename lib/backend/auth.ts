import 'server-only';
import { getServerEnv } from '@/lib/env';
import { COOKIES, HttpError, db, sha256, type Ctx } from '@/lib/backend/core';

export type Customer = { id: string; phone: string; name: string | null; email: string | null };
export type AdminRole = 'owner' | 'manager' | 'content' | 'support';
export type Admin = { id: string; email: string; name: string; role: AdminRole };

export const CUSTOMER_SESSION_SECONDS = 60 * 60 * 24 * 7;
export const ADMIN_SESSION_SECONDS = 60 * 60 * 8;

export async function currentCustomer(ctx: Ctx): Promise<Customer | null> {
  const token = ctx.cookies[COOKIES.customer];
  if (!token) return null;
  const { data } = await db().from('customer_sessions').select('expires_at, customers(id, phone, name, email)').eq('token_hash', sha256(token)).maybeSingle();
  const customer = data?.customers as unknown as Customer | undefined;
  if (!data || !customer || Date.parse(data.expires_at) < Date.now()) return null;
  return customer;
}

export async function requireCustomer(ctx: Ctx): Promise<Customer> {
  const customer = await currentCustomer(ctx);
  if (!customer) throw new HttpError(401, 'unauthorized', 'Please sign in to continue.');
  return customer;
}

/** What each admin role may touch. `owner` and `manager` can do everything. */
const AREAS: Record<string, AdminRole[]> = {
  catalog: ['owner', 'manager', 'content'],
  content: ['owner', 'manager', 'content'],
  reviews: ['owner', 'manager', 'content', 'support'],
  orders: ['owner', 'manager', 'support'],
  leads: ['owner', 'manager', 'support'],
  dashboard: ['owner', 'manager', 'content', 'support'],
  settings: ['owner', 'manager'],
};

/** Validates the HttpOnly admin session against the database and the admin allow-list. Never trusts browser-supplied roles. */
export async function requireAdmin(ctx: Ctx, area: keyof typeof AREAS | 'any' = 'any'): Promise<Admin> {
  const token = ctx.cookies[getServerEnv().adminSessionCookie];
  if (!token) throw new HttpError(401, 'unauthorized', 'Please sign in to continue.');
  const { data } = await db().from('admin_sessions').select('expires_at, admin_users(id, email, name, role, active)').eq('token_hash', sha256(token)).maybeSingle();
  const admin = data?.admin_users as unknown as (Admin & { active: boolean }) | undefined;
  if (!data || !admin || !admin.active || Date.parse(data.expires_at) < Date.now()) throw new HttpError(401, 'unauthorized', 'Please sign in to continue.');
  if (area !== 'any' && !AREAS[area].includes(admin.role)) throw new HttpError(403, 'forbidden', 'You do not have permission to do that.');
  return { id: admin.id, email: admin.email, name: admin.name, role: admin.role };
}
