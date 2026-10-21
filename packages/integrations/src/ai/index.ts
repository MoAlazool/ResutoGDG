// Restaurant-owned AI model keys (BYOK) for Studio AI (ws9): menu extraction from photos/PDFs and, later, image work.
//
// Resuto does not fund these calls: the restaurant connects its own Google AI Studio (Gemini API) key in
// Integrations, the key is sealed like every other credential (aad "<orgId>:gemini_byok"), and Studio features that
// need a model are offered only while that connection is enabled. Without it they report "not configured" and the
// deterministic paths (text/CSV menu parser, local photo enhancement) stay available.
import { providerRequest, type AdapterContext, type HealthCheckResult, type ProviderDescriptor } from '../core';

export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
/** Default model for vision extraction (multimodal input, JSON output). The connection's config.model overrides it. */
export const GEMINI_BYOK_DEFAULT_MODEL = 'gemini-2.5-flash';

export const geminiByokDescriptor: ProviderDescriptor = {
  id: 'gemini_byok',
  name: 'Google Gemini (your own API key)',
  category: 'ai',
  countries: ['EG', 'SA'],
  authType: 'api_key',
  readiness: 'implemented_unverified',
  activation: [
    'Create an API key in Google AI Studio (https://aistudio.google.com/apikey) on the restaurant\'s own Google account.',
    'Paste it in Resuto → Integrations → Google Gemini. Usage is billed by Google to that account, not by Resuto.',
    'Run the health check; Studio menu extraction from photos and PDFs becomes available while the connection is enabled.',
  ],
  docsUrl: 'https://ai.google.dev/gemini-api/docs/document-processing',
  capabilities: ['menu_extraction_vision'],
};

/** Lists one model with the key: proves the key is valid without generating anything (no token cost). */
export async function geminiByokHealthCheck(ctx: AdapterContext): Promise<HealthCheckResult> {
  const key = ctx.credentials.apiKey;
  if (!key) return { ok: false, details: { reason: 'missing_api_key' } };
  const body = await providerRequest<{ models?: Array<{ name?: string }> }>('gemini_byok', ctx, `${GEMINI_API_BASE}/models?pageSize=1`, {
    headers: { 'x-goog-api-key': key }, retries: 0, timeoutMs: 10_000,
  });
  return { ok: true, details: { models: (body.models ?? []).length } };
}

export const aiAdapters = [{ descriptor: geminiByokDescriptor, healthCheck: geminiByokHealthCheck }];
