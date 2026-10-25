'use client';
import type { FunnelSurface } from '@resuto/contracts/lite';
import { useFunnel } from '@/lib/funnel-beacon';

/** A server-rendered guest page's funnel page view (21-CRM, lib/funnel-beacon.ts). Renders nothing. */
export function FunnelView({ surface, slug, branchId }: { surface: FunnelSurface; slug: string; branchId?: string | null }) {
  useFunnel(surface, slug, { branchId });
  return null;
}
