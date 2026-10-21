import { afterEach, describe, expect, it, vi } from 'vitest';
import { DomainError } from '../../common/errors/domain-error';
import { GeminiClient } from './gemini.client';

// INT-30: the operator-key client delegates to the shared @resuto/integrations GeminiLlm and maps its errors to the
// API's stable codes (llm_not_configured / llm_unavailable / llm_empty) without echoing the provider's body.
const env = (key: string) => ({ GEMINI_API_KEY: key, GEMINI_MODEL: 'gemini-2.5-flash' }) as any;
const req = { system: 's', contents: [{ role: 'user' as const, parts: [{ text: 'hi' }] }] };

afterEach(() => vi.unstubAllGlobals());

describe('GeminiClient (operator key)', () => {
  it('fails closed with llm_not_configured and makes no request without a key', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const c = new GeminiClient(env(''));
    expect(c.configured).toBe(false);
    await expect(c.generate(req)).rejects.toMatchObject({ code: 'llm_not_configured', status: 503 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns content and usage through the shared client', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const c = new GeminiClient(env('k-test-123456'));
    const r = await c.generateWithUsage(req);
    expect(r.content.parts[0]!.text).toBe('ok');
    expect(r.usage).toEqual({ promptTokens: 3, outputTokens: 2, totalTokens: 5 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toContain('/models/gemini-2.5-flash:generateContent');
  });

  it('maps a provider failure to llm_unavailable without the provider body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"secret upstream detail"}}', { status: 400 })));
    const err = await new GeminiClient(env('k-test-123456')).generate(req).catch((e) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect(err).toMatchObject({ code: 'llm_unavailable', status: 503 });
    expect(JSON.stringify(err)).not.toContain('secret upstream detail');
  });

  it('maps an empty candidate to llm_empty', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ candidates: [{ finishReason: 'MAX_TOKENS' }] }), { status: 200 })));
    await expect(new GeminiClient(env('k-test-123456')).generate(req)).rejects.toMatchObject({ code: 'llm_empty' });
  });
});
