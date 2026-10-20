'use client';
// OAuth browser binding (PS-11). Before sending the person to the provider, the browser makes a random nonce, keeps it
// here and gives the API only its SHA-256. When the provider sends the person back, the completion page posts the nonce
// with the signed-in session: a consent link started elsewhere (another browser or another account) cannot complete.

const KEY = (provider: string) => `resuto.oauth.${provider}`;
const MAX_AGE_MS = 20 * 60_000;

export interface PendingOAuth { nonce: string; orgId: string; redirectAfter: string; at: number }

const toBase64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Creates and stores the nonce for `provider`; returns the SHA-256 (hex) to send with the start request. */
export async function beginOAuth(provider: string, orgId: string, redirectAfter: string): Promise<string> {
  const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const binding = toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(nonce)));
  const pending: PendingOAuth = { nonce, orgId, redirectAfter, at: Date.now() };
  localStorage.setItem(KEY(provider), JSON.stringify(pending));
  return binding;
}

/** Reads and forgets the pending flow for `provider` (null when absent, expired or malformed). */
export function takeOAuth(provider: string): PendingOAuth | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY(provider));
    localStorage.removeItem(KEY(provider));
  } catch {
    return null;
  }
  try {
    const p = JSON.parse(raw ?? 'null') as PendingOAuth | null;
    if (!p || typeof p.nonce !== 'string' || typeof p.orgId !== 'string' || Date.now() - p.at > MAX_AGE_MS) return null;
    return { ...p, redirectAfter: /^\/(?!\/)/.test(p.redirectAfter) ? p.redirectAfter : `/dashboard/${p.orgId}/integrations` };
  } catch {
    return null;
  }
}
