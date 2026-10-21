// Notification channel acceptance checks (INT-28). Both providers' own test paths are used, so no real person is
// messaged: Resend's documented test inbox delivered@resend.dev (https://resend.com/docs/dashboard/emails/send-test-emails)
// and Twilio test credentials with the magic From number +15005550006, which validates without sending
// (https://www.twilio.com/docs/iam/test-credentials). Account reads are separate, read-only checks.
import { resendAdapter, twilioSmsAdapter } from '../notify';
import { expectThat, registerChecks, type AcceptanceCheck } from './index';
import { runKey } from './payments-common';

export const notifyChecks: AcceptanceCheck[] = [
  {
    id: 'resend.list_domains', provider: 'resend', capability: 'credentials', modes: ['official_test', 'live'],
    requires: ['RESEND_API_KEY'], effect: 'read',
    prerequisites: ['A Resend API key with full access (a sending-only key cannot list domains and is reported as such).'],
    docsUrl: 'https://resend.com/docs/api-reference/domains/list-domains',
    async run(ctx) {
      const h = await resendAdapter.healthCheck!({ ...ctx.adapter, credentials: { apiKey: ctx.env.RESEND_API_KEY! }, config: {} });
      ctx.evidence('domains listed', { ok: h.ok, details: h.details ?? null });
      expectThat(h.ok, 'the key could not list domains');
    },
  },
  {
    id: 'resend.test_inbox_send', provider: 'resend', capability: 'email_transactional', modes: ['official_test'],
    requires: ['RESEND_API_KEY', 'RESEND_FROM'], effect: 'write_test',
    prerequisites: ['RESEND_FROM on a domain verified in Resend (or onboarding@resend.dev). The message goes to Resend\'s test inbox delivered@resend.dev only.'],
    docsUrl: 'https://resend.com/docs/api-reference/emails/send-email',
    async run(ctx) {
      const key = runKey('rs');
      const r = await resendAdapter.send({ ...ctx.adapter, credentials: { apiKey: ctx.env.RESEND_API_KEY! }, config: { from: ctx.env.RESEND_FROM } }, {
        to: 'delivered+resuto-acceptance@resend.dev', subject: 'Resuto acceptance check', text: `Resuto acceptance ${key}`, idempotencyKey: key,
        unsubscribeUrl: 'https://resuto.app/acceptance/unsubscribe',
      });
      ctx.evidence('accepted by Resend', { emailId: r.providerMessageId, status: r.status });
      expectThat(r.providerMessageId.length > 0, 'no email id returned');
    },
  },
  {
    id: 'twilio_sms.test_credentials_send', provider: 'twilio_sms', capability: 'sms_transactional', modes: ['official_test'],
    requires: ['TWILIO_TEST_ACCOUNT_SID', 'TWILIO_TEST_AUTH_TOKEN'], effect: 'write_test',
    prerequisites: ['Twilio console → Account → API keys & tokens → Test credentials. With the magic From +15005550006 Twilio validates the request and sends nothing.'],
    docsUrl: 'https://www.twilio.com/docs/iam/test-credentials',
    async run(ctx) {
      const r = await twilioSmsAdapter.send({ ...ctx.adapter, credentials: { accountSid: ctx.env.TWILIO_TEST_ACCOUNT_SID!, authToken: ctx.env.TWILIO_TEST_AUTH_TOKEN! }, config: { from: '+15005550006' } },
        { to: '+15005550010', text: 'Resuto acceptance check', idempotencyKey: runKey('tw') });
      ctx.evidence('validated by Twilio (test credentials)', { messageSid: r.providerMessageId, status: r.status });
      expectThat(r.providerMessageId.startsWith('SM'), 'unexpected message SID');
    },
  },
  {
    id: 'twilio_sms.account', provider: 'twilio_sms', capability: 'credentials', modes: ['live'],
    requires: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'], effect: 'read',
    prerequisites: ['Live Account SID and Auth Token (test credentials cannot read the Account resource). Reads the account only.'],
    docsUrl: 'https://www.twilio.com/docs/iam/api/account',
    async run(ctx) {
      const h = await twilioSmsAdapter.healthCheck!({ ...ctx.adapter, credentials: { accountSid: ctx.env.TWILIO_ACCOUNT_SID!, authToken: ctx.env.TWILIO_AUTH_TOKEN! }, config: {} });
      ctx.evidence('account read', { ok: h.ok, details: h.details ?? null });
      expectThat(h.ok, 'the account is not active');
    },
  },
];

registerChecks(...notifyChecks);
