/**
 * AUTH-03: honest labelling of email-dependent auth flows. Without a custom SMTP provider, Supabase's built-in sender
 * only delivers to the project's team members and a few messages per hour (Free plan). Deployments in that state set
 * NEXT_PUBLIC_AUTH_EMAIL_DELIVERY=limited, and every screen that waits for an email (sign-up confirmation, password
 * reset, email change) says so instead of implying the message will arrive. Unset: no note (a real SMTP sender is
 * configured, or local development where the dev issuer sends no email at all and says so itself).
 */
export const EMAIL_DELIVERY_LIMITED = process.env.NEXT_PUBLIC_AUTH_EMAIL_DELIVERY === 'limited';
