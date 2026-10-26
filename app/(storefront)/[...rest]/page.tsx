import { notFound } from 'next/navigation';

/** Any URL that matches no route renders the branded 404 inside the storefront shell, with a real HTTP 404 status. */
export default function CatchAll() {
  notFound();
}
