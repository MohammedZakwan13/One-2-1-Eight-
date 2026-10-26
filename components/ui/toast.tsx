import { CheckCircle2 } from 'lucide-react';

export function Toast({ message }: { message: string }) {
  if (!message) return null;
  return <div className="toast-message" role="status"><CheckCircle2 size={17} />{message}</div>;
}
