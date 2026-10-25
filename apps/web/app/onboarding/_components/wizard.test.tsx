// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_ONBOARDING, type OnboardingProgress } from '@resuto/contracts/lite';
import { LocaleProvider } from '@/lib/i18n/client';
import { messagesFor } from '@/lib/i18n/messages';
import { localSlugState, remoteSlugState, toSlug, finalSlug, slugSubmittable } from '@/lib/onboarding/slug-check';
import { AddressStep } from './steps/AddressStep';
import { RestaurantStep } from './steps/RestaurantStep';
import { WizardContext, priceToMinor, type WizardValue } from './wizard-context';

// 21-ONB wizard screens in a browser DOM: the live web-address check moves through its states as the owner types
// (instantly for shape and reserved words, after a pause for availability), and finishing a step saves it with the
// answers (the progress the server keeps). English and Arabic, Western digits.

vi.mock('@/lib/session', () => ({ useSession: () => ({ refreshMe: async () => null }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const EASTERN_DIGITS = /[٠-٩۰-۹]/;

function wizard(over: Partial<WizardValue> = {}, progress: Partial<OnboardingProgress> = {}): WizardValue {
  return {
    progress: { ...EMPTY_ONBOARDING, ...progress }, step: 'address', org: null, busy: false,
    setOrg: vi.fn(), finish: vi.fn(async () => {}), saveDraft: vi.fn(async () => {}), open: vi.fn(async () => {}), back: vi.fn(async () => {}),
    restart: vi.fn(async () => {}), call: vi.fn(async () => ({})) as WizardValue['call'], ...over,
  };
}

function mount(node: ReactNode, locale: 'en' | 'ar' = 'en') {
  const host = document.createElement('div');
  host.setAttribute('lang', locale);
  host.setAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
  document.body.appendChild(host);
  const root = createRoot(host);
  const messages = { ...messagesFor(locale, 'guest'), ...messagesFor(locale, 'onboarding') };
  act(() => root.render(<LocaleProvider locale={locale} messages={messages}>{node}</LocaleProvider>));
  return { host, unmount: () => { act(() => root.unmount()); host.remove(); } };
}
function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
}
const state = (host: HTMLElement) => host.querySelector('#onb-slug-state')!;
const create = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('button[type="submit"]')!;

describe('web address check (slug states)', () => {
  it('pure rules: shape and reserved words without asking, the API answer mapped', () => {
    expect(toSlug('Olive Room!! Café')).toBe('olive-room-cafe');
    expect(finalSlug('olive-')).toBe('olive');
    expect([localSlugState(''), localSlugState('ab'), localSlugState('admin'), localSlugState('olive-room')]).toEqual(['idle', 'invalid', 'reserved', null]);
    expect(remoteSlugState({ slug: 'x', available: true, reason: null })).toBe('available');
    expect(remoteSlugState({ slug: 'x', available: false, reason: 'taken' })).toBe('taken');
    expect(['available', 'error', 'taken', 'checking'].map((s) => slugSubmittable(s as never))).toEqual([true, true, false, false]);
  });

  describe('as the owner types', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; });

    it('invalid and reserved at once; checking, then available or taken after the pause; only available creates', async () => {
      const call = vi.fn(async (path: string) => {
        const slug = new URL(`http://x${path}`).searchParams.get('slug');
        return { slug, available: slug !== 'taken-place', reason: slug === 'taken-place' ? 'taken' : null };
      });
      const w = wizard({ call: call as WizardValue['call'] }, { draft: { name: 'Olive Room' } });
      const { host, unmount } = mount(<WizardContext.Provider value={w}><AddressStep /></WizardContext.Provider>);
      const input = host.querySelector<HTMLInputElement>('input')!;
      // Prefilled from the restaurant name, checked after the pause.
      expect(input.value).toBe('olive-room');
      expect(state(host).getAttribute('data-state')).toBe('checking');
      expect(create(host).disabled).toBe(true);
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });
      expect(state(host).getAttribute('data-state')).toBe('available');
      expect(state(host).textContent).toBe('Available');
      expect(create(host).disabled).toBe(false);

      type(input, 'ab');
      expect(state(host).getAttribute('data-state')).toBe('invalid');
      type(input, 'Admin');
      expect(input.value).toBe('admin');
      expect(state(host).getAttribute('data-state')).toBe('reserved');
      expect(state(host).textContent).toContain('reserved');
      type(input, 'taken-place');
      expect(state(host).getAttribute('data-state')).toBe('checking');
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });
      expect(state(host).getAttribute('data-state')).toBe('taken');
      expect(create(host).disabled).toBe(true);
      // Typing fast: only the last value is asked about (debounced), never the intermediate ones.
      call.mockClear();
      type(input, 'olive-r'); type(input, 'olive-ro'); type(input, 'olive-roo');
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });
      expect(call).toHaveBeenCalledTimes(1);
      expect(call.mock.calls[0]![0]).toContain('slug=olive-roo');
      expect(host.querySelector('#onb-slug-url')!.textContent).toMatch(/\/m\/olive-roo$/);
      unmount();
    });

    it('a failed check still lets the owner create (the API checks again); Arabic copy, Western digits', async () => {
      const call = vi.fn(async () => { throw new Error('offline'); });
      const w = wizard({ call: call as WizardValue['call'] }, { draft: { slug: 'olive-room' } });
      const { host, unmount } = mount(<WizardContext.Provider value={w}><AddressStep /></WizardContext.Provider>, 'ar');
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });
      expect(state(host).getAttribute('data-state')).toBe('error');
      expect(create(host).disabled).toBe(false);
      expect(host.textContent).toContain('عنوان الموقع');
      type(host.querySelector<HTMLInputElement>('input')!, 'ab');
      expect(state(host).textContent).toContain('من 3 إلى 48');
      expect(host.textContent).not.toMatch(EASTERN_DIGITS);
      unmount();
    });
  });
});

describe('step persistence', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('the restaurant step saves its answers as the draft when it is finished', async () => {
    const finish = vi.fn(async () => {});
    const w = wizard({ finish, step: 'restaurant' });
    const { host, unmount } = mount(<WizardContext.Provider value={w}><RestaurantStep /></WizardContext.Provider>);
    const [name, nameAr] = [...host.querySelectorAll<HTMLInputElement>('input.input')];
    // Without a name nothing is saved.
    await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(finish).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Enter the restaurant name.');
    type(name!, 'Olive Room');
    type(nameAr!, 'غرفة الزيتون');
    act(() => { host.querySelector<HTMLInputElement>('input[value="counter"]')!.click(); });
    await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(finish).toHaveBeenCalledWith({ draft: { name: 'Olive Room', nameAr: 'غرفة الزيتون', country: 'EG', serviceMode: 'counter' } });
    // The first step has no Back button (the signup is behind it).
    expect(host.textContent).not.toContain('Back');
    unmount();
  });

  it('once the restaurant exists, the address step shows it and just continues', async () => {
    const finish = vi.fn(async () => {});
    const org = { id: 'o1', slug: 'olive-room', name: 'Olive Room', nameAr: null, country: 'EG' as const, currency: 'EGP' as const, branches: [] };
    const w = wizard({ finish, org, step: 'address' }, { orgId: 'o1', completed: ['account', 'restaurant', 'address'] });
    const { host, unmount } = mount(<WizardContext.Provider value={w}><AddressStep /></WizardContext.Provider>);
    expect(host.querySelector('input')).toBeNull();
    expect(host.textContent).toMatch(/\/m\/olive-room/);
    await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(finish).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('Back');
    unmount();
  });

  it('prices accept Arabic digits and separators, two decimals at most', () => {
    expect([priceToMinor('45'), priceToMinor('45.5'), priceToMinor('٤٥٫٢٥'), priceToMinor('45,5'), priceToMinor('4.555'), priceToMinor('abc'), priceToMinor('')])
      .toEqual([4500, 4550, 4525, 4550, null, null, null]);
  });
});
