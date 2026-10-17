import { Injectable } from '@nestjs/common';

/**
 * The single outbound HTTP entry point for provider adapters. Tests replace
 * `fetch` with a scripted fake; production uses the platform fetch.
 */
@Injectable()
export class ProviderHttp {
  fetch: typeof fetch = (input, init) => globalThis.fetch(input, init);
}
