// The one Gemini client for Resuto (INT-30). The assistant and copy generator (apps/api intelligence/gemini.client.ts),
// Studio creative copy (studio/creative-generator.ts) and the acceptance check all call generateContent through it, so
// timeouts, retries, error redaction and usage reporting are defined once.
//
// Docs (checked 2026-10-21):
//   generateContent  POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
//     request: systemInstruction, contents[], tools[].functionDeclarations, toolConfig.functionCallingConfig.mode,
//              generationConfig { temperature, maxOutputTokens, responseMimeType, responseSchema }
//     response: candidates[].content.parts, candidates[].finishReason, promptFeedback.blockReason,
//               usageMetadata { promptTokenCount, candidatesTokenCount, thoughtsTokenCount, totalTokenCount }
//     https://ai.google.dev/api/generate-content
//   API key header x-goog-api-key:  https://ai.google.dev/gemini-api/docs/api-key
//   Model lifecycle (gemini-2.5-flash: no shutdown date announced): https://ai.google.dev/gemini-api/docs/deprecations
//
// Cost policy: Resuto never funds a call silently. Callers pass either the restaurant's own key (BYOK, billed by
// Google to the restaurant) or the operator key, and meter operator-key calls against the plan's AI quota (FT-10) with
// the usage returned here. Without a key nothing is called and callers use their labelled fallback.
import { ProviderError } from '../core';
import { GEMINI_API_BASE } from './index';

export interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  inlineData?: { mimeType: string; data: string };
}
export interface GeminiContent { role: 'user' | 'model'; parts: GeminiPart[] }
export interface GeminiFunctionDeclaration { name: string; description: string; parameters: Record<string, unknown> }

export interface GeminiRequest {
  system?: string;
  contents: GeminiContent[];
  tools?: GeminiFunctionDeclaration[];
  temperature?: number;
  maxOutputTokens?: number;
  /** JSON mode: responseMimeType application/json, optionally constrained by an OpenAPI-subset schema. */
  json?: { schema?: Record<string, unknown> };
}

export interface LlmUsage { promptTokens: number; outputTokens: number; totalTokens: number }
export interface GeminiResult {
  content: GeminiContent;
  /** Concatenated text parts. */
  text: string;
  finishReason: string | null;
  usage: LlmUsage | null;
  model: string;
  /** HTTP attempts made (1 = no retry). Every attempt that reached Google may be billed. */
  attempts: number;
}

export interface GeminiClientOptions {
  apiKey: string;
  /** Provider id in error messages (default 'gemini'; BYOK callers pass 'gemini_byok'). */
  provider?: 'gemini' | 'gemini_byok';
  model: string;
  fetch?: typeof fetch;
  /** Per-attempt timeout (default 25 s). */
  timeoutMs?: number;
  /** Retries on 429 / 5xx / network errors (default 1). */
  retries?: number;
  /** Test hook for the backoff delay. */
  sleep?: (ms: number) => Promise<void>;
}

const MODEL_NAME = /^[a-z0-9][a-z0-9.\-]{1,62}$/;

/** Gemini generateContent client. Errors are ProviderError('gemini', …) with short, key-free messages; bodies are never echoed. */
export class GeminiLlm {
  readonly provider: 'gemini' | 'gemini_byok';
  private readonly http: typeof fetch;

  constructor(private readonly opts: GeminiClientOptions) {
    this.provider = opts.provider ?? 'gemini';
    if (!opts.apiKey) throw new ProviderError(this.provider, 'no API key configured', false);
    if (!MODEL_NAME.test(opts.model)) throw new ProviderError(this.provider, 'invalid model name', false);
    this.http = opts.fetch ?? fetch;
  }

  get model() { return this.opts.model; }

  async generate(req: GeminiRequest): Promise<GeminiResult> {
    const body = {
      ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
      contents: req.contents,
      ...(req.tools?.length ? { tools: [{ functionDeclarations: req.tools }], toolConfig: { functionCallingConfig: { mode: 'AUTO' } } } : {}),
      generationConfig: {
        temperature: req.temperature ?? 0.2, maxOutputTokens: req.maxOutputTokens ?? 1024,
        ...(req.json ? { responseMimeType: 'application/json', ...(req.json.schema ? { responseSchema: req.json.schema } : {}) } : {}),
      },
    };
    const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(this.opts.model)}:generateContent`;
    const retries = this.opts.retries ?? 1;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    let last: ProviderError | null = null;
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      try {
        return await this.once(url, body, attempt);
      } catch (e) {
        last = e instanceof ProviderError ? e : new ProviderError(this.provider, 'unexpected error', false);
        if (!last.retryable || attempt > retries) break;
        await sleep(Math.min(last.retryAfterMs ?? 500 * 2 ** (attempt - 1), 5_000));
      }
    }
    throw last!;
  }

  private async once(url: string, body: unknown, attempt: number): Promise<GeminiResult> {
    let res: Response;
    try {
      res = await this.http(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.opts.apiKey }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 25_000),
      });
    } catch (e) {
      throw new ProviderError(this.provider, `network error (${(e as Error).name})`, true);
    }
    const text = await res.text();
    if (!res.ok) {
      const retryAfter = Number(res.headers.get('retry-after')) * 1000 || undefined;
      throw new ProviderError(this.provider, `HTTP ${res.status}`, res.status === 429 || res.status >= 500, res.status, retryAfter);
    }
    let json: any;
    try { json = JSON.parse(text); } catch { throw new ProviderError(this.provider, 'non-JSON response', true); }
    const cand = json?.candidates?.[0];
    const parts: GeminiPart[] = Array.isArray(cand?.content?.parts) ? cand.content.parts : [];
    if (!parts.length) {
      const why = String(cand?.finishReason ?? json?.promptFeedback?.blockReason ?? 'no candidate').slice(0, 40);
      throw new ProviderError(this.provider, `empty response (${why})`, false);
    }
    const u = json?.usageMetadata;
    const usage = u && typeof u === 'object' ? {
      promptTokens: Number(u.promptTokenCount ?? 0) || 0,
      outputTokens: (Number(u.candidatesTokenCount ?? 0) || 0) + (Number(u.thoughtsTokenCount ?? 0) || 0),
      totalTokens: Number(u.totalTokenCount ?? 0) || 0,
    } : null;
    return {
      content: { role: 'model', parts }, text: parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join(''),
      finishReason: typeof cand?.finishReason === 'string' ? cand.finishReason : null, usage, model: this.opts.model, attempts: attempt,
    };
  }
}

/** JSON-mode call whose output must pass `validate` (e.g. a zod schema's parse); invalid output is a non-retryable error. */
export async function geminiJson<T>(llm: GeminiLlm, req: Omit<GeminiRequest, 'json'> & { schema?: Record<string, unknown> }, validate: (value: unknown) => T)
  : Promise<{ value: T; result: GeminiResult }> {
  const { schema, ...rest } = req;
  const result = await llm.generate({ ...rest, json: { schema } });
  let parsed: unknown;
  try { parsed = JSON.parse(result.text); } catch { throw new ProviderError(llm.provider, 'the model returned invalid JSON', false); }
  try {
    return { value: validate(parsed), result };
  } catch {
    throw new ProviderError(llm.provider, 'the model output does not match the expected schema', false);
  }
}
