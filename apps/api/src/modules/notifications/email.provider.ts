/**
 * Outbound email for staff notifications, behind a provider abstraction (FT-06).
 *
 * No email provider is configured in Resuto today (Supabase SMTP / a transactional provider is an owner action,
 * docs/OPEN_BLOCKERS.md B-14). The default provider therefore reports `configured: false`, and every attempt is
 * recorded as 'not_configured': the product never claims an email was sent when it was not. A real provider
 * implements `send` and returns the provider's message id only after the provider accepted the message.
 *
 * INT-28: when no platform provider is configured, a restaurant that connected its own Resend account gets staff
 * email through it (OutboundChannelsService: queued → sent only after Resend accepted, retries with backoff).
 */
export interface EmailMessage { to: string; subject: string; text: string }
export interface EmailProvider {
  readonly name: string;
  readonly configured: boolean;
  /** Resolves with the provider message id once the provider accepted the message; rejects otherwise. */
  send(message: EmailMessage): Promise<{ messageId: string }>;
}

export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');

export class NotConfiguredEmailProvider implements EmailProvider {
  readonly name = 'none';
  readonly configured = false;
  async send(): Promise<{ messageId: string }> {
    throw new Error('email_provider_not_configured');
  }
}

/** "owner@example.com" → "o***@example.com" (recipient hints shown in the UI never carry the full address). */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local!.slice(0, 1)}***@${domain}`;
}
