/**
 * Hosted checkout pages of the supported providers (PAY-21): Stripe Checkout, Paymob Unified Checkout (per region) and
 * Moyasar invoices. Anything else — including other https hosts — is never followed.
 */
export const PROVIDER_CHECKOUT_HOSTS = ['checkout.stripe.com', 'accept.paymob.com', 'ksa.paymob.com', 'uae.paymob.com', 'oman.paymob.com', 'checkout.moyasar.com'];

export function isSafeRedirect(url: string, here: string): boolean {
  try {
    const u = new URL(url, here);
    if (u.origin === new URL(here).origin) return true;
    return u.protocol === 'https:' && PROVIDER_CHECKOUT_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}
