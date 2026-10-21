// Gemini acceptance check (INT-30): one fixed prompt in JSON mode with a response schema, output validated locally.
// Google has no separate test environment; the check runs with the owner's own key (GEMINI_API_KEY, BYOK or operator)
// and costs a few hundred tokens on that key. It records the model, token usage and finish reason, never the output.
import { z } from 'zod';
import { GEMINI_BYOK_DEFAULT_MODEL, GeminiLlm, geminiJson } from '../ai';
import { expectThat, registerChecks, type AcceptanceCheck } from './index';

/** Fixed prompt: the facts are given, so a correct answer is checkable. */
export const GEMINI_ACCEPTANCE_PROMPT = 'Restaurant facts: name "Olive Room", city "Cairo", dish "Koshary" priced 85 EGP. '
  + 'Return JSON with: restaurant (the name exactly as given), dish (exactly as given), priceMinor (the price in piastres as an integer), '
  + 'captionEn (one English sentence under 120 characters inviting guests to try the dish), captionAr (the same in Arabic).';

export const GEMINI_ACCEPTANCE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    restaurant: { type: 'STRING' }, dish: { type: 'STRING' }, priceMinor: { type: 'INTEGER' },
    captionEn: { type: 'STRING' }, captionAr: { type: 'STRING' },
  },
  required: ['restaurant', 'dish', 'priceMinor', 'captionEn', 'captionAr'],
} as const;

export const geminiAcceptanceOutput = z.object({
  restaurant: z.literal('Olive Room'),
  dish: z.literal('Koshary'),
  priceMinor: z.literal(8500),
  captionEn: z.string().min(5).max(200),
  captionAr: z.string().min(3).max(300).regex(/[؀-ۿ]/, 'expected Arabic script'),
});

export const geminiChecks: AcceptanceCheck[] = [
  {
    id: 'gemini.structured_output', provider: 'gemini', capability: 'json_schema_output', modes: ['official_test', 'live'],
    requires: ['GEMINI_API_KEY'], effect: 'read',
    prerequisites: ['A Google AI Studio key (https://aistudio.google.com/apikey). Optional GEMINI_MODEL (default gemini-2.5-flash). Uses a few hundred tokens on that key.'],
    docsUrl: 'https://ai.google.dev/api/generate-content',
    async run(ctx) {
      const model = process.env.GEMINI_MODEL || GEMINI_BYOK_DEFAULT_MODEL;
      const llm = new GeminiLlm({ apiKey: ctx.env.GEMINI_API_KEY!, model, fetch: ctx.adapter.fetch, retries: 1, timeoutMs: 30_000 });
      const { value, result } = await geminiJson(llm, {
        contents: [{ role: 'user', parts: [{ text: GEMINI_ACCEPTANCE_PROMPT }] }], temperature: 0, maxOutputTokens: 512, schema: GEMINI_ACCEPTANCE_SCHEMA as unknown as Record<string, unknown>,
      }, (v) => geminiAcceptanceOutput.parse(v));
      ctx.evidence('structured output validated', { model, finishReason: result.finishReason, attempts: result.attempts,
        // Keys named *token* are redacted by the runner, so the counts are recorded under neutral names.
        usage: result.usage ? { prompt: result.usage.promptTokens, output: result.usage.outputTokens, total: result.usage.totalTokens } : null,
        captionEnLength: value.captionEn.length, captionArLength: value.captionAr.length });
      expectThat(result.usage !== null, 'usageMetadata missing: usage cannot be metered');
    },
  },
];

registerChecks(...geminiChecks);
