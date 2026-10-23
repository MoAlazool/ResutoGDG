'use client';
import { ErrorView } from '@/components/shell/ErrorView';

/** Branded, localised error state for the counter area (retry re-renders; chunk load failures reload once). */
export default function CounterAreaError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorView error={error} reset={reset} />;
}
