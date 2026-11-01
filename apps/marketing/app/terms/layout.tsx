import type { Metadata } from 'next';
import type { ReactNode } from 'react';
export const metadata: Metadata = { title: 'Terms', description: 'Terms and company-role disclosures for the Resuto public website.', alternates: { canonical: '/terms/' } };
export default function Layout({ children }: { children: ReactNode }) { return children; }
