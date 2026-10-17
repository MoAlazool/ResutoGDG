import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, type Env } from '../../config/env';
import { DomainError } from '../../common/errors/domain-error';

// Gemini REST (generativelanguage.googleapis.com v1beta generateContent) with function calling.
// Server-side only: the key never reaches the browser.

export interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}
export interface GeminiContent { role: 'user' | 'model'; parts: GeminiPart[] }
export interface FunctionDeclaration { name: string; description: string; parameters: Record<string, unknown> }

export interface LlmClient {
  readonly provider: 'gemini';
  generate(req: { system: string; contents: GeminiContent[]; tools?: FunctionDeclaration[]; temperature?: number }): Promise<GeminiContent>;
}

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

@Injectable()
export class GeminiClient implements LlmClient {
  readonly provider = 'gemini' as const;
  private readonly logger = new Logger('Gemini');
  private readonly key: string | undefined;
  private readonly model: string;

  constructor(@Inject(ENV) env: Env) {
    this.key = env.GEMINI_API_KEY || undefined;
    this.model = env.GEMINI_MODEL;
  }

  get configured() {
    return !!this.key;
  }

  async generate(req: { system: string; contents: GeminiContent[]; tools?: FunctionDeclaration[]; temperature?: number }): Promise<GeminiContent> {
    if (!this.key) throw new DomainError('llm_not_configured', 'GEMINI_API_KEY is not configured', 503);
    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: req.contents,
      ...(req.tools?.length ? { tools: [{ functionDeclarations: req.tools }], toolConfig: { functionCallingConfig: { mode: 'AUTO' } } } : {}),
      generationConfig: { temperature: req.temperature ?? 0.2, maxOutputTokens: 1024 },
    };
    let res: Response;
    try {
      res = await fetch(`${ENDPOINT}/${encodeURIComponent(this.model)}:generateContent`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': this.key }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(25_000),
      });
    } catch (error) {
      throw new DomainError('llm_unavailable', 'The language model is unavailable', 503, { detail: (error as Error).name });
    }
    const json = (await res.json().catch(() => null)) as any;
    if (!res.ok) {
      this.logger.warn(`Gemini ${res.status}: ${JSON.stringify(json?.error ?? {}).slice(0, 300)}`);
      throw new DomainError('llm_unavailable', 'The language model rejected the request', 503, { status: res.status });
    }
    const content = json?.candidates?.[0]?.content as GeminiContent | undefined;
    if (!content?.parts?.length) throw new DomainError('llm_empty', 'The language model returned no answer', 503, { finishReason: json?.candidates?.[0]?.finishReason });
    return { role: 'model', parts: content.parts };
  }
}
