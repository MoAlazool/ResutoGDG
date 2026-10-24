'use client';
import { AreaError } from '@/components/shell/AreaError';

/** Money area (finance): the screen failed to render; the shell and its navigation stay usable (21-SHELL). */
export default function FinanceError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <AreaError error={error} reset={reset} area="money" />;
}
