import { Inject, Injectable, Logger } from '@nestjs/common';
import { GeminiLlm, ProviderError, type GeminiContent, type GeminiFunctionDeclaration, type GeminiResult } from '@resuto/integrations';
import { ENV, type Env } from '../../config/env';
import { DomainError } from '../../common/errors/domain-error';

// Operator-key Gemini for the assistant and the copy generator. INT-30: the HTTP call itself (endpoint, timeout,
// retries on 429/5xx, error redaction, usage metadata) lives in the one shared client, packages/integrations/src/ai/gemini.ts,
// also used by Studio creative copy. Server-side only: the key never reaches the browser. Callers meter each call
// against the plan's AI quota (FT-10) and fall back to their labelled rules/template output when this is not configured.

export type { GeminiContent, GeminiPart } from '@resuto/integrations';
export type FunctionDeclaration = GeminiFunctionDeclaration;

export interface LlmClient {
  readonly provider: 'gemini';
  generate(req: { system: string; contents: GeminiContent[]; tools?: FunctionDeclaration[]; temperature?: number }): Promise<GeminiContent>;
}

@Injectable()
export class GeminiClient implements LlmClient {
  readonly provider = 'gemini' as const;
  private readonly logger = new Logger('Gemini');
  private readonly llm: GeminiLlm | null;

  constructor(@Inject(ENV) env: Env) {
    this.llm = env.GEMINI_API_KEY ? new GeminiLlm({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL, timeoutMs: 25_000, retries: 1 }) : null;
  }

  get configured() {
    return !!this.llm;
  }

  async generate(req: { system: string; contents: GeminiContent[]; tools?: FunctionDeclaration[]; temperature?: number }): Promise<GeminiContent> {
    return (await this.generateWithUsage(req)).content;
  }

  /** Same call, with the token usage Google reports (for metering) and the number of attempts made. */
  async generateWithUsage(req: { system: string; contents: GeminiContent[]; tools?: FunctionDeclaration[]; temperature?: number }): Promise<GeminiResult> {
    if (!this.llm) throw new DomainError('llm_not_configured', 'GEMINI_API_KEY is not configured', 503);
    try {
      return await this.llm.generate({ system: req.system, contents: req.contents, tools: req.tools, temperature: req.temperature ?? 0.2, maxOutputTokens: 1024 });
    } catch (e) {
      const pe = e instanceof ProviderError ? e : null;
      this.logger.warn(`Gemini call failed: ${pe?.message ?? 'unexpected error'}`);
      if (pe && /^gemini: empty response/.test(pe.message)) throw new DomainError('llm_empty', 'The language model returned no answer', 503, { reason: pe.message.slice(8) });
      throw new DomainError('llm_unavailable', 'The language model is unavailable', 503, { status: pe?.status ?? null });
    }
  }
}
