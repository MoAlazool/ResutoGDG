import type { Metadata } from 'next';
import type { ReactNode } from 'react';
export const metadata: Metadata = { title: 'Contact sales', description: 'Contact Resuto sales or request access for your restaurant.', alternates: { canonical: '/contact/' } };
export default function Layout({ children }: { children: ReactNode }) { return children; }
