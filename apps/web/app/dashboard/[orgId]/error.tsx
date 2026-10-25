'use client';
import { AreaError } from '@/components/shell/AreaError';

/** A screen failed to render: the shell and its navigation stay usable; Try again re-renders the screen. */
export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <AreaError error={error} reset={reset} area="home" />;
}
