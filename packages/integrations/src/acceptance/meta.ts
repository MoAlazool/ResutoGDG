// Meta acceptance checks (ws7a): WhatsApp Cloud API, Messenger / Instagram Direct, Marketing API, Conversions API.
// Meta has no separate "test environment" URL: 'official_test' means Meta's own test assets — the WhatsApp test number
// and test WABA from the app dashboard, a test Page, a Marketing API sandbox ad account, and a Pixel's Test Events code.
// Nothing here spends money or messages a real person unless the owner passes the matching --allow:
//   effect 'message'  sends one WhatsApp / Messenger message to a recipient the owner registered for testing;
//   effect 'spend'    creates a PAUSED campaign (use a sandbox ad account; a paused campaign never delivers).
// Test events are processed by Meta ("not dropped"), so the CAPI check sends synthetic data only (TEST-NET IP, no
// customer identifiers).
import { buildServerEvent, metaCapiAdapter } from '../ads/meta-capi';
import { metaAdsAdapter } from '../ads/meta-ads';
import type { AdapterContext } from '../core';
import { GRAPH_HOST, graphRequest, META_GRAPH_VERSION, metaVersionWarnings, verifyMetaSignature } from '../meta/graph';
import { buildPageMessage, metaPagesAdapter, parseMetaPagesWebhook } from '../messaging/meta-pages';
import { buildTemplateMessage, parseWhatsAppWebhook, whatsappCloudAdapter } from '../messaging/whatsapp-cloud';
import { expectThat, registerChecks, type AcceptanceCheck, type AcceptanceContext } from './index';
import { readCaptured, runKey } from './payments-common';

const official = ['official_test'] as AcceptanceCheck['modes'];
const both = ['official_test', 'live'] as AcceptanceCheck['modes'];
const actx = (ctx: AcceptanceContext, credentials: Record<string, string>, config: Record<string, unknown> = {}): AdapterContext =>
  ({ environment: ctx.mode === 'live' ? 'live' : 'sandbox', credentials, config, fetch: ctx.adapter.fetch });

export const metaChecks: AcceptanceCheck[] = [
  // --- Platform -------------------------------------------------------------------------------------------------
  {
    id: 'meta.graph_version', provider: 'meta', capability: 'version_pin', modes: both, requires: ['META_APP_ID', 'META_APP_SECRET'], effect: 'read',
    docsUrl: 'https://developers.facebook.com/docs/graph-api/changelog/versions',
    async run(ctx) {
      expectThat(metaVersionWarnings().length === 0, `pinned version close to end of life: ${metaVersionWarnings().join(' ')}`);
      const app = await graphRequest<{ id?: string; name?: string }>('meta', ctx.adapter, ctx.env.META_APP_ID!, {
        token: `${ctx.env.META_APP_ID}|${ctx.env.META_APP_SECRET}`, query: { fields: 'id,name' } });
      ctx.evidence('app read on the pinned version', { version: META_GRAPH_VERSION, host: GRAPH_HOST, appId: app.id ?? null });
      expectThat(app.id === ctx.env.META_APP_ID, 'the app id read back does not match');
    },
  },
  // --- WhatsApp Cloud API ---------------------------------------------------------------------------------------
  {
    id: 'whatsapp.ownership', provider: 'whatsapp_cloud', capability: 'ownership_verification', modes: both,
    requires: ['WHATSAPP_TEST_TOKEN', 'WHATSAPP_TEST_WABA_ID', 'WHATSAPP_TEST_PHONE_NUMBER_ID'], effect: 'read',
    prerequisites: ['App dashboard > WhatsApp > API Setup: copy the test WABA id, the test phone number id and a token that can read them.'],
    docsUrl: 'https://developers.facebook.com/docs/whatsapp/business-management-api/manage-phone-numbers',
    async run(ctx) {
      const c = actx(ctx, { accessToken: ctx.env.WHATSAPP_TEST_TOKEN! });
      const own = await whatsappCloudAdapter.verifyPhoneOwnership(c, { wabaId: ctx.env.WHATSAPP_TEST_WABA_ID!, phoneNumberId: ctx.env.WHATSAPP_TEST_PHONE_NUMBER_ID! });
      ctx.evidence('own number', { owned: own.owned, reason: own.owned ? null : own.reason });
      expectThat(own.owned, 'the WABA does not list the test phone number for this token');
      const other = await whatsappCloudAdapter.verifyPhoneOwnership(c, { wabaId: ctx.env.WHATSAPP_TEST_WABA_ID!, phoneNumberId: '999999999999999' });
      ctx.evidence('foreign number', { owned: other.owned });
      expectThat(!other.owned, 'a number that is not in the WABA must not verify');
    },
  },
  {
    id: 'whatsapp.webhook_signature', provider: 'whatsapp_cloud', capability: 'webhooks', modes: both,
    requires: ['WHATSAPP_APP_SECRET', 'WHATSAPP_TEST_EVENT_FILE', 'WHATSAPP_TEST_EVENT_SIGNATURE'], effect: 'read',
    prerequisites: ['Capture one delivery to /v1/webhooks/whatsapp exactly as received: raw body to WHATSAPP_TEST_EVENT_FILE, X-Hub-Signature-256 to WHATSAPP_TEST_EVENT_SIGNATURE (send a message to the test number).'],
    docsUrl: 'https://developers.facebook.com/docs/graph-api/webhooks/getting-started',
    async run(ctx) {
      const raw = readCaptured(ctx.env.WHATSAPP_TEST_EVENT_FILE!);
      const ok = verifyMetaSignature(raw, ctx.env.WHATSAPP_TEST_EVENT_SIGNATURE!, ctx.env.WHATSAPP_APP_SECRET!);
      const events = ok ? parseWhatsAppWebhook(JSON.parse(raw)) : [];
      ctx.evidence('verification', { valid: ok, events: events.length, kinds: events.map((e) => e.kind) });
      expectThat(ok, 'Meta\'s delivery did not verify with the app secret');
      expectThat(!verifyMetaSignature(`${raw} `, ctx.env.WHATSAPP_TEST_EVENT_SIGNATURE!, ctx.env.WHATSAPP_APP_SECRET!), 'a modified body must not verify');
      expectThat(events.every((e) => !!e.wabaId), 'every event must carry the WABA id (entry[].id) used for routing');
    },
  },
  {
    id: 'whatsapp.send_template', provider: 'whatsapp_cloud', capability: 'send_message', modes: official,
    requires: ['WHATSAPP_TEST_TOKEN', 'WHATSAPP_TEST_PHONE_NUMBER_ID', 'WHATSAPP_TEST_RECIPIENT'], effect: 'message',
    prerequisites: ['Add your own phone as a test recipient in App dashboard > WhatsApp > API Setup; it receives the "hello_world" template.'],
    docsUrl: 'https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-message-templates',
    async run(ctx) {
      const c = actx(ctx, { accessToken: ctx.env.WHATSAPP_TEST_TOKEN! }, { phoneNumberId: ctx.env.WHATSAPP_TEST_PHONE_NUMBER_ID! });
      const r = await whatsappCloudAdapter.send(c, buildTemplateMessage(ctx.env.WHATSAPP_TEST_RECIPIENT!.replace(/^\+/, ''), 'hello_world', 'en_US'));
      ctx.evidence('template accepted', { messageIdPrefix: r.messageId.slice(0, 8) });
      expectThat(r.messageId.startsWith('wamid.'), 'a wamid message id was expected');
    },
  },
  // --- Messenger / Instagram Direct ------------------------------------------------------------------------------
  {
    id: 'meta_pages.ownership', provider: 'meta_pages', capability: 'ownership_verification', modes: both,
    requires: ['META_PAGES_TEST_TOKEN', 'META_PAGES_TEST_PAGE_ID'], effect: 'read',
    prerequisites: ['A test Page (and optionally its linked Instagram professional account: META_PAGES_TEST_IG_ID) and a Page access token.'],
    docsUrl: 'https://developers.facebook.com/docs/messenger-platform/instagram/features/send-message',
    async run(ctx) {
      const c = actx(ctx, { accessToken: ctx.env.META_PAGES_TEST_TOKEN! });
      const own = await metaPagesAdapter.verifyOwnership(c, { pageId: ctx.env.META_PAGES_TEST_PAGE_ID!, instagramAccountId: ctx.env.META_PAGES_TEST_IG_ID || null });
      ctx.evidence('page proof', { owned: own.owned, reason: own.owned ? null : own.reason, instagram: own.owned ? !!own.instagram : null });
      expectThat(own.owned, 'the token does not prove the Page (or the Instagram link)');
      const other = await metaPagesAdapter.verifyOwnership(c, { pageId: '100000000000001' });
      expectThat(!other.owned, 'another Page id must not verify with this token');
    },
  },
  {
    id: 'meta_pages.webhook_signature', provider: 'meta_pages', capability: 'webhooks', modes: both,
    requires: ['META_APP_SECRET', 'META_PAGES_TEST_EVENT_FILE', 'META_PAGES_TEST_EVENT_SIGNATURE'], effect: 'read',
    prerequisites: ['Capture one delivery to /v1/webhooks/meta (message the test Page): raw body to META_PAGES_TEST_EVENT_FILE, X-Hub-Signature-256 to META_PAGES_TEST_EVENT_SIGNATURE.'],
    docsUrl: 'https://developers.facebook.com/docs/messenger-platform/webhooks',
    async run(ctx) {
      const raw = readCaptured(ctx.env.META_PAGES_TEST_EVENT_FILE!);
      const ok = verifyMetaSignature(raw, ctx.env.META_PAGES_TEST_EVENT_SIGNATURE!, ctx.env.META_APP_SECRET!);
      const events = ok ? parseMetaPagesWebhook(JSON.parse(raw)) : [];
      ctx.evidence('verification', { valid: ok, events: events.length, kinds: events.map((e) => e.channelKind) });
      expectThat(ok, 'Meta\'s delivery did not verify with the app secret');
      expectThat(events.length > 0, 'the captured delivery contains no customer message');
    },
  },
  {
    id: 'meta_pages.send_reply', provider: 'meta_pages', capability: 'send_message', modes: official,
    requires: ['META_PAGES_TEST_TOKEN', 'META_PAGES_TEST_PAGE_ID', 'META_PAGES_TEST_PSID'], effect: 'message',
    prerequisites: ['Message the test Page from an account with a role on the app (Standard Access) within the last 24 hours; put its PSID in META_PAGES_TEST_PSID.'],
    docsUrl: 'https://developers.facebook.com/docs/messenger-platform/send-messages',
    async run(ctx) {
      const c = actx(ctx, { accessToken: ctx.env.META_PAGES_TEST_TOKEN! });
      const body = buildPageMessage('messenger', ctx.env.META_PAGES_TEST_PSID!, { type: 'buttons', body: 'Resuto acceptance check', buttons: [{ id: 'acc:ok', title: 'OK' }] },
        { windowOpen: true, humanAgent: false });
      const r = await metaPagesAdapter.send(c, ctx.env.META_PAGES_TEST_PAGE_ID!, body);
      ctx.evidence('message accepted', { messageIdPrefix: r.messageId.slice(0, 6) });
    },
  },
  // --- Marketing API ---------------------------------------------------------------------------------------------
  {
    id: 'meta_ads.ad_accounts', provider: 'meta_ads', capability: 'ad_account_picker', modes: both, requires: ['META_ADS_TEST_TOKEN', 'META_ADS_TEST_ACCOUNT_ID'], effect: 'read',
    docsUrl: 'https://developers.facebook.com/docs/marketing-api/reference/ad-account',
    async run(ctx) {
      const accounts = await metaAdsAdapter.listAccounts!(actx(ctx, { accessToken: ctx.env.META_ADS_TEST_TOKEN! }), null);
      const want = ctx.env.META_ADS_TEST_ACCOUNT_ID!.startsWith('act_') ? ctx.env.META_ADS_TEST_ACCOUNT_ID! : `act_${ctx.env.META_ADS_TEST_ACCOUNT_ID}`;
      ctx.evidence('granted accounts', { count: accounts.length, found: accounts.some((a) => a.id === want) });
      expectThat(accounts.some((a) => a.id === want), 'the test ad account is not among the token\'s ad accounts');
    },
  },
  {
    id: 'meta_ads.campaign_create_paused', provider: 'meta_ads', capability: 'campaign_create_paused', modes: official,
    requires: ['META_ADS_TEST_TOKEN', 'META_ADS_TEST_ACCOUNT_ID'], effect: 'spend',
    prerequisites: ['Use a Marketing API sandbox ad account (developer tier). The campaign is created PAUSED and tagged; delete it in Ads Manager afterwards.'],
    docsUrl: 'https://developers.facebook.com/docs/marketing-api/reference/ad-account/campaigns',
    async run(ctx) {
      const c = actx(ctx, { accessToken: ctx.env.META_ADS_TEST_TOKEN! }, { adAccountId: ctx.env.META_ADS_TEST_ACCOUNT_ID! });
      const token = runKey('acc').replace(/[^a-z0-9]/g, '').slice(-12);
      const created = await metaAdsAdapter.createCampaign(c, { name: 'Resuto acceptance (paused)', objective: 'traffic', currency: 'EGP', idempotencyToken: token });
      ctx.evidence('campaign created', { status: created.status, idPrefix: created.externalId.slice(0, 6) });
      expectThat(created.status === 'PAUSED', 'campaigns must be created paused');
      const found = await metaAdsAdapter.findCampaignByToken!(c, token);
      expectThat(found?.externalId === created.externalId, 'the launch token must find the campaign (crash recovery)');
    },
  },
  // --- Pixel + Conversions API -------------------------------------------------------------------------------------
  {
    id: 'meta_capi.health', provider: 'meta_capi', capability: 'health_check', modes: both, requires: ['META_CAPI_TEST_TOKEN', 'META_CAPI_TEST_PIXEL_ID'], effect: 'read',
    docsUrl: 'https://developers.facebook.com/docs/marketing-api/conversions-api/get-started',
    async run(ctx) {
      const h = await metaCapiAdapter.healthCheck({ environment: 'live', credentials: { accessToken: ctx.env.META_CAPI_TEST_TOKEN! },
        config: { pixelId: ctx.env.META_CAPI_TEST_PIXEL_ID! }, fetch: ctx.adapter.fetch });
      ctx.evidence('pixel read', { ok: h.ok });
      expectThat(h.ok, 'the token cannot read the Pixel / dataset');
    },
  },
  {
    id: 'meta_capi.test_event', provider: 'meta_capi', capability: 'server_events', modes: official,
    requires: ['META_CAPI_TEST_TOKEN', 'META_CAPI_TEST_PIXEL_ID', 'META_CAPI_TEST_EVENT_CODE'], effect: 'write_test',
    prerequisites: ['Events Manager > the dataset > Test events: copy the TEST… code. Keep the tab open to see the event arrive.'],
    docsUrl: 'https://developers.facebook.com/docs/marketing-api/conversions-api/using-the-api',
    async run(ctx) {
      const built = buildServerEvent({ eventName: 'Purchase', eventId: `acc.${runKey('capi')}`, eventTime: new Date(), eventSourceUrl: 'https://resuto.app/acceptance',
        user: { clientIp: '203.0.113.10', userAgent: 'Resuto acceptance check', externalId: 'resuto-acceptance' }, custom: { currency: 'EGP', valueMinor: 100 } });
      expectThat('event' in built, 'event could not be built');
      const r = await metaCapiAdapter.sendEvents({ environment: 'sandbox', credentials: { accessToken: ctx.env.META_CAPI_TEST_TOKEN! },
        config: { pixelId: ctx.env.META_CAPI_TEST_PIXEL_ID!, testEventCode: ctx.env.META_CAPI_TEST_EVENT_CODE! }, fetch: ctx.adapter.fetch }, [(built as { event: Record<string, unknown> }).event]);
      ctx.evidence('test event', { eventsReceived: r.eventsReceived, messages: r.messages.length });
      expectThat(r.eventsReceived === 1, 'Meta did not report one received event');
    },
  },
];

registerChecks(...metaChecks);
