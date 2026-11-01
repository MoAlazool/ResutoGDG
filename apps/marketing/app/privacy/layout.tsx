import type { Metadata } from 'next';
import type { ReactNode } from 'react';
export const metadata: Metadata = { title: 'Privacy Policy', description: 'Privacy information for the static Resuto website and email inquiries handled through its project and business contacts.', alternates: { canonical: '/privacy/' } };
export default function Layout({ children }: { children: ReactNode }) { return children; }
