// Creates (or promotes) an admin user.  Usage:
//   ADMIN_PASSWORD='a-long-password' npm run admin:create -- you@company.com "Your Name" owner
// Roles: owner | manager | content | support.  The password is stored by Supabase Auth only (never printed or logged).
import { createClient } from '@supabase/supabase-js';

const [email, name = '', role = 'owner'] = process.argv.slice(2);
const password = process.env.ADMIN_PASSWORD;
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

if (!email || !['owner', 'manager', 'content', 'support'].includes(role)) {
  console.error('Usage: ADMIN_PASSWORD=... npm run admin:create -- <email> "<name>" <owner|manager|content|support>');
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local');
  process.exit(1);
}
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { console.error('That does not look like a valid e-mail address.'); process.exit(1); }
if (password !== undefined && (password.length < 12 || !/[a-z]/i.test(password) || !/\d/.test(password))) {
  console.error('ADMIN_PASSWORD must be at least 12 characters and contain letters and a digit.');
  process.exit(1);
}
if (!SUPABASE_URL.startsWith('https://')) { console.error('SUPABASE_URL must be https://'); process.exit(1); }
console.log(`Project: ${new URL(SUPABASE_URL).hostname}`);
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

let userId;
const created = password ? await supabase.auth.admin.createUser({ email, password, email_confirm: true }) : null;
if (created?.data?.user) {
  userId = created.data.user.id;
} else {
  // Already registered: find the existing Auth user (and, if a password was given, reset it).
  for (let page = 1; !userId && page <= 20; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) { console.error('Could not list users:', error.message); process.exit(1); }
    userId = data.users.find(user => user.email?.toLowerCase() === email.toLowerCase())?.id;
    if (data.users.length < 200) break;
  }
  if (!userId) { console.error(created?.error?.message ?? 'User not found. Provide ADMIN_PASSWORD to create it.'); process.exit(1); }
  if (password) await supabase.auth.admin.updateUserById(userId, { password });
}

const { error } = await supabase.from('admin_users').upsert({ id: userId, email: email.toLowerCase(), name, role, active: true });
if (error) {
  console.error('Could not save admin record:', error.message);
  if (/permission denied/i.test(error.message)) console.error('Run supabase/migrations/0003_service_role_grants.sql in the SQL Editor first.');
  process.exit(1);
}
console.log(`Admin ready: ${email} (${role}). Sign in at /admin/login.`);
