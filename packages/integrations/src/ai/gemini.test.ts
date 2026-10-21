import { describe, expect, it } from 'vitest';
import { ProviderError } from '../core';
import { runAcceptance } from '../acceptance';
import { geminiChecks } from '../acceptance/gemini';
import { scriptedFetch } from '../messaging/testing/scripted-fetch';
import { GeminiLlm, geminiJson } from './gemini';

const KEY = 'AIzaFAKE-test-key-0000000000';
const ok = (text: string, extra: Record<string, unknown> = {}) => ({
  body: {
    candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 30, thoughtsTokenCount: 5, totalTokenCount: 47 },
    ...extra,
  },
});
const noSleep = async () => undefined;

describe('GeminiLlm (INT-30 shared client)', () => {
  it('calls the documented generateContent endpoint with the key in x-goog-api-key and reports usage', async () => {
    const { fetch, calls } = scriptedFetch([ok('hello')]);
    const llm = new GeminiLlm({ apiKey: KEY, model: 'gemini-2.5-flash', fetch, sleep: noSleep });
    const r = await llm.generate({
      system: 'be brief', contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      tools: [{ name: 'lookup', description: 'd', parameters: { type: 'OBJECT', properties: {} } }], temperature: 0.1, maxOutputTokens: 64,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers['x-goog-api-key']).toBe(KEY);
    expect(calls[0].url).not.toContain(KEY);
    const body = JSON.parse(calls[0].body!);
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'be brief' }] });
    expect(body.tools[0].functionDeclarations[0].name).toBe('lookup');
    expect(body.toolConfig.functionCallingConfig.mode).toBe('AUTO');
    expect(body.generationConfig).toEqual({ temperature: 0.1, maxOutputTokens: 64 });
    expect(r.text).toBe('hello');
    expect(r.finishReason).toBe('STOP');
    expect(r.attempts).toBe(1);
    // Thinking tokens are billed as output tokens.
    expect(r.usage).toEqual({ promptTokens: 12, outputTokens: 35, totalTokens: 47 });
  });

  it('sends JSON mode with a response schema', async () => {
    const { fetch, calls } = scriptedFetch([ok('{"a":1}')]);
    const llm = new GeminiLlm({ apiKey: KEY, model: 'gemini-2.5-flash', fetch, sleep: noSleep });
    const { value } = await geminiJson(llm, { contents: [{ role: 'user', parts: [{ text: 'x' }] }], schema: { type: 'OBJECT' } }, (v) => v as { a: number });
    expect(value).toEqual({ a: 1 });
    const cfg = JSON.parse(calls[0].body!).generationConfig;
    expect(cfg.responseMimeType).toBe('application/json');
    expect(cfg.responseSchema).toEqual({ type: 'OBJECT' });
  });

  it('retries once on 429/5xx and honours Retry-After (capped), then succeeds', async () => {
    const delays: number[] = [];
    const { fetch, calls } = scriptedFetch([{ status: 503, body: { error: { message: 'overloaded' } }, headers: { 'retry-after': '2' } }, ok('fine')]);
    const llm = new GeminiLlm({ apiKey: KEY, model: 'gemini-2.5-flash', fetch, retries: 1, sleep: async (ms) => { delays.push(ms); } });
    const r = await llm.generate({ contents: [{ role: 'user', parts: [{ text: 'x' }] }] });
    expect(calls).toHaveLength(2);
    expect(delays).toEqual([2000]);
    expect(r.attempts).toBe(2);
  });

  it('does not retry a 400, and never echoes the response body or the key', async () => {
    const { fetch, calls } = scriptedFetch([{ status: 400, body: { error: { message: `API key ${KEY} not valid; secret detail` } } }]);
    const llm = new GeminiLlm({ apiKey: KEY, model: 'gemini-2.5-flash', fetch, retries: 3, sleep: noSleep });
    const err = await llm.generate({ contents: [{ role: 'user', parts: [{ text: 'x' }] }] }).catch((e) => e);
    expect(calls).toHaveLength(1);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toBe('gemini: HTTP 400');
    expect(err.status).toBe(400);
    expect(err.retryable).toBe(false);
  });

  it('gives up after the retry budget on repeated 5xx', async () => {
    const { fetch, calls } = scriptedFetch([{ status: 500, body: {} }]);
    const llm = new GeminiLlm({ apiKey: KEY, model: 'gemini-2.5-flash', fetch, retries: 2, sleep: noSleep });
    await expect(llm.generate({ contents: [{ role: 'user', parts: [{ text: 'x' }] }] })).rejects.toThrow('gemini: HTTP 500');
    expect(calls).toHaveLength(3);
  });

  it('turns network errors and timeouts into retryable ProviderErrors without leaking details', async () => {
    let n = 0;
    const fetch = (async () => { n++; throw Object.assign(new Error(`connect to ${KEY}`), { name: 'TimeoutError' }); }) as unknown as typeof globalThis.fetch;
    const llm = new GeminiLlm({ apiKey: KEY, model: 'gemini-2.5-flash', fetch, retries: 1, sleep: noSleep });
    const err = await llm.generate({ contents: [{ role: 'user', parts: [{ text: 'x' }] }] }).catch((e) => e);
    expect(n).toBe(2);
    expect(err.message).toBe('gemini: network error (TimeoutError)');
    expect(err.message).not.toContain(KEY);
  });

  it('reports a blocked prompt / empty candidate as a non-retryable empty response', async () => {
    const { fetch, calls } = scriptedFetch([{ body: { promptFeedback: { blockReason: 'SAFETY' } } }]);
    const llm = new GeminiLlm({ apiKey: KEY, model: 'gemini-2.5-flash', fetch, retries: 2, sleep: noSleep });
    await expect(llm.generate({ contents: [{ role: 'user', parts: [{ text: 'x' }] }] })).rejects.toThrow('gemini: empty response (SAFETY)');
    expect(calls).toHaveLength(1);
  });

  it('fails closed without a key and refuses model names that could alter the path', () => {
    expect(() => new GeminiLlm({ apiKey: '', model: 'gemini-2.5-flash' })).toThrow('no API key configured');
    expect(() => new GeminiLlm({ apiKey: KEY, model: '../files' })).toThrow('invalid model name');
    expect(() => new GeminiLlm({ apiKey: KEY, model: 'gemini-2.5-flash?alt=x' })).toThrow('invalid model name');
  });

  it('geminiJson rejects invalid JSON and schema mismatches as non-retryable errors', async () => {
    const llm1 = new GeminiLlm({ apiKey: KEY, model: 'm1', fetch: scriptedFetch([ok('not json')]).fetch, sleep: noSleep });
    await expect(geminiJson(llm1, { contents: [] }, (v) => v)).rejects.toThrow('the model returned invalid JSON');
    const llm2 = new GeminiLlm({ apiKey: KEY, model: 'm1', fetch: scriptedFetch([ok('{"a":"x"}')]).fetch, sleep: noSleep });
    await expect(geminiJson(llm2, { contents: [] }, () => { throw new Error('bad'); })).rejects.toThrow('does not match the expected schema');
  });
});

describe('gemini acceptance check', () => {
  const check = geminiChecks[0]!;

  it('is not_run without GEMINI_API_KEY (no request is made)', async () => {
    const { fetch, calls } = scriptedFetch([ok('{}')]);
    const [r] = await runAcceptance([check], { mode: 'official_test', env: {}, fetch });
    expect(r.status).toBe('not_run');
    expect(r.reason).toBe('not configured: GEMINI_API_KEY');
    expect(calls).toHaveLength(0);
  });

  it('passes on schema-valid output from a scripted transport and records usage without the output or key', async () => {
    const answer = { restaurant: 'Olive Room', dish: 'Koshary', priceMinor: 8500, captionEn: 'Try our Koshary tonight.', captionAr: 'جربوا الكشري الليلة.' };
    const { fetch, calls } = scriptedFetch([ok(JSON.stringify(answer))]);
    const [r] = await runAcceptance([check], { mode: 'official_test', env: { GEMINI_API_KEY: KEY }, fetch });
    expect(r.status).toBe('passed');
    expect(JSON.parse(calls[0].body!).generationConfig.responseSchema.required).toContain('priceMinor');
    const ev = JSON.stringify(r.evidence);
    expect(ev).not.toContain(KEY);
    expect(ev).not.toContain('Koshary tonight');
    expect(r.evidence[0].data).toMatchObject({ usage: { prompt: 12, output: 35, total: 47 }, finishReason: 'STOP' });
  });

  it('fails when the model gets the fixed facts wrong', async () => {
    const wrong = { restaurant: 'Olive Room', dish: 'Koshary', priceMinor: 85, captionEn: 'Try it.', captionAr: 'جربوه.' };
    const [r] = await runAcceptance([check], { mode: 'official_test', env: { GEMINI_API_KEY: KEY }, fetch: scriptedFetch([ok(JSON.stringify(wrong))]).fetch });
    expect(r.status).toBe('failed');
    expect(r.reason).toContain('does not match the expected schema');
  });
});
