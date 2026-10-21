import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, bootTestApp, signup, type TestApp } from './helpers';

// CR-05: change password (development issuer). Supabase deployments use Supabase Auth (resetPasswordForEmail,
// updateUser, exchangeCodeForSession) from the web app; this endpoint mirrors change password for local runs.
let t: TestApp;
beforeAll(async () => { t = await bootTestApp(); });
afterAll(async () => { await t.close(); });

describe('CR-05 change password (dev issuer)', () => {
  it('requires a signed-in user and the current password, then only the new password signs in', async () => {
    const u = await signup(t, 'pw');
    const url = '/v1/auth/dev/password';
    expect((await t.http.post(url).send({ currentPassword: 'correct-horse-battery', newPassword: 'another-long-password' })).status).toBe(401);
    expect((await t.http.post(url).set(auth(u)).send({ currentPassword: 'correct-horse-battery', newPassword: 'short' })).status).toBe(400);
    expect((await t.http.post(url).set(auth(u)).send({ currentPassword: 'correct-horse-battery', newPassword: 'another-long-password', extra: 1 })).status).toBe(400);
    const wrong = await t.http.post(url).set(auth(u)).send({ currentPassword: 'not-my-password', newPassword: 'another-long-password' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('invalid_credentials');
    const same = await t.http.post(url).set(auth(u)).send({ currentPassword: 'correct-horse-battery', newPassword: 'correct-horse-battery' });
    expect(same.body.error.code).toBe('password_unchanged');
    const ok = await t.http.post(url).set(auth(u)).send({ currentPassword: 'correct-horse-battery', newPassword: 'another-long-password' });
    expect(ok.status).toBe(200);
    expect(JSON.stringify(ok.body)).not.toContain('another-long-password');
    expect((await t.http.post('/v1/auth/dev/login').send({ email: u.email, password: 'correct-horse-battery' })).status).toBe(401);
    expect((await t.http.post('/v1/auth/dev/login').send({ email: u.email, password: 'another-long-password' })).status).toBe(200);
  });
});
