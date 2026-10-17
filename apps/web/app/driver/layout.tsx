import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { DriverShell } from './_lib/driver-context';

export const metadata: Metadata = { title: 'ResutoDriver', robots: { index: false } };
export const viewport: Viewport = { themeColor: '#173f36', width: 'device-width', initialScale: 1, viewportFit: 'cover' };

export default function DriverLayout({ children }: { children: ReactNode }) {
  return <DriverShell>{children}</DriverShell>;
}
