import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { scriptedFetch } from '../messaging/testing/scripted-fetch';
import { foodicsOAuth, foodicsOAuthEndpoints, parseFoodicsWebhook, revokeFoodicsToken } from '../pos/foodics';
import { buildAuthorizeUrl, exchangeAuthorizationCode, pkceChallenge, pkcePair, refreshOAuthToken, type OAuthEndpoints } from './index';

const app = { clientId: '9042bfae-71d2-400f-b45e-b45e3282b45e', clientSecret: 'client-secret-xyz', redirectUri: 'https://api.example/v1/public/integrations/oauth/foodics/callback' };
const STATE = 'state_abcdefghijklmnopqrstuv';
const generic: OAuthEndpoints = {
  provider: 'demo', authorizeUrl: 'https://id.example/authorize', tokenUrl: 'https://id.example/token', tokenBody: 'form', clientAuth: 'basic',
  redirectInAuthorize: true, scopes: ['menu.read', 'orders.read'], pkce: true,
};

describe('generic OAuth helper (INT-24)', () => {
  it('PKCE: RFC 7636 S256 challenge of a 43–128 char verifier (RFC 7636 appendix B vector)', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    const p = pkcePair();
    expect(p.verifier.length).toBeGreaterThanOrEqual(43);
    expect(p.verifier.length).toBeLessThanOrEqual(128);
    expect(p.challenge).toBe(createHash('sha256').update(p.verifier).digest('base64url'));
  });

  it('builds an authorize URL with state, redirect, scopes and the challenge; refuses a missing challenge or a weak state', () => {
    const u = new URL(buildAuthorizeUrl(generic, app, STATE, { codeChallenge: 'abc' }));
    expect(Object.fromEntries(u.searchParams)).toEqual({ client_id: app.clientId, state: STATE, redirect_uri: app.redirectUri, response_type: 'code',
      scope: 'menu.read orders.read', code_challenge: 'abc', code_challenge_method: 'S256' });
    expect(() => buildAuthorizeUrl(generic, app, STATE)).toThrow('PKCE challenge required');
    expect(() => buildAuthorizeUrl(generic, app, 'short')).toThrow('invalid OAuth state');
  });

  it('exchanges the code (form body + HTTP Basic client auth + verifier) and refreshes', async () => {
    const { fetch, calls } = scriptedFetch([{ body: { token_type: 'Bearer', access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600 } }, { body: { access_token: 'AT2', expires_in: '7200' } }]);
    const t = await exchangeAuthorizationCode(generic, { fetch }, app, 'the-code', { codeVerifier: 'v'.repeat(43) });
    expect(t).toEqual({ accessToken: 'AT1', refreshToken: 'RT1', expiresIn: 3600, refreshExpiresIn: null });
    expect(calls[0].headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(calls[0].headers.authorization).toBe(`Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64')}`);
    expect(Object.fromEntries(new URLSearchParams(calls[0].body!))).toEqual({ grant_type: 'authorization_code', code: 'the-code', redirect_uri: app.redirectUri, code_verifier: 'v'.repeat(43) });
    expect((await refreshOAuthToken(generic, { fetch }, app, 'RT1')).expiresIn).toBe(7200);
    expect(Object.fromEntries(new URLSearchParams(calls[1].body!))).toEqual({ grant_type: 'refresh_token', refresh_token: 'RT1' });
    await expect(exchangeAuthorizationCode(generic, { fetch }, app, 'c')).rejects.toThrow('PKCE verifier missing');
  });

  it('token errors carry only the status and the OAuth error code, never the body or a token', async () => {
    const { fetch } = scriptedFetch([{ status: 400, body: { error: 'invalid_grant', error_description: `code the-code for ${app.clientSecret} expired` } }]);
    const err = await exchangeAuthorizationCode({ ...generic, pkce: false }, { fetch }, app, 'the-code').catch((e) => e);
    expect(err.message).toBe('demo: token endpoint HTTP 400 invalid_grant');
    expect(err.retryable).toBe(false);
    const bad = scriptedFetch([{ body: { token_type: 'mac', access_token: 'x' } }]);
    await expect(exchangeAuthorizationCode({ ...generic, pkce: false }, { fetch: bad.fetch }, app, 'c')).rejects.toThrow('unsupported token type');
  });
});

describe('Foodics OAuth (INT-24, developers.foodics.com/guides/get-started.html)', () => {
  it('authorize: console[-sandbox].foodics.com/authorize?client_id&state (no redirect, no PKCE: not documented)', () => {
    const u = new URL(foodicsOAuth('sandbox').buildAuthUrl(app, STATE));
    expect(u.origin + u.pathname).toBe('https://console-sandbox.foodics.com/authorize');
    expect(Object.fromEntries(u.searchParams)).toEqual({ client_id: app.clientId, state: STATE });
    expect(new URL(foodicsOAuth('live').buildAuthUrl(app, STATE)).host).toBe('console.foodics.com');
    expect(foodicsOAuthEndpoints('live').tokenUrl).toBe('https://api.foodics.com/oauth/token');
  });

  it('exchanges the code with the documented JSON body, then reads the business (whoami) as the only account choice', async () => {
    const { fetch, calls } = scriptedFetch([
      { body: { token_type: 'Bearer', access_token: 'eyJ0eXAi.foodics.token' } },
      { body: { data: { business: { id: '9598b465-dd92', name: "Alex Ralph's Business", reference: 526215, country_iso_code: 'SA' } } } },
    ]);
    const t = await foodicsOAuth('sandbox').exchangeCode({ fetch }, app, 'def50200a27e');
    expect(calls[0].url).toBe('https://api-sandbox.foodics.com/oauth/token');
    expect(calls[0].headers['content-type']).toBe('application/json');
    expect(JSON.parse(calls[0].body!)).toEqual({ grant_type: 'authorization_code', code: 'def50200a27e', redirect_uri: app.redirectUri, client_id: app.clientId, client_secret: app.clientSecret });
    expect(calls[1].url).toBe('https://api-sandbox.foodics.com/v5/whoami');
    expect(calls[1].headers.authorization).toBe('Bearer eyJ0eXAi.foodics.token');
    expect(t).toMatchObject({ accessToken: 'eyJ0eXAi.foodics.token', refreshToken: null, expiresIn: null,
      accounts: [{ id: '526215', name: "Alex Ralph's Business", currency: null, status: 'SA' }], identity: { businessId: '9598b465-dd92' } });
  });

  it('revokes with DELETE /tokens/client; a 401 means already revoked; other errors are reported, not thrown', async () => {
    const ok = scriptedFetch([{ body: {} }]);
    expect(await revokeFoodicsToken({ environment: 'live', credentials: { accessToken: 'tok' }, config: {}, fetch: ok.fetch })).toMatchObject({ attempted: true, revoked: true });
    expect(`${ok.calls[0].method} ${ok.calls[0].url}`).toBe('DELETE https://api.foodics.com/v5/tokens/client');
    const gone = scriptedFetch([{ status: 401, body: {} }]);
    expect((await revokeFoodicsToken({ environment: 'live', credentials: { accessToken: 'tok' }, config: {}, fetch: gone.fetch })).revoked).toBe(true);
    const down = scriptedFetch([{ status: 500, body: {} }]);
    expect(await revokeFoodicsToken({ environment: 'live', credentials: { accessToken: 'tok' }, config: {}, fetch: down.fetch }))
      .toMatchObject({ attempted: true, revoked: false });
  });
});

describe('Foodics webhook (no signature documented: fail closed on our own URL secret)', () => {
  const secret = 'whk_0123456789abcdefghijklmnop';
  const body = { timestamp: 1603798700, event: 'menu.updated', business: { name: 'Happy Meal', reference: 154543 } };
  it('refuses when the secret is unset or wrong', () => {
    expect(parseFoodicsWebhook({ urlToken: secret, expectedToken: undefined, body })).toEqual({ ok: false, reason: 'not_configured' });
    expect(parseFoodicsWebhook({ urlToken: secret, expectedToken: 'short', body })).toEqual({ ok: false, reason: 'not_configured' });
    expect(parseFoodicsWebhook({ urlToken: 'whk_wrong', expectedToken: secret, body })).toEqual({ ok: false, reason: 'bad_token' });
  });
  it('reads only the event and business reference; other events are ignored', () => {
    expect(parseFoodicsWebhook({ urlToken: secret, expectedToken: secret, body })).toEqual({ ok: true, nudge: { event: 'menu.updated', businessReference: '154543', timestamp: 1603798700 } });
    expect(parseFoodicsWebhook({ urlToken: secret, expectedToken: secret, body: { ...body, event: 'order.created' } })).toEqual({ ok: false, reason: 'ignored_event' });
    expect(parseFoodicsWebhook({ urlToken: secret, expectedToken: secret, body: { event: 'menu.updated', business: { reference: "1; drop" } } })).toEqual({ ok: false, reason: 'bad_payload' });
  });
});
