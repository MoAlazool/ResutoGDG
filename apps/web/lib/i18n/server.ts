import { cookies, headers } from 'next/headers';
import { LOCALE_COOKIE, type Locale } from './locale';
import { translate } from './messages';

export async function getLocale(): Promise<Locale> {
  const c = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (c === 'ar' || c === 'en') return c;
  const accept = (await headers()).get('accept-language') ?? '';
  return accept.toLowerCase().startsWith('ar') ? 'ar' : 'en';
}

export async function getT() {
  const locale = await getLocale();
  return { locale, t: (key: string, vars?: Record<string, string | number>) => translate(locale, key, vars) };
}
