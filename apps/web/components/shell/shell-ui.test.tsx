// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { $, $$, click, EASTERN_DIGITS, key, mount, type } from '../../../../packages/ui/test/dom';
import { LocaleProvider } from '@/lib/i18n/client';
import { messagesFor } from '@/lib/i18n/messages';
import type { NavArea } from '@/lib/nav';
import { OrgProvider, useBranchScope, type OrgInfo } from '@/lib/org-context';
import { AccountMenu } from './AccountMenu';
import { BranchSwitcher } from './BranchSwitcher';
import CommandPalette from './CommandPalette';

// 21-SHELL components in a browser-like DOM, in English and Arabic: the account menu (sign-out is an explicit
// choice), the branch switcher with "All branches", the shell's branch scope, and the command palette.

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), usePathname: () => '/dashboard/o1', useRouter: () => ({ push() {} }) }));

const inLocale = (locale: 'en' | 'ar', node: ReactNode) => (
  <LocaleProvider locale={locale} messages={{ ...messagesFor(locale, 'guest'), ...messagesFor(locale, 'staff') }}>{node}</LocaleProvider>
);
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); });

const org = (over: Partial<OrgInfo> = {}): OrgInfo => ({
  id: 'o1', slug: 'olive', name: 'The Olive Room', nameAr: 'غرفة الزيتون', country: 'EG', currency: 'EGP', timezone: 'Africa/Cairo', role: 'owner', status: 'active',
  branches: [
    { id: 'b1', name: 'Zamalek', nameAr: 'الزمالك', code: 'main', isActive: true },
    { id: 'b2', name: 'Maadi', nameAr: 'المعادي', code: 'maadi', isActive: true },
  ],
  ...over,
});

afterEach(() => { document.body.innerHTML = ''; });

describe('account menu', () => {
  const setup = (locale: 'en' | 'ar' = 'en') => {
    const calls = { navigate: vi.fn(), language: vi.fn(), signOut: vi.fn() };
    const v = mount(inLocale(locale, (
      <AccountMenu name="Mona Adel" roleLabel={locale === 'ar' ? 'المالك' : 'Owner'} guestHref="/r/olive" guestLabel="Open guest experience"
        setupHref="/dashboard/o1/setup" restaurants={[{ orgId: 'o2', orgName: 'Smash' }]}
        onNavigate={calls.navigate} onLanguage={calls.language} onSignOut={calls.signOut} />
    )), locale);
    return { v, calls };
  };

  it('opening the profile does not sign out; the menu lists security, language, guest site, setup, restaurants and sign out', async () => {
    const { v, calls } = setup();
    await flush();
    const trigger = $(v.host, 'button.ws-profile');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    click(trigger);
    expect(calls.signOut).not.toHaveBeenCalled();
    const items = $$(v.host, '[role="menuitem"]').map((i) => i.textContent);
    expect(items).toEqual(['Account security', expect.stringContaining('العربية'), expect.stringContaining('Open guest experience'),
      'Setup guide', 'Open Smash', 'Sign out']);
    click($$(v.host, '[role="menuitem"]').at(-1)!);
    expect(calls.signOut).toHaveBeenCalledTimes(1);
    v.unmount();
  });

  it('navigates to account security and switches language from the menu, by keyboard too', async () => {
    const { v, calls } = setup();
    await flush();
    const trigger = $(v.host, 'button.ws-profile');
    key(trigger, 'ArrowDown');
    const items = $$(v.host, '[role="menuitem"]');
    expect(document.activeElement).toBe(items[0]);
    key(items[0]!, 'Enter');
    click(items[0]!);
    expect(calls.navigate).toHaveBeenCalledWith('/account/security');
    key(trigger, 'ArrowDown');
    click($$(v.host, '[role="menuitem"]')[1]!);
    expect(calls.language).toHaveBeenCalledTimes(1);
    v.unmount();
  });

  it('a click before the menu code has loaded still opens the menu', async () => {
    const { v } = setup();
    // No flush: the first render may still be the plain trigger.
    click($(v.host, 'button.ws-profile'));
    await flush();
    expect($$(v.host, '[role="menuitem"]').length).toBeGreaterThan(0);
    v.unmount();
  });

  it('is localised in Arabic with Western digits', async () => {
    const { v } = setup('ar');
    await flush();
    click($(v.host, 'button.ws-profile'));
    const text = v.host.textContent ?? '';
    expect(text).toContain('أمان الحساب');
    expect(text).toContain('تسجيل الخروج');
    expect(text).not.toMatch(EASTERN_DIGITS);
    v.unmount();
  });
});

describe('branch switcher and the one branch context', () => {
  function Probe({ allowAll }: { allowAll?: boolean }) {
    const { branchId, allBranches } = useBranchScope({ allowAll });
    return <output data-branch={branchId} data-all={String(allBranches)} />;
  }
  const shell = (state: { branchId: string; all: boolean; allowAll: boolean }, onChoose: (id: string | null) => void, locale: 'en' | 'ar' = 'en', register = () => () => {}) => inLocale(locale, (
    <OrgProvider value={{ org: org(), modules: null, reload: async () => {}, branchId: state.branchId, allBranches: state.all, setBranchId: onChoose, registerAllBranches: register }}>
      <BranchSwitcher org={org()} branchId={state.branchId} allBranches={state.all} allowAll={state.allowAll} onChoose={onChoose} />
      <Probe allowAll={state.allowAll} />
    </OrgProvider>
  ));

  it('offers "All branches" only while a screen that supports it is open, and marks the current choice', async () => {
    const choose = vi.fn();
    const v = mount(shell({ branchId: 'b1', all: true, allowAll: true }, choose));
    await flush();
    expect($(v.host, '.ws-chip small').textContent).toBe('All branches');
    click($(v.host, 'button.ws-chip'));
    const items = $$(v.host, '[role="menuitem"]');
    const labels = () => $$(v.host, '[role="menuitem"] .rui-menu-label').map((i) => i.textContent?.replace(/ · current$/, ''));
    expect(labels()).toEqual(['All branches', 'Zamalek', 'Maadi']);
    expect(items[0]!.textContent).toContain('current');
    click(items[2]!);
    expect(choose).toHaveBeenCalledWith('b2');
    // The screen reads '' (all branches) from the shell.
    expect($(v.host, 'output').dataset.branch).toBe('');
    v.rerender(shell({ branchId: 'b1', all: true, allowAll: false }, choose));
    await flush();
    // A screen without "all": the last single branch, and no "All branches" choice.
    expect($(v.host, '.ws-chip small').textContent).toBe('Zamalek');
    expect($(v.host, 'output').dataset.branch).toBe('b1');
    click($(v.host, 'button.ws-chip'));
    expect(labels()).toEqual(['Zamalek', 'Maadi']);
    v.unmount();
  });

  it('screens that support all branches register themselves with the shell', async () => {
    const unregister = vi.fn();
    const register = vi.fn(() => unregister);
    const v = mount(shell({ branchId: 'b1', all: false, allowAll: true }, () => {}, 'en', register));
    await flush();
    expect(register).toHaveBeenCalled();
    v.unmount();
    expect(unregister).toHaveBeenCalled();
  });

  it('shows Arabic branch names in an Arabic page', async () => {
    const v = mount(shell({ branchId: 'b2', all: false, allowAll: true }, () => {}, 'ar'), 'ar');
    await flush();
    expect($(v.host, '.ws-chip small').textContent).toBe('المعادي');
    expect($(v.host, '.ws-chip strong').textContent).toBe('غرفة الزيتون');
    v.unmount();
  });
});

describe('command palette', () => {
  const areas: NavArea[] = [
    { key: 'operations', label: 'nav.area.operations', icon: 'operations', items: [{ href: '/orders', label: 'nav.orders', module: 'core' }, { href: '/kitchen', label: 'nav.kitchen', module: 'core' }] },
    { key: 'insights', label: 'nav.area.insights', icon: 'insights', items: [{ href: '/analytics', label: 'nav.analytics', module: 'core' }] },
  ];
  const open = (locale: 'en' | 'ar', search = vi.fn(async () => ({ items: [] as never[] })), calls = { navigate: vi.fn(), branch: vi.fn(), signOut: vi.fn(), language: vi.fn() }) => {
    const v = mount(inLocale(locale, (
      <CommandPalette open onClose={() => {}} org={org()} role="owner" areas={areas} explore={false} branchId="b1" allowAll={false} allBranches={false}
        onBranch={calls.branch} onNavigate={calls.navigate} onLanguage={calls.language} onSignOut={calls.signOut} search={search} />
    )), locale);
    return { v, search, calls };
  };

  it('filters pages as you type and opens the active one with Enter (keyboard only)', async () => {
    const { v, calls } = open('en');
    const input = $<HTMLInputElement>(v.host, 'input[role="combobox"]');
    type(input, 'kitch');
    const options = $$(v.host, '[role="option"]');
    expect(options[0]!.textContent).toContain('Kitchen');
    expect(options[0]!.getAttribute('aria-selected')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0]!.id);
    key(input, 'Enter');
    expect(calls.navigate).toHaveBeenCalledWith('/dashboard/o1/kitchen');
    v.unmount();
  });

  it('moves with the arrow keys and runs actions (sign out, switch branch)', async () => {
    const { v, calls } = open('en');
    const input = $<HTMLInputElement>(v.host, 'input[role="combobox"]');
    type(input, 'sign out');
    key(input, 'Enter');
    expect(calls.signOut).toHaveBeenCalled();
    type(input, 'switch branch');
    key(input, 'Enter');
    expect($$(v.host, '[role="option"]').map((o) => o.textContent)).toEqual(['Zamalek', 'Maadi']);
    key(input, 'ArrowDown');
    key(input, 'Enter');
    expect(calls.branch).toHaveBeenCalledWith('b2');
    v.unmount();
  });

  it('searches records through the API (debounced, branch-scoped) and opens a result', async () => {
    vi.useFakeTimers();
    const search = vi.fn(async (_path: string) => ({ items: [{ type: 'customer', id: 'c1', displayName: 'Mona Adel', phone: '+201001111111' }] as never[] }));
    const { v, calls } = open('en', search);
    const input = $<HTMLInputElement>(v.host, 'input[role="combobox"]');
    type(input, 'mona');
    expect(search).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(250); });
    vi.useRealTimers();
    await flush();
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]![0]).toBe('/o/o1/search?q=mona&branchId=b1');
    const option = $$(v.host, '[role="option"]').find((o) => o.textContent?.includes('Mona Adel'))!;
    click(option);
    expect(calls.navigate).toHaveBeenCalledWith('/dashboard/o1/customers/c1');
    v.unmount();
  });

  it('works in Arabic', async () => {
    const { v, calls } = open('ar');
    const input = $<HTMLInputElement>(v.host, 'input[role="combobox"]');
    expect(input.getAttribute('aria-label')).toBe('لوحة الأوامر');
    type(input, 'التحليلات');
    key(input, 'Enter');
    expect(calls.navigate).toHaveBeenCalledWith('/dashboard/o1/analytics');
    expect(v.host.textContent ?? '').not.toMatch(EASTERN_DIGITS);
    v.unmount();
  });
});
