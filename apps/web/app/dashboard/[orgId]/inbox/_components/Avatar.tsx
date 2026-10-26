import { ProviderLogo } from '@resuto/ui';
import { providerOf } from './types';

/** Up to two initials of a name, in its own script ("Mona Adel" → "MA", "منى عادل" → "مع"); "#" for a bare number. */
export function initialsOf(name: string): string {
  const words = name.replace(/\(.*?\)/g, ' ').trim().split(/\s+/).filter((w) => /[\p{L}]/u.test(w));
  if (!words.length) return '#';
  const first = (w: string) => Array.from(w.replace(/^[^\p{L}]+/u, ''))[0] ?? '';
  return (first(words[0]!) + (words.length > 1 ? first(words[words.length - 1]!) : '')).toLocaleUpperCase();
}

/** A stable tint per name (six token pairs), so the same customer keeps the same colour in the list and the thread. */
export function tintOf(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h % 6;
}

/**
 * The contact's initials with the channel's logo on the corner (WhatsApp, Messenger, Instagram). The logo carries the
 * channel's name for assistive technology (unless `decorative`: the name is printed beside it); the initials are decoration.
 */
export function Avatar({ name, kind, channelName, size = 'md', decorative }: { name: string; kind?: string; channelName: string; size?: 'md' | 'lg'; decorative?: boolean }) {
  return (
    <span className="inbox-avatar" data-tint={tintOf(name)} data-size={size}>
      <span aria-hidden="true">{initialsOf(name)}</span>
      <span className="inbox-avatar-channel"><ProviderLogo provider={providerOf(kind)} size={size === 'lg' ? 16 : 14} alt={channelName} decorative={decorative} /></span>
    </span>
  );
}
