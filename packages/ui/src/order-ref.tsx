import { toWesternDigits } from '@resuto/contracts';

/**
 * An order, revision or attempt reference ("#" + number) as one left-to-right unit. Written as "#<bdi>{n}</bdi>" in an
 * Arabic line, the bidi algorithm moves the "#" to the other side of the number (gallery PAR-06). Western digits always.
 * Its own module (not display.tsx) so a screen that only needs the reference does not ship the whole display kit
 * (bundle budget: the live floor's visits list).
 */
export function OrderRef({ n, className }: { n: string | number | null | undefined; className?: string }) {
  if (n === null || n === undefined || n === '') return null;
  return <bdi dir="ltr" className={['num', className].filter(Boolean).join(' ')}>#{toWesternDigits(String(n))}</bdi>;
}
