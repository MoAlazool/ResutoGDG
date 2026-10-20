'use client';
import { ErrorView } from '@/components/shell/ErrorView';

/** Branded, localised error state for the driver area (retry re-renders; chunk load failures reload once). */
export default function AreaError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorView error={error} reset={reset} variant="inline" homeHref="/driver" />;
}
