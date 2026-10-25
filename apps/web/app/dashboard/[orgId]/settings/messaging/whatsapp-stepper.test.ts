import { describe, expect, it } from 'vitest';
import { WHATSAPP_ONBOARDING_STEPS } from '@resuto/contracts/lite';
import { dictionaries } from '@/lib/i18n/messages';
import { stepDone, type StepperChannel } from './WhatsAppStepper';

// 21-INT WhatsApp official stepper (plan §6.9): the seven steps in order, each titled in English and Arabic; a step
// counts as done only on evidence (verified number, the test template usable on this channel, a reply received).

const channel = (patch: Partial<StepperChannel> = {}): StepperChannel => ({
  id: 'c1', kind: 'whatsapp', transport: 'meta_cloud', sandbox: false, displayName: 'Main', status: 'pending', orderingEnabled: true, branchId: null,
  verified: true, webhookSubscribed: true, routing: 'manual', ...patch,
});

describe('WhatsApp stepper', () => {
  it('has the plan\'s seven steps, titled in both languages', () => {
    expect(WHATSAPP_ONBOARDING_STEPS).toEqual(['connect', 'number', 'ordering', 'templates', 'routing', 'test', 'activate']);
    for (const k of WHATSAPP_ONBOARDING_STEPS) {
      expect(dictionaries.en[`wa.step.${k}`]).toBeTruthy();
      expect(dictionaries.ar[`wa.step.${k}`]).toMatch(/[؀-ۿ]/);
    }
  });

  it('marks steps done only on evidence', () => {
    const none = { templates: [], tested: false };
    expect(stepDone('number', channel({ verified: false }), none)).toBe(false);
    expect(stepDone('number', channel(), none)).toBe(true);
    // A live number needs Meta's approval of the test template; a sandbox template only counts on a sandbox channel.
    const sandboxTpl = { templates: [{ id: 't', name: 'resuto_connection_test', language: 'en', providerStatus: 'sandbox' }], tested: false };
    expect(stepDone('templates', channel(), sandboxTpl)).toBe(false);
    expect(stepDone('templates', channel({ sandbox: true, transport: 'sandbox' }), sandboxTpl)).toBe(true);
    expect(stepDone('templates', channel(), { templates: [{ id: 't', name: 'resuto_connection_test', language: 'en', providerStatus: 'approved' }], tested: false })).toBe(true);
    expect(stepDone('test', channel(), none)).toBe(false);
    expect(stepDone('activate', channel(), { templates: [], tested: true })).toBe(true);
    expect(stepDone('activate', channel({ status: 'disabled' }), { templates: [], tested: true })).toBe(false);
    expect(stepDone('connect', null, none)).toBe(false);
  });
});
