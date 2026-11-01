import type { Metadata } from 'next';
import type { ReactNode } from 'react';
export const metadata: Metadata = { title: 'About', description: 'Why Resuto is building a connected operating system for restaurants.', alternates: { canonical: '/about/' } };
export default function Layout({ children }: { children: ReactNode }) { return children; }
