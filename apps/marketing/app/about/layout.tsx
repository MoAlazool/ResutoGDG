import type { Metadata } from 'next';
import type { ReactNode } from 'react';
export const metadata: Metadata = { title: 'About', description: 'About Resuto, its five-member university development team, and Top Handles LLC as its Wyoming business contact and NVIDIA Inception member company.', alternates: { canonical: '/about/' } };
export default function Layout({ children }: { children: ReactNode }) { return children; }
