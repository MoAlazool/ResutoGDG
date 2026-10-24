'use client';
import { AreaError } from '@/components/shell/AreaError';

/** Operations area (kitchen): the screen failed to render; the shell and its navigation stay usable (21-SHELL). */
export default function KitchenError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <AreaError error={error} reset={reset} area="operations" />;
}
