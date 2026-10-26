'use client';

import React from 'react';
import Link from 'next/link';

type RouteLinkProps = {
  href: string;
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
  title?: string;
  target?: '_self' | '_blank' | '_parent' | '_top';
  'aria-label'?: string;
};

export function RouteLink({ href, children, className, onClick, title, target, 'aria-label': ariaLabel }: RouteLinkProps) {
  // `rel` guards window.opener when links open in a new tab (admin "View store"/"Preview storefront").
  return <Link href={href} className={className} title={title} target={target} rel={target === '_blank' ? 'noopener noreferrer' : undefined} aria-label={ariaLabel} onClick={onClick}>{children}</Link>;
}
