import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import {
  PLATFORM_APP_CONFIG_KEYS, PLATFORM_APP_PROVIDERS, PLATFORM_APP_SECRET_KEYS,
  type AdminProviderAppView, type PlatformAppProvider, type ProviderAppInput, type ProviderAppReviewStatus, type ReviewRequirement,
} from '@resuto/contracts';
import { SecretBox } from '../../common/crypto/secret-box';
import { DbService, type Tx } from '../../common/db/db.service';
import { forbidden, invalid, notFound } from '../../common/errors/domain-error';
import { ENV, type Env } from '../../config/env';
import { oauthRedirectUri } from './oauth-apps';
import { activePlatformApp, platformAppRecord, setPlatformAppRecords, type PlatformAppRecord } from './platform-apps';

/** Refresh interval of the in-memory copy, so every API and worker process follows a console save within a minute. */
const REFRESH_MS = 60_000;

const sealAad = (provider: string) => `platform-provider-app:${provider}`;

interface AppMeta {
  name: string;
  /** Restaurant integrations this app serves. */
  serves: string[];
  env: { appId: string; secrets: Record<string, string[]>; configIds: Record<string, string>; environment?: string };
  redirects: string[];
  webhooks: (origin: string) => Array<{ url: string; purpose: string }>;
  requirements: ReviewRequirement[];
  reviewPermissions: string[];
  /** docs/OPEN_BLOCKERS.md */
  blockers: string[];
  /** Secrets and config ids that must be set before the app works end to end. */
  needed: { secrets: string[]; configIds: string[] };
}

/**
 * What each platform app needs, where to register it and which environment variables it replaces. Sourced from
 * docs/INTEGRATION_READINESS.md ("Owner actions before going live (Meta)", Foodics INT-24, ads INT-11).
 */
const APPS: Record<PlatformAppProvider, AppMeta> = {
  meta: {
    name: 'Meta (Facebook Login for Business, Marketing API, Messenger, Instagram, WhatsApp Embedded Signup)',
    serves: ['meta_ads', 'meta_pages', 'whatsapp_cloud'],
    env: {
      appId: 'META_APP_ID',
      // The platform WhatsApp webhook is signed with the Meta app's secret (WHATSAPP_APP_SECRET in the environment).
      secrets: { appSecret: ['META_APP_SECRET', 'WHATSAPP_APP_SECRET'], webhookVerifyToken: ['META_WEBHOOK_VERIFY_TOKEN'], whatsappVerifyToken: ['WHATSAPP_VERIFY_TOKEN'] },
      configIds: { adsLoginConfigId: 'META_ADS_LOGIN_CONFIG_ID', pagesLoginConfigId: 'META_PAGES_LOGIN_CONFIG_ID', whatsappSignupConfigId: 'WHATSAPP_ES_CONFIG_ID' },
    },
    redirects: ['meta_ads', 'meta_pages'],
    webhooks: (o) => [
      { url: `${o}/v1/webhooks/whatsapp`, purpose: 'whatsapp' },
      { url: `${o}/v1/webhooks/meta`, purpose: 'page_instagram' },
    ],
    requirements: ['tech_provider', 'app_review', 'business_verification'],
    reviewPermissions: ['whatsapp_business_management', 'whatsapp_business_messaging', 'pages_messaging', 'pages_manage_metadata', 'pages_show_list', 'instagram_basic',
      'instagram_manage_messages', 'human_agent', 'ads_management', 'ads_read', 'business_management'],
    blockers: ['B-4', 'B-5'],
    needed: { secrets: ['appSecret', 'webhookVerifyToken', 'whatsappVerifyToken'], configIds: ['whatsappSignupConfigId'] },
  },
  tiktok_ads: {
    name: 'TikTok for Business (Marketing API)',
    serves: ['tiktok_ads'],
    env: { appId: 'TIKTOK_APP_ID', secrets: { appSecret: ['TIKTOK_APP_SECRET'] }, configIds: {} },
    redirects: ['tiktok_ads'],
    webhooks: () => [],
    requirements: ['app_review', 'ad_account_access'],
    reviewPermissions: ['Ads Management', 'Reporting'],
    blockers: ['B-5', 'B-21'],
    needed: { secrets: ['appSecret'], configIds: [] },
  },
  snapchat_ads: {
    name: 'Snapchat Marketing API',
    serves: ['snapchat_ads'],
    env: { appId: 'SNAPCHAT_CLIENT_ID', secrets: { appSecret: ['SNAPCHAT_CLIENT_SECRET'] }, configIds: {} },
    redirects: ['snapchat_ads'],
    webhooks: () => [],
    requirements: ['ad_account_access'],
    reviewPermissions: ['snapchat-marketing-api'],
    blockers: ['B-5'],
    needed: { secrets: ['appSecret'], configIds: [] },
  },
  foodics: {
    name: 'Foodics (developer app)',
    serves: ['foodics'],
    env: { appId: 'FOODICS_CLIENT_ID', secrets: { appSecret: ['FOODICS_CLIENT_SECRET'], webhookToken: ['FOODICS_WEBHOOK_TOKEN'] }, configIds: {}, environment: 'FOODICS_OAUTH_ENV' },
    redirects: ['foodics'],
    // The secret path segment is never shown: the operator pastes the token they saved.
    webhooks: (o) => [{ url: `${o}/v1/webhooks/foodics/<webhook token>`, purpose: 'foodics_menu' }],
    requirements: ['partner_app'],
    reviewPermissions: ['general.read'],
    blockers: ['B-7'],
    needed: { secrets: ['appSecret', 'webhookToken'], configIds: [] },
  },
};

const has = (name: string) => !!process.env[name]?.trim();
/** "…4f2a" for long values, "••••" otherwise: enough to recognise a secret, never enough to use it. */
const hint = (v: string) => (v.length >= 12 ? `…${v.slice(-4)}` : '••••');

interface Row {
  provider: PlatformAppProvider; environment: 'sandbox' | 'live'; app_id: string | null; config_ids: Record<string, string>; secrets_sealed: string | null;
  secrets_hint: Record<string, string>; review_status: ProviderAppReviewStatus; notes: string | null; updated_at: Date | null;
}

/**
 * Operator console for Resuto's provider apps (21-INT). Rows live in platform_provider_apps (platform-only RLS); secrets
 * are sealed with the key ring and never leave the API after a save. The decrypted copy lives in memory
 * (platform-apps.ts) and replaces the environment variables wherever an app is usable.
 */
@Injectable()
export class PlatformProviderAppsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('PlatformProviderApps');
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly db: DbService, private readonly box: SecretBox, @Inject(ENV) private readonly env: Env) {}

  async onApplicationBootstrap() {
    await this.refresh().catch((e) => this.logger.warn(`provider apps not loaded (environment variables apply): ${(e as Error).message}`));
    this.timer = setInterval(() => { void this.refresh().catch(() => undefined); }, REFRESH_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Reloads the decrypted apps into memory. A row that cannot be opened (rotated-out key) is skipped, loudly. */
  async refresh() {
    const rows = await this.db.withPlatform((tx) => this.rows(tx));
    const records: PlatformAppRecord[] = [];
    for (const r of rows) {
      let secrets: Record<string, string> = {};
      try {
        secrets = r.secrets_sealed ? this.box.openJson<Record<string, string>>(r.secrets_sealed, sealAad(r.provider)) : {};
      } catch {
        this.logger.error(`platform_provider_apps.${r.provider}: sealed secrets cannot be opened with the configured keys; the environment applies`);
        continue;
      }
      records.push({ provider: r.provider, environment: r.environment, appId: r.app_id, configIds: r.config_ids ?? {}, secrets, reviewStatus: r.review_status });
    }
    setPlatformAppRecords(records);
    return records.length;
  }

  private rows(tx: Tx) {
    return tx.query<Row>(`select provider, environment, app_id, config_ids, secrets_sealed, secrets_hint, review_status, notes, updated_at from platform_provider_apps`);
  }

  async list(): Promise<{ items: AdminProviderAppView[] }> {
    const { rows, verifications } = await this.db.withPlatform(async (tx) => ({
      rows: await this.rows(tx),
      verifications: await tx.query<{ provider: string; n: number; last: Date | null }>(
        `select provider, count(*)::int as n, max(ran_at) as last from integration_verifications where status = 'passed' group by provider`),
    }));
    return { items: PLATFORM_APP_PROVIDERS.map((p) => this.view(p, rows.find((r) => r.provider === p) ?? null, verifications)) };
  }

  async get(provider: string) {
    const p = this.provider(provider);
    return (await this.list()).items.find((i) => i.provider === p)!;
  }

  private provider(provider: string): PlatformAppProvider {
    if (!(PLATFORM_APP_PROVIDERS as readonly string[]).includes(provider)) throw notFound('Provider app');
    return provider as PlatformAppProvider;
  }

  /** Creates or updates one app (superadmins). Omitted fields keep their value; null clears. Audited without values. */
  async save(userId: string, provider: string, input: ProviderAppInput) {
    const p = this.provider(provider);
    const allowedSecrets = PLATFORM_APP_SECRET_KEYS[p];
    const allowedConfig = PLATFORM_APP_CONFIG_KEYS[p];
    const badSecret = Object.keys(input.secrets ?? {}).filter((k) => !allowedSecrets.includes(k));
    const badConfig = Object.keys(input.configIds ?? {}).filter((k) => !allowedConfig.includes(k));
    if (badSecret.length || badConfig.length) {
      throw invalid('provider_app_unknown_field', `Unknown fields for ${p}: ${[...badSecret, ...badConfig].join(', ')}`, { secrets: badSecret, configIds: badConfig });
    }
    const token = input.secrets?.webhookToken;
    if (p === 'foodics' && typeof token === 'string' && !/^[A-Za-z0-9_-]{24,200}$/.test(token)) {
      throw invalid('provider_app_webhook_token_weak', 'The Foodics webhook token must be 24 to 200 letters, digits, "_" or "-".');
    }
    await this.db.withPlatform(async (tx) => {
      const role = (await tx.maybeOne<{ role: string }>('select role from platform_admins where user_id = $1', [userId]))?.role;
      if (role !== 'superadmin') throw forbidden('Platform superadmins only');
      const prev = await tx.maybeOne<Row>(`select provider, environment, app_id, config_ids, secrets_sealed, secrets_hint, review_status, notes, updated_at
          from platform_provider_apps where provider = $1 for update`, [p]);
      const secrets: Record<string, string> = prev?.secrets_sealed ? this.box.openJson<Record<string, string>>(prev.secrets_sealed, sealAad(p)) : {};
      for (const [k, v] of Object.entries(input.secrets ?? {})) { if (v === null) delete secrets[k]; else secrets[k] = v; }
      const configIds: Record<string, string> = { ...(prev?.config_ids ?? {}) };
      for (const [k, v] of Object.entries(input.configIds ?? {})) { if (v === null) delete configIds[k]; else configIds[k] = v; }
      const hints = Object.fromEntries(Object.entries(secrets).map(([k, v]) => [k, hint(v)]));
      await tx.query(
        `insert into platform_provider_apps(provider, environment, app_id, config_ids, secrets_sealed, secrets_hint, review_status, notes, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (provider) do update set environment = excluded.environment, app_id = excluded.app_id, config_ids = excluded.config_ids,
           secrets_sealed = excluded.secrets_sealed, secrets_hint = excluded.secrets_hint, review_status = excluded.review_status, notes = excluded.notes,
           updated_by = excluded.updated_by`,
        [p, input.environment ?? prev?.environment ?? 'live', input.appId !== undefined ? input.appId : prev?.app_id ?? null, configIds,
          Object.keys(secrets).length ? this.box.sealJson(secrets, sealAad(p)) : null, hints, input.reviewStatus ?? prev?.review_status ?? 'unknown',
          input.notes !== undefined ? input.notes : prev?.notes ?? null, userId]);
      // Field names only: never a value, not even a hint.
      await tx.query(`insert into audit_logs(org_id, actor_type, actor_id, action, entity_type, entity_id, source, metadata)
          values (null, 'platform_admin', $1, 'platform.provider_app_saved', 'platform_provider_app', $2, 'api', $3)`,
        [userId, p, { platformRole: role, fields: Object.keys(input), secrets: Object.keys(input.secrets ?? {}), configIds: Object.keys(input.configIds ?? {}) }]);
    }, `platform_admin:${userId}`);
    await this.refresh();
    return this.get(p);
  }

  /** Deletes the console record (superadmins): the environment variables apply again. */
  async remove(userId: string, provider: string) {
    const p = this.provider(provider);
    await this.db.withPlatform(async (tx) => {
      const role = (await tx.maybeOne<{ role: string }>('select role from platform_admins where user_id = $1', [userId]))?.role;
      if (role !== 'superadmin') throw forbidden('Platform superadmins only');
      await tx.query(`delete from platform_provider_apps where provider = $1`, [p]);
      await tx.query(`insert into audit_logs(org_id, actor_type, actor_id, action, entity_type, entity_id, source, metadata)
          values (null, 'platform_admin', $1, 'platform.provider_app_deleted', 'platform_provider_app', $2, 'api', $3)`, [userId, p, { platformRole: role }]);
    }, `platform_admin:${userId}`);
    await this.refresh();
    return this.get(p);
  }

  private view(p: PlatformAppProvider, row: Row | null, verifications: Array<{ provider: string; n: number; last: Date | null }>): AdminProviderAppView {
    const meta = APPS[p];
    const origin = this.env.API_ORIGIN.replace(/\/$/, '');
    const active = activePlatformApp(p);
    const record = platformAppRecord(p);
    const envSecret = (k: string) => (meta.env.secrets[k] ?? []).some(has);
    const envComplete = has(meta.env.appId) && envSecret('appSecret');
    const source: AdminProviderAppView['source'] = active ? 'database' : envComplete ? 'environment' : 'none';
    const fromDb = !!row;
    const secrets = Object.fromEntries(PLATFORM_APP_SECRET_KEYS[p].map((k) => {
      if (fromDb) return [k, { set: !!row!.secrets_hint?.[k], hint: row!.secrets_hint?.[k] ?? null }];
      return [k, { set: envSecret(k), hint: null }];
    }));
    const configIds = Object.fromEntries(PLATFORM_APP_CONFIG_KEYS[p].map((k) => [k, fromDb ? row!.config_ids?.[k] ?? null : process.env[meta.env.configIds[k] ?? '']?.trim() || null]));
    const appId = fromDb ? row!.app_id : process.env[meta.env.appId]?.trim() || null;
    const environment = fromDb ? row!.environment : meta.env.environment ? (process.env[meta.env.environment] === 'live' ? 'live' : 'sandbox') : 'live';
    const reviewStatus = row?.review_status ?? record?.reviewStatus ?? 'unknown';
    const passed = verifications.filter((v) => meta.serves.includes(v.provider));
    const acceptance = { passed: passed.reduce((n, v) => n + v.n, 0), lastPassedAt: passed.map((v) => v.last).filter(Boolean).map((d) => new Date(d!).toISOString()).sort().at(-1) ?? null };
    const checklist = [
      { key: 'app_id', done: !!appId },
      { key: 'app_secret', done: !!secrets.appSecret?.set },
      ...meta.needed.configIds.map((k) => ({ key: `config.${k}`, done: !!configIds[k] })),
      ...meta.needed.secrets.filter((k) => k !== 'appSecret').map((k) => ({ key: `secret.${k}`, done: !!secrets[k]?.set })),
      { key: 'review_approved', done: reviewStatus === 'approved' },
      { key: 'acceptance_recorded', done: acceptance.passed > 0 },
    ];
    const fallbackVars = [meta.env.appId, ...Object.values(meta.env.secrets).flat(), ...Object.values(meta.env.configIds), ...(meta.env.environment ? [meta.env.environment] : [])];
    return {
      provider: p, name: meta.name, source, environment, appId, configIds, secrets, reviewStatus, notes: row?.notes ?? null,
      updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
      environmentFallback: [...new Set(fallbackVars)].map((name) => ({ name, set: has(name) })),
      redirectUris: meta.redirects.map((r) => oauthRedirectUri(origin, r)), webhooks: meta.webhooks(origin),
      serves: meta.serves, requirements: meta.requirements, reviewPermissions: meta.reviewPermissions, checklist, acceptance, blockers: meta.blockers,
    };
  }
}
