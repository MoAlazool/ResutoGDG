'use client';
import { AreaError } from '@/components/shell/AreaError';

/** Operator console (Operations): the screen failed to render; the console shell and its navigation stay usable (21-ADMIN). */
export default function OperationsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <AreaError error={error} reset={reset} area="admin" homeHref="/admin" />;
}
