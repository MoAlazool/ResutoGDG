import { z } from 'zod';

const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const schema = z.object({
  RESUTO_API_URL: z.url().default('http://127.0.0.1:4000'),
  MCP_HOST: z.string().default('127.0.0.1'),
  MCP_PORT: z.coerce.number().int().min(1).max(65535).default(7100),
  /** Public HTTPS URL of this server (shown in logs and used for Host validation when set). */
  MCP_PUBLIC_URL: z.url().optional(),
  /** Browser origins allowed to call /mcp. Requests without an Origin header (server-side clients) are allowed. */
  MCP_ALLOWED_ORIGINS: z.string().optional(),
  /** Host header values accepted (DNS-rebinding protection). Defaults to localhost names when bound to loopback. */
  MCP_ALLOWED_HOSTS: z.string().optional(),
  MCP_MAX_BODY_BYTES: z.coerce.number().int().min(1024).max(4 * 1024 * 1024).default(256 * 1024),
  MCP_SESSION_IDLE_MINUTES: z.coerce.number().int().min(1).max(24 * 60).default(30),
  MCP_MAX_SESSIONS: z.coerce.number().int().min(1).max(100_000).default(1000),
  MCP_API_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(30_000),
  RESUTO_MCP_KEY: z.string().optional(),
  /** Accept the key as a URL path segment (/mcp/<rmcp_key>) for clients without custom-header support. Off by default. */
  MCP_ALLOW_URL_KEY: z.enum(['true', 'false', '1', '0']).default('false').transform((v) => v === 'true' || v === '1'),
  /**
   * OAuth 2.1 for MCP clients (MCP authorization spec 2026-07-28): this server becomes the protected resource and
   * the public face of the authorization server (metadata, /oauth/authorize, /oauth/token, /oauth/register,
   * /oauth/revoke, all backed by the Resuto API). The API must list this server's resource in MCP_OAUTH_RESOURCES and
   * its origin in MCP_OAUTH_ISSUER. Connection keys keep working either way.
   */
  MCP_OAUTH_ENABLED: z.enum(['true', 'false', '1', '0']).default('false').transform((v) => v === 'true' || v === '1'),
});

export interface Config {
  apiUrl: string;
  host: string;
  port: number;
  publicUrl: string | null;
  allowedOrigins: string[];
  /** null = do not validate Host (only when explicitly bound to a public interface without MCP_ALLOWED_HOSTS/MCP_PUBLIC_URL). */
  allowedHosts: string[] | null;
  maxBodyBytes: number;
  sessionIdleMs: number;
  maxSessions: number;
  apiTimeoutMs: number;
  stdioKey: string | null;
  allowUrlKey: boolean;
  /** OAuth: issuer (this server's public origin) and the canonical resource URI of the /mcp endpoint; null when off. */
  oauth: { issuer: string; resource: string; resourceMetadataUrl: string } | null;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid ResutoMCP configuration:\n${parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  const e = parsed.data;
  const publicUrl = e.MCP_PUBLIC_URL ?? null;
  let allowedHosts: string[] | null = list(e.MCP_ALLOWED_HOSTS);
  if (!allowedHosts.length) {
    if (publicUrl) allowedHosts = [new URL(publicUrl).host];
    else if (LOOPBACK.has(e.MCP_HOST)) allowedHosts = [`127.0.0.1:${e.MCP_PORT}`, `localhost:${e.MCP_PORT}`, `[::1]:${e.MCP_PORT}`];
    else allowedHosts = null;
  }
  const origin = (publicUrl ? new URL(publicUrl).origin : `http://${e.MCP_HOST === '0.0.0.0' ? '127.0.0.1' : e.MCP_HOST}:${e.MCP_PORT}`).toLowerCase();
  return {
    oauth: e.MCP_OAUTH_ENABLED
      ? { issuer: origin, resource: `${origin}/mcp`, resourceMetadataUrl: `${origin}/.well-known/oauth-protected-resource/mcp` }
      : null,
    apiUrl: e.RESUTO_API_URL.replace(/\/$/, ''),
    host: e.MCP_HOST,
    port: e.MCP_PORT,
    publicUrl,
    allowedOrigins: list(e.MCP_ALLOWED_ORIGINS),
    allowedHosts,
    maxBodyBytes: e.MCP_MAX_BODY_BYTES,
    sessionIdleMs: e.MCP_SESSION_IDLE_MINUTES * 60_000,
    maxSessions: e.MCP_MAX_SESSIONS,
    apiTimeoutMs: e.MCP_API_TIMEOUT_MS,
    stdioKey: e.RESUTO_MCP_KEY ?? null,
    allowUrlKey: e.MCP_ALLOW_URL_KEY,
  };
}
