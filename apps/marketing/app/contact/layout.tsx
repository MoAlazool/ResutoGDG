import type { Metadata } from 'next';
import type { ReactNode } from 'react';
export const metadata: Metadata = { title: 'Contact', description: 'Contact Resuto through Top Handles LLC, its Wyoming business contact, or reach the founder directly.', alternates: { canonical: '/contact/' } };
export default function Layout({ children }: { children: ReactNode }) { return children; }
