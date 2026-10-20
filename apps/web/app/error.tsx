'use client';
import { ErrorView } from '@/components/shell/ErrorView';

/** Branded, localised error page for any route without a closer error boundary. */
export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorView error={error} reset={reset} />;
}
