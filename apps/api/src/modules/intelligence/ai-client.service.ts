import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, type Env } from '../../config/env';
import type { TenantContext } from '../../common/auth/context';
import type { Tx } from '../../common/db/db.service';
import { DomainError } from '../../common/errors/domain-error';

export const AI_TIMEOUT_MS = { default: 20_000, forecast: 45_000, health: 2_000 } as const;

const unavailable = (detail: string) =>
  new DomainError('ai_service_unavailable', 'Resuto Intelligence is temporarily unavailable. Try again shortly.', 503, { detail });

/**
 * HTTP client for the stateless Python AI service (apps/ai-service). Only minimal, tenant-scoped
 * data (ids, quantities, amounts, timestamps) is sent. Calls are made outside database
 * transactions; callers record usage afterwards with `recordUsage`.
 */
@Injectable()
export class AiServiceClient {
  private readonly logger = new Logger('AiService');
  private readonly base: string;
  private readonly token: string | undefined;

  constructor(@Inject(ENV) env: Env) {
    this.base = env.AI_SERVICE_URL.replace(/\/$/, '');
    this.token = env.AI_SERVICE_TOKEN;
  }

  get configured() {
    return !!this.token;
  }

  async post<T>(path: string, body: unknown, timeoutMs: number = AI_TIMEOUT_MS.default): Promise<T> {
    if (!this.token) {
      throw new DomainError('ai_service_not_configured', 'Resuto Intelligence is not configured on this server (AI_SERVICE_TOKEN).', 503);
    }
    let res: Response;
    try {
      res = await fetch(`${this.base}/v1${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      this.logger.warn(`AI service ${path} unreachable: ${(error as Error).message}`);
      throw unavailable((error as Error).name === 'TimeoutError' ? 'timeout' : 'unreachable');
    }
    if (res.status >= 500 || res.status === 401) {
      this.logger.warn(`AI service ${path} answered ${res.status}`);
      throw unavailable(`status_${res.status}`);
    }
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      // A 4xx means our request broke the service's input limits: surface it, never retry blindly.
      throw new DomainError('ai_request_rejected', 'The intelligence service rejected the request (input too large or invalid).', 422,
        { status: res.status, detail: (json as any)?.detail ?? null });
    }
    return json as T;
  }

  async health(): Promise<{ reachable: boolean; version?: string; latencyMs?: number }> {
    const t0 = Date.now();
    try {
      const res = await fetch(`${this.base}/v1/health`, { signal: AbortSignal.timeout(AI_TIMEOUT_MS.health) });
      if (!res.ok) return { reachable: false };
      const j = (await res.json()) as { version?: string };
      return { reachable: true, version: j.version, latencyMs: Date.now() - t0 };
    } catch {
      return { reachable: false };
    }
  }
}

/** Usage metering (MODULE_CONTRACTS §5 exception): one `ai_requests` row per AI call. */
export async function recordUsage(tx: Tx, ctx: TenantContext, metadata: {
  endpoint: string; provider: 'resuto-ai-service' | 'gemini';
  /** INT-30: token counts the provider reported for the call (kept with the metered request for cost review). */
  usage?: { promptTokens: number; outputTokens: number; totalTokens: number } | null;
}) {
  await tx.query(
    `insert into usage_events(org_id, metric, quantity, cost_owner, metadata) values ($1, 'ai_requests', 1, 'resuto', $2)`,
    [ctx.orgId, { ...metadata, actor: `${ctx.actorType}:${ctx.actorId}` }]);
}
