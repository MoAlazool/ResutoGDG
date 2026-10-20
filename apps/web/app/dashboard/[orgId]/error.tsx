'use client';
import { ErrorView } from '@/components/shell/ErrorView';

/** A screen failed to render: the shell and its navigation stay usable; Try again re-renders the screen. */
export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorView error={error} reset={reset} variant="inline" homeHref="/dashboard" />;
}
