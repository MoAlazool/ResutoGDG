import type { Metadata } from 'next';
import type { ReactNode } from 'react';
export const metadata: Metadata = { title: 'Privacy Policy', description: 'Privacy information for the Resuto public website.', alternates: { canonical: '/privacy/' } };
export default function Layout({ children }: { children: ReactNode }) { return children; }
