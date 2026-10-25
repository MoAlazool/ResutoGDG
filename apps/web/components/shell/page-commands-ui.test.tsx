// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { $, $$, key, mount, type } from '../../../../packages/ui/test/dom';
import { LocaleProvider } from '@/lib/i18n/client';
import { messagesFor } from '@/lib/i18n/messages';
import type { OrgInfo } from '@/lib/org-context';
import { pageCommands, setPageCommands } from '@/lib/page-commands';
import CommandPalette, { ShortcutsSheet } from './CommandPalette';

// 21-INBOX: page commands (lib/page-commands.ts) appear in the ⌘K palette as actions of the open page and in the ?
// cheat sheet with their keys, and they leave both when the page goes away.

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), usePathname: () => '/dashboard/o1/inbox', useRouter: () => ({ push() {} }) }));

const inLocale = (locale: 'en' | 'ar', node: ReactNode) => (
  <LocaleProvider locale={locale} messages={{ ...messagesFor(locale, 'guest'), ...messagesFor(locale, 'staff') }}>{node}</LocaleProvider>
);
const org: OrgInfo = {
  id: 'o1', slug: 'olive', name: 'The Olive Room', nameAr: null, country: 'EG', currency: 'EGP', timezone: 'Africa/Cairo', role: 'owner', status: 'active',
  branches: [{ id: 'b1', name: 'Zamalek', nameAr: null, code: 'main', isActive: true }],
};
let remove: (() => void) | null = null;
afterEach(() => { remove?.(); remove = null; document.body.innerHTML = ''; vi.useRealTimers(); });

const register = (run = vi.fn()) => {
  remove = setPageCommands({ title: 'Inbox', commands: [
    { id: 'next', key: 'j', label: 'Next conversation', keywords: 'next down', run },
    { id: 'assign', key: 'a', label: 'Assign', enabled: false, run },
  ] });
  return run;
};

describe('page commands in the palette and the cheat sheet', () => {
  it('the palette lists the page\'s enabled commands first and runs one with Enter', async () => {
    vi.useFakeTimers();
    const run = register();
    const onClose = vi.fn();
    const v = mount(inLocale('en', (
      <CommandPalette open onClose={onClose} org={org} role="owner" areas={[]} explore={false} branchId="b1" allowAll={false} allBranches={false}
        onBranch={() => {}} onNavigate={() => {}} onLanguage={() => {}} onSignOut={() => {}} search={async () => ({ items: [] })} />
    )));
    expect(v.host.textContent).toContain('On this page: Inbox');
    const options = $$(v.host, '[role="option"]');
    expect(options[0]!.textContent).toContain('Next conversation');
    expect(options.some((o) => o.textContent?.includes('Assign'))).toBe(false);
    const input = $<HTMLInputElement>(v.host, 'input[role="combobox"]');
    type(input, 'next');
    key(input, 'Enter');
    expect(onClose).toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(50); });
    expect(run).toHaveBeenCalledTimes(1);
    v.unmount();
  });

  it('the cheat sheet lists the page\'s keys, in Arabic too, and drops them when the page goes away', () => {
    register();
    const v = mount(inLocale('ar', <ShortcutsSheet open onClose={() => {}} visibleHrefs={new Set()} />), 'ar');
    expect(v.host.textContent).toContain('في هذه الصفحة: Inbox');
    expect($$(v.host, 'kbd').map((k) => k.textContent)).toEqual(expect.arrayContaining(['j', 'a']));
    act(() => { remove!(); remove = null; });
    expect(pageCommands()).toBeNull();
    expect(v.host.textContent).not.toContain('Inbox');
    expect($(v.host, 'dialog')).toBeTruthy();
    v.unmount();
  });
});
