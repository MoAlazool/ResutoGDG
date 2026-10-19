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
  /** CA for verified database TLS: a PEM file path or PEM text (Supabase: scripts/db/certs/supabase-prod-ca-2021.crt). */
  DATABASE_SSL_CA: z.string().optional(),
  REDIS_URL: z.string().optional(),

  // Supabase Auth. HS256 projects use SUPABASE_JWT_SECRET; asymmetric (JWKS)
  // projects use SUPABASE_URL/auth/v1/.well-known/jwks.json.
  SUPABASE_URL: z.url().optional(),
  SUPABASE_JWT_SECRET: z.string().min(32).optional(),
  SUPABASE_JWT_AUDIENCE: z.string().default('authenticated'),
  // Local-only email/password issuer that mints Supabase-compatible JWTs.
  AUTH_DEV_MODE: bool.default(false),

  // 32-byte base64 key(s) for credential encryption: "keyId:base64,keyId2:base64"; first is active.
  CREDENTIALS_KEYS: z.string().optional(),
  AI_SERVICE_URL: z.url().default('http://127.0.0.1:8000'),
  AI_SERVICE_TOKEN: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),
  PAYMENT_MODE: z.enum(['sandbox', 'live']).default('sandbox'),
  /** Runs the outbox/job loop inside the API process (single-service hosting without a separate worker). */
  RUN_WORKER_IN_PROCESS: bool.default(false),
  MCP_INTERNAL_TOKEN: z.string().min(24).optional(),
  STORAGE_DRIVER: z.enum(['local', 'supabase']).default('local'),
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
  TIKTOK_APP_ID: z.string().optional(),
  TIKTOK_APP_SECRET: z.string().optional(),
  SNAPCHAT_CLIENT_ID: z.string().optional(),
  SNAPCHAT_CLIENT_SECRET: z.string().optional(),
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
});
export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const ENV = Symbol('ENV');
