import type { Metadata } from 'next';
import type { ReactNode } from 'react';
export const metadata: Metadata = { title: 'Terms', description: 'Terms for using the Resuto public website.', alternates: { canonical: '/terms/' } };
export default function Layout({ children }: { children: ReactNode }) { return children; }
