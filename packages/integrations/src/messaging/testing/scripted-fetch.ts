// Test helper (excluded from nothing at runtime, but only imported by *.test.ts):
// a scripted fetch that records requests and replays canned responses.
export interface RecordedRequest { url: string; method: string; headers: Record<string, string>; body: string | null }

export function scriptedFetch(responses: Array<{ status?: number; body: unknown; headers?: Record<string, string> } | ((req: RecordedRequest) => { status?: number; body: unknown; headers?: Record<string, string> })>) {
  const calls: RecordedRequest[] = [];
  let i = 0;
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]).forEach((v, k) => { headers[k] = v; });
    const req: RecordedRequest = { url: String(input), method: init?.method ?? 'GET', headers, body: init?.body == null ? null : String(init.body) };
    calls.push(req);
    const next = responses[Math.min(i++, responses.length - 1)];
    if (!next) throw new Error('no scripted response');
    const r = typeof next === 'function' ? next(req) : next;
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json', ...r.headers } });
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}
