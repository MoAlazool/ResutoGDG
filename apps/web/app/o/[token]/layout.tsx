import type { ReactNode } from 'react';
import { LocaleCatalog } from '@/lib/i18n/client';
import { messagesFor } from '@/lib/i18n/messages';

/**
 * The WhatsApp ordering page switches between Arabic and English in place (the conversation's language first),
 * so it receives the guest messages of both locales; every other page gets only the active one.
 */
export default function OrderingLinkLayout({ children }: { children: ReactNode }) {
  return <LocaleCatalog catalog={{ en: messagesFor('en', 'guest'), ar: messagesFor('ar', 'guest') }}>{children}</LocaleCatalog>;
}
