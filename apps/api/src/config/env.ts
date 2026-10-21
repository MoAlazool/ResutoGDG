import { z } from 'zod';
import { unverifiedDatabaseTls } from '../common/db/pg-tls';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  APP_ORIGIN: z.url().default('http://localhost:3000'),
  API_ORIGIN: z.url().default('http://localhost:4000'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  DATABASE_URL: z.string().default('postgres://postgres@127.0.0.1:54329/resuto'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  /** How long a request waits for a pooled connection before failing with 503 (instead of queueing forever). */
  DATABASE_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5000),
  /** Per-transaction statement timeout (SET LOCAL, so it also works through the Supabase pooler). */
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(600_000).default(15_000),
  /** Ends a transaction left idle (e.g. awaiting a slow external call) and releases its locks. */
  DATABASE_IDLE_TX_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(30_000),
  /** CA for verified database TLS: a PEM file path or PEM text (Supabase: scripts/db/certs/supabase-prod-ca-2021.crt). */
  DATABASE_SSL_CA: z.string().optional(),
  /**
   * Express `trust proxy` (which X-Forwarded-For hop is the client): "false", a hop count or proxy addresses/CIDRs.
   * Unset: 1 in staging/production (Render's load balancer), loopback locally. See common/http/http-hardening.ts.
   */
  TRUST_PROXY: z.string().max(500).optional(),

  // Supabase Auth. HS256 projects use SUPABASE_JWT_SECRET; asymmetric (JWKS)
  // projects use SUPABASE_URL/auth/v1/.well-known/jwks.json.
  SUPABASE_URL: z.url().optional(),
  SUPABASE_JWT_SECRET: z.string().min(32).optional(),
  SUPABASE_JWT_AUDIENCE: z.string().default('authenticated'),
  /**
   * Accept HS256 (shared-secret) tokens although the project publishes a JWKS (SUPABASE_URL set). Only for Supabase
   * projects still on the legacy JWT secret; off by default so a leaked or reused secret cannot mint sessions for a
   * JWKS project (audit PS-25). Without SUPABASE_URL (local dev, tests) HS256 is the only option and stays on.
   */
  AUTH_ALLOW_HS256: bool.default(false),
  // Local-only email/password issuer that mints Supabase-compatible JWTs.
  AUTH_DEV_MODE: bool.default(false),

  // 32-byte base64 key(s) for credential encryption: "keyId:base64,keyId2:base64"; first is active.
  CREDENTIALS_KEYS: z.string().optional(),
  /**
   * Optional master(s) for purpose-bound HMAC keys (media URLs, delivery codes; common/crypto/keys.ts), comma-separated,
   * newest first, each at least 32 characters. Unset: derived from the CREDENTIALS_KEYS ring. Older entries (and the
   * CREDENTIALS_KEYS entries) still verify, so rotation never invalidates outstanding codes. Never the JWT secret.
   */
  SIGNING_KEY: z.string().optional().refine((v) => !v || v.split(',').every((k) => k.trim().length >= 32),
    'SIGNING_KEY entries must be at least 32 characters (comma-separated, newest first)'),
  AI_SERVICE_URL: z.url().default('http://127.0.0.1:8000'),
  AI_SERVICE_TOKEN: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),
  /** Required in staging/production; production must be `live` (sandbox = simulated provider, guests settle for free). */
  PAYMENT_MODE: z.enum(['sandbox', 'live']).optional(),
  /**
   * Resuto Connect sandbox transport (simulated WhatsApp channels and the staff inbound simulator, which can drive the
   * ordering bot into real orders). Default: on outside production, off in production, where enabling it is refused.
   */
  CONNECT_SANDBOX: bool.optional(),
  /** Runs the outbox/job loop inside the API process (single-service hosting without a separate worker). */
  RUN_WORKER_IN_PROCESS: bool.default(false),
  /** Required in staging/production; production must be `supabase` (local disk is ephemeral and not shared). */
  STORAGE_DRIVER: z.enum(['local', 'supabase']).optional(),
  STORAGE_LOCAL_DIR: z.string().default('.local/storage'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  // ResutoStudio custom domains (read by the studio module's domain provider).
  DOMAIN_PROVIDER: z.enum(['manual', 'vercel']).default('manual'),
  VERCEL_TOKEN: z.string().optional(),
  VERCEL_PROJECT_ID: z.string().optional(),
  VERCEL_TEAM_ID: z.string().optional(),
  DOMAIN_CNAME_TARGET: z.string().optional(),
  DOMAIN_A_RECORD: z.string().optional(),
  RESERVED_HOST_SUFFIXES: z.string().optional(),
  // Platform-level ad app credentials for merchant OAuth (each restaurant connects its own ad account).
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  /**
   * OAuth 2.1 for MCP clients (FT-17). Issuer = the Resuto MCP server's public origin (it serves the authorization
   * server metadata and forwards /oauth/* to the API); resources = the MCP endpoint URI(s) tokens may be issued for,
   * comma-separated (e.g. https://mcp.example.com/mcp). Both unset: OAuth is off and only connection keys work.
   */
  MCP_OAUTH_ISSUER: z.url().optional(),
  MCP_OAUTH_RESOURCES: z.string().optional(),
  TIKTOK_APP_ID: z.string().optional(),
  TIKTOK_APP_SECRET: z.string().optional(),
  SNAPCHAT_CLIENT_ID: z.string().optional(),
  SNAPCHAT_CLIENT_SECRET: z.string().optional(),
  /**
   * FT-22 Web Push for the driver app: one VAPID key pair per environment (base64url raw P-256 public key and private
   * scalar) and a contact (mailto: or https:). Unset: drivers are told notifications are unavailable; nothing is sent.
   */
  WEB_PUSH_VAPID_PUBLIC_KEY: z.string().optional(),
  WEB_PUSH_VAPID_PRIVATE_KEY: z.string().optional(),
  WEB_PUSH_SUBJECT: z.string().optional(),
  /**
   * Observability without a paid service (CR-14). ERROR_TRACKING_DSN: a Sentry-compatible DSN
   * (https://<key>@<host>/<project>); unset = error reporting off. HEALTH_DETAILS_TOKEN: bearer token (24+ characters)
   * that lets an uptime monitor read /v1/health/details; platform admins can always read it. LOG_FORMAT: one JSON
   * object per line on stdout (default in staging and production) or Nest's text logger (default locally).
   */
  ERROR_TRACKING_DSN: z.url().optional(),
  HEALTH_DETAILS_TOKEN: z.string().min(24).optional(),
  LOG_FORMAT: z.enum(['json', 'text']).optional(),
}).superRefine((env, ctx) => {
  // Deployed environments (staging included) only trust Supabase Auth.
  const deployed = env.NODE_ENV === 'production' || env.NODE_ENV === 'staging';
  if (env.AUTH_DEV_MODE && deployed) {
    ctx.addIssue({ code: 'custom', path: ['AUTH_DEV_MODE'], message: `AUTH_DEV_MODE must never be enabled in ${env.NODE_ENV}` });
  }
  if (deployed && !env.SUPABASE_URL) {
    ctx.addIssue({ code: 'custom', path: ['SUPABASE_URL'], message: `SUPABASE_URL is required in ${env.NODE_ENV}` });
  }
  if (!env.SUPABASE_JWT_SECRET && !env.SUPABASE_URL) {
    ctx.addIssue({ code: 'custom', path: ['SUPABASE_JWT_SECRET'], message: 'Configure SUPABASE_JWT_SECRET or SUPABASE_URL (JWKS)' });
  }
  if (env.DOMAIN_PROVIDER === 'vercel' && (!env.VERCEL_TOKEN || !env.VERCEL_PROJECT_ID)) {
    ctx.addIssue({ code: 'custom', path: ['DOMAIN_PROVIDER'], message: 'DOMAIN_PROVIDER=vercel needs VERCEL_TOKEN and VERCEL_PROJECT_ID' });
  }
  const tls = deployed ? unverifiedDatabaseTls(env.DATABASE_URL, env.DATABASE_SSL_CA) : null;
  if (tls) {
    ctx.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: `${env.NODE_ENV}: ${tls}` });
  }
  if (deployed && !env.CREDENTIALS_KEYS) {
    ctx.addIssue({ code: 'custom', path: ['CREDENTIALS_KEYS'], message: `CREDENTIALS_KEYS is required in ${env.NODE_ENV}` });
  }
  if (deployed && env.STORAGE_DRIVER === 'supabase' && !env.SUPABASE_SERVICE_ROLE_KEY) {
    ctx.addIssue({ code: 'custom', path: ['SUPABASE_SERVICE_ROLE_KEY'], message: 'STORAGE_DRIVER=supabase needs SUPABASE_SERVICE_ROLE_KEY' });
  }
  // Deployed environments choose payment and storage modes explicitly; the development defaults never apply there.
  if (deployed && !env.PAYMENT_MODE) {
    ctx.addIssue({ code: 'custom', path: ['PAYMENT_MODE'], message: `PAYMENT_MODE must be set explicitly in ${env.NODE_ENV} (live, or sandbox for staging)` });
  }
  if (env.NODE_ENV === 'production' && env.PAYMENT_MODE === 'sandbox') {
    ctx.addIssue({ code: 'custom', path: ['PAYMENT_MODE'], message: 'PAYMENT_MODE=sandbox (simulated payments) is refused in production; use live' });
  }
  if (deployed && !env.STORAGE_DRIVER) {
    ctx.addIssue({ code: 'custom', path: ['STORAGE_DRIVER'], message: `STORAGE_DRIVER must be set explicitly in ${env.NODE_ENV}` });
  }
  if (env.NODE_ENV === 'production' && env.STORAGE_DRIVER === 'local') {
    ctx.addIssue({ code: 'custom', path: ['STORAGE_DRIVER'], message: 'STORAGE_DRIVER=local is refused in production; use supabase' });
  }
  if (env.NODE_ENV === 'production' && env.CONNECT_SANDBOX === true) {
    ctx.addIssue({ code: 'custom', path: ['CONNECT_SANDBOX'], message: 'CONNECT_SANDBOX (simulated WhatsApp channels) is refused in production' });
  }
}).transform((env) => ({
  ...env,
  CONNECT_SANDBOX: env.CONNECT_SANDBOX ?? env.NODE_ENV !== 'production',
  PAYMENT_MODE: env.PAYMENT_MODE ?? ('sandbox' as const),
  STORAGE_DRIVER: env.STORAGE_DRIVER ?? ('local' as const),
}));
export type Env = z.output<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const ENV = Symbol('ENV');
