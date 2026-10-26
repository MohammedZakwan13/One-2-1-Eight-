import { AdminLogin } from '@/components/admin/admin-login';
import { safeAdminNext } from '@/lib/admin-gate';

type Props = { searchParams: Promise<{ next?: string }> };

export default async function Page({ searchParams }: Props) {
  const { next } = await searchParams;
  return <AdminLogin next={safeAdminNext(next)} />;
}
