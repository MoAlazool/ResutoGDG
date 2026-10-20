// Deployed-environment guards: staging/production refuse the dev auth issuer and
// missing secrets, and access tokens must carry the expected issuer and audience.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';
import { JwtService } from '../src/common/auth/jwt.service';
import { envSchema, type Env } from '../src/config/env';

const base = {
  NODE_ENV: 'staging', SUPABASE_URL: 'https://example-ref.supabase.co', CREDENTIALS_KEYS: 'k1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  AUTH_DEV_MODE: 'false', STORAGE_DRIVER: 'local', PAYMENT_MODE: 'sandbox',
};
const production = {
  ...base, NODE_ENV: 'production', PAYMENT_MODE: 'live', STORAGE_DRIVER: 'supabase', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test',
};
const issues = (env: Record<string, string>) => {
  const r = envSchema.safeParse(env);
  return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
};

describe('deployed environment validation', () => {
  it('accepts a complete staging configuration', () => {
    expect(issues(base)).toEqual([]);
  });

  it('refuses the development auth issuer in staging and production', () => {
    expect(issues({ ...base, AUTH_DEV_MODE: 'true' })).toContain('AUTH_DEV_MODE');
    expect(issues({ ...base, NODE_ENV: 'production', AUTH_DEV_MODE: 'true' })).toContain('AUTH_DEV_MODE');
    expect(issues({ ...base, NODE_ENV: 'development', AUTH_DEV_MODE: 'true' })).toEqual([]);
  });

  it('requires Supabase, credential keys and a storage key when deployed', () => {
    const { SUPABASE_URL: _u, ...noUrl } = base;
    expect(issues({ ...noUrl, SUPABASE_JWT_SECRET: 'x'.repeat(40) })).toContain('SUPABASE_URL');
    const { CREDENTIALS_KEYS: _k, ...noKeys } = base;
    expect(issues(noKeys)).toContain('CREDENTIALS_KEYS');
    expect(issues({ ...base, STORAGE_DRIVER: 'supabase' })).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(issues({ ...base, STORAGE_DRIVER: 'supabase', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test' })).toEqual([]);
  });

  // Audit PS-05 / INT-01 / PAY-03: a production deploy that forgot PAYMENT_MODE ran the simulated provider, so any
  // payment-link holder could settle real orders with no money moving; local storage was also allowed.
  it('refuses simulated payments and local storage in production; staging opts into sandbox explicitly', () => {
    expect(issues(production)).toEqual([]);
    const { PAYMENT_MODE: _p, ...noMode } = production;
    expect(issues(noMode)).toContain('PAYMENT_MODE');
    expect(issues({ ...production, PAYMENT_MODE: 'sandbox' })).toContain('PAYMENT_MODE');
    expect(issues({ ...production, STORAGE_DRIVER: 'local' })).toContain('STORAGE_DRIVER');
    const { STORAGE_DRIVER: _s, ...noDriver } = production;
    expect(issues(noDriver)).toContain('STORAGE_DRIVER');
    // staging: sandbox + Supabase storage is the reference configuration and stays valid
    expect(issues({ ...base, STORAGE_DRIVER: 'supabase', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test' })).toEqual([]);
    const { PAYMENT_MODE: _q, ...stagingNoMode } = base;
    expect(issues(stagingNoMode)).toContain('PAYMENT_MODE');
    // local development keeps its defaults
    const dev = envSchema.parse({ SUPABASE_JWT_SECRET: 'x'.repeat(40) });
    expect([dev.PAYMENT_MODE, dev.STORAGE_DRIVER]).toEqual(['sandbox', 'local']);
  });

  it('parses the in-process worker flag', () => {
    expect(envSchema.parse({ ...base, RUN_WORKER_IN_PROCESS: 'true' }).RUN_WORKER_IN_PROCESS).toBe(true);
    expect(envSchema.parse(base).RUN_WORKER_IN_PROCESS).toBe(false);
  });
});

describe('access token verification (JWKS)', () => {
  it('accepts a Supabase ES256 token with the project issuer and rejects other issuers, audiences and keys', async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
    // A stand-in Supabase Auth JWKS endpoint on loopback.
    const server = createServer((req, res) => {
      if (req.url === '/auth/v1/.well-known/jwks.json') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })); }
      else { res.statusCode = 404; res.end(); }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const env = envSchema.parse({ ...base, SUPABASE_URL: url }) as Env;
      const svc = new JwtService(env);
      const sign = (claims: { iss?: string; aud?: string; role?: string }, key = privateKey) =>
        new SignJWT({ role: claims.role ?? 'authenticated', email: 'a@example.test' })
          .setProtectedHeader({ alg: 'ES256', kid: 'k1' }).setSubject('11111111-1111-4111-8111-111111111111')
          .setIssuer(claims.iss ?? `${url}/auth/v1`).setAudience(claims.aud ?? 'authenticated')
          .setIssuedAt().setExpirationTime('5m').sign(key);
      await expect(svc.verify(await sign({}))).resolves.toMatchObject({ sub: '11111111-1111-4111-8111-111111111111' });
      await expect(svc.verify(await sign({ iss: 'https://other-ref.supabase.co/auth/v1' }))).rejects.toThrow();
      await expect(svc.verify(await sign({ iss: 'resuto-dev-auth' }))).rejects.toThrow();
      await expect(svc.verify(await sign({ aud: 'service_role' }))).rejects.toThrow();
      await expect(svc.verify(await sign({ role: 'anon' }))).rejects.toThrow();
      const other = await generateKeyPair('ES256');
      await expect(svc.verify(await sign({}, other.privateKey))).rejects.toThrow();
      // An HS256 token is never accepted when no shared secret is configured.
      const hs = await new SignJWT({ role: 'authenticated' }).setProtectedHeader({ alg: 'HS256' }).setSubject('x')
        .setIssuer(`${url}/auth/v1`).setAudience('authenticated').setExpirationTime('5m')
        .sign(new TextEncoder().encode('y'.repeat(40)));
      await expect(svc.verify(hs)).rejects.toThrow();
      // Audit PS-25: anonymous Supabase sessions carry role "authenticated" too; they are refused.
      const anon = await new SignJWT({ role: 'authenticated', is_anonymous: true })
        .setProtectedHeader({ alg: 'ES256', kid: 'k1' }).setSubject('22222222-2222-4222-8222-222222222222')
        .setIssuer(`${url}/auth/v1`).setAudience('authenticated').setIssuedAt().setExpirationTime('5m').sign(privateKey);
      await expect(svc.verify(anon)).rejects.toThrow(/Anonymous/);

      // Audit PS-25: with a JWKS project, a configured shared secret no longer mints sessions unless explicitly allowed.
      const secret = 'z'.repeat(40);
      const hsToken = await new SignJWT({ role: 'authenticated', email: 'a@example.test' }).setProtectedHeader({ alg: 'HS256' })
        .setSubject('33333333-3333-4333-8333-333333333333').setIssuer(`${url}/auth/v1`).setAudience('authenticated')
        .setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(secret));
      const both = new JwtService(envSchema.parse({ ...base, SUPABASE_URL: url, SUPABASE_JWT_SECRET: secret }) as Env);
      await expect(both.verify(hsToken)).rejects.toThrow();
      await expect(both.verify(await sign({}))).resolves.toMatchObject({ sub: '11111111-1111-4111-8111-111111111111' });
      const legacy = new JwtService(envSchema.parse({ ...base, SUPABASE_URL: url, SUPABASE_JWT_SECRET: secret, AUTH_ALLOW_HS256: 'true' }) as Env);
      await expect(legacy.verify(hsToken)).resolves.toMatchObject({ sub: '33333333-3333-4333-8333-333333333333' });
    } finally {
      server.close();
    }
  });
});
