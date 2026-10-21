import { Injectable } from '@nestjs/common';
import { STUDIO_AI_PROVIDER, type StudioAiCapabilities } from '@resuto/contracts';
import { GEMINI_BYOK_DEFAULT_MODEL } from '@resuto/integrations';
import type { TenantContext } from '../../../common/auth/context';
import { DomainError } from '../../../common/errors/domain-error';
import { sharpAvailable } from '../../../common/storage/image-enhance';
import { IntegrationConnectionsService } from '../../integrations/connections.service';

/** A usable restaurant-owned model key (decrypted only for the call that needs it; never logged or returned). */
export interface ByokModel {
  connectionId: string;
  apiKey: string;
  model: string;
  environment: 'sandbox' | 'live';
  fetch: typeof fetch;
}

const MODEL_RE = /^[a-z0-9][a-z0-9.\-]{1,60}$/;

export const aiNotConfigured = () => new DomainError('ai_not_configured',
  'Reading photos and PDFs needs your own Google Gemini key. Connect it in Integrations (Google Gemini), or paste the menu text or a CSV instead.', 409);

/**
 * Studio AI capability report and BYOK key resolution (ws9). Resuto does not pay for model calls in Studio: a model is
 * used only through the restaurant's own `gemini_byok` connection, and only while that connection is enabled and has
 * passed its health check ("connected"). Everything else reports "not configured" and the deterministic paths remain.
 */
@Injectable()
export class StudioAiService {
  constructor(private readonly connections: IntegrationConnectionsService) {}

  /** The restaurant's own model, or null when not configured (no connection, disabled, not yet verified, no key). */
  async byok(orgId: string): Promise<ByokModel | null> {
    let conn;
    try {
      conn = await this.connections.load(orgId, { provider: STUDIO_AI_PROVIDER });
    } catch (e) {
      if (e instanceof DomainError && e.status === 404) return null;
      throw e;
    }
    const apiKey = conn.adapter.credentials.apiKey;
    if (!conn.enabled || conn.status !== 'connected' || !apiKey) return null;
    const configured = typeof conn.config.model === 'string' && MODEL_RE.test(conn.config.model) ? conn.config.model : GEMINI_BYOK_DEFAULT_MODEL;
    return { connectionId: conn.id, apiKey, model: configured, environment: conn.environment, fetch: conn.adapter.fetch };
  }

  async capabilities(ctx: TenantContext): Promise<StudioAiCapabilities> {
    const m = await this.byok(ctx.orgId);
    return {
      byok: { provider: STUDIO_AI_PROVIDER, configured: !!m, connectionId: m?.connectionId ?? null, model: m?.model ?? null, environment: m?.environment ?? null },
      menuExtraction: { text: true, csv: true, image: !!m, pdf: !!m, floorPlan: false },
      photoEnhancement: {
        deterministic: sharpAvailable(), generative: false,
        generativeReason: 'Generative photo edits are not configured: no image-editing provider is connected, and edits that could change a dish are not offered by default.',
      },
    };
  }
}
