// Sandbox messaging transport. It NEVER makes a network call: messages are
// stored by Resuto and marked delivered locally so restaurants can rehearse the
// WhatsApp ordering flow before Meta approval. Every message it produces is
// labelled sandbox in the API and UI.
import { randomUUID } from 'node:crypto';
import type { ProviderDescriptor } from '../core';

export const messagingSandboxDescriptor: ProviderDescriptor = {
  id: 'messaging_sandbox',
  name: 'Messaging sandbox (no external delivery)',
  category: 'messaging',
  countries: ['EG', 'SA'],
  authType: 'none',
  readiness: 'simulated',
  capabilities: ['inbound_simulator', 'interactive_buttons', 'interactive_lists', 'cta_url', 'templates'],
  activation: [
    'No activation needed. Sandbox channels are for testing and demos only: messages never leave Resuto.',
    'To reach real customers, connect "WhatsApp Business (Cloud API)" and add a WhatsApp channel.',
  ],
};

export const messagingSandboxAdapter = {
  descriptor: messagingSandboxDescriptor,
  /** Accepts the payload without sending it anywhere. */
  async send(_payload: Record<string, unknown>): Promise<{ messageId: string; sandbox: true }> {
    return { messageId: `sandbox.${randomUUID()}`, sandbox: true };
  },
  async healthCheck() {
    return { ok: true, details: { sandbox: true, note: 'Sandbox transport: no external provider involved.' } };
  },
};
